from __future__ import annotations

from pathlib import Path

import netCDF4
import numpy as np
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


def create_dataset(path: Path, *, size: int = 8) -> bytes:
    with netCDF4.Dataset(path, "w", format="NETCDF4") as dataset:
        if size == 8:
            dataset.createDimension("y", 2)
            dataset.createDimension("x", 4)
            infilt = dataset.createVariable("infilt", "f4", ("y", "x"), fill_value=-999.0)
            infilt.units = "mm"
            infilt.long_name = "infiltration parameter"
            infilt.source_path = "/private/server/location/file.nc"
            infilt.access_token = "do-not-return"
            infilt[:] = np.array([[1.0, 2.0, np.nan, np.inf], [4.0, 5.0, -999.0, -999.0]], dtype=np.float32)
            category = dataset.createVariable("land_class", str, ("y", "x"))
            category[:] = np.array([["a", "b", "a", "c"], ["c", "b", "a", "c"]], dtype=object)
        else:
            # Define a large sparse variable without writing its backing array.
            dataset.createDimension("large_x", size)
            dataset.createVariable("large_grid", "i4", ("large_x",))
    return path.read_bytes()


def upload_netcdf(client: TestClient, project_id: str, job_id: str, filename: str, content: bytes):
    return client.post(
        f"/api/projects/{project_id}/jobs/{job_id}/netcdf-uploads",
        files={"file": (filename, content, "application/octet-stream")},
    )


def test_netcdf_upload_inspection_summarizes_variables_and_preserves_source(
    client: TestClient,
    project_and_job: tuple[str, str],
    tmp_path: Path,
) -> None:
    project_id, job_id = project_and_job
    source = create_dataset(tmp_path / "vic_soil_param.nc")
    uploaded = upload_netcdf(client, project_id, job_id, "vic_soil_param.nc", source)
    assert uploaded.status_code == 201, uploaded.text

    inspected = client.get(
        f"/api/projects/{project_id}/jobs/{job_id}/uploads/{uploaded.json()['id']}/inspection"
    )
    assert inspected.status_code == 200, inspected.text
    response = inspected.json()
    assert response["detected_format"] == "vic_netcdf"
    assert response["parse_status"] == "parsed"
    assert response["editable_fields"] == []
    representation = response["representation"]
    assert representation["kind"] == "netcdf_dataset"
    assert representation["dimensions"] == [{"name": "y", "size": 2}, {"name": "x", "size": 4}]
    variables = {variable["name"]: variable for variable in representation["variables"]}
    assert variables["infilt"]["dimensions"] == ["y", "x"]
    assert variables["infilt"]["shape"] == [2, 4]
    assert variables["infilt"]["data_type"] == "float32"
    assert variables["infilt"]["units"] == "mm"
    assert variables["infilt"]["numeric_summary"] == {
        "finite_count": 4,
        "missing_count": 4,
        "minimum": 1.0,
        "maximum": 5.0,
        "median": 3.0,
    }
    assert variables["infilt"]["attributes"]["source_path"] == "[omitted]"
    assert "access_token" not in variables["infilt"]["attributes"]
    assert "/private/server/location/file.nc" not in inspected.text
    assert "do-not-return" not in inspected.text
    assert variables["land_class"]["classification"] == "categorical"
    assert variables["land_class"]["numeric_summary"] is None

    stored = list(client.app.state.settings.upload_dir.iterdir())
    assert len(stored) == 1
    assert stored[0].read_bytes() == source


def test_malformed_netcdf_is_rejected_without_upload_record_or_file(
    client: TestClient,
    project_and_job: tuple[str, str],
) -> None:
    project_id, job_id = project_and_job
    response = upload_netcdf(client, project_id, job_id, "vic_soil_param.nc", b"not a netcdf file")
    assert response.status_code == 422
    assert client.get(f"/api/projects/{project_id}/jobs/{job_id}/uploads").json() == []
    assert list(client.app.state.settings.upload_dir.iterdir()) == []


def test_netcdf_upload_accepts_general_netcdf_names_and_rejects_non_netcdf_extension(
    client: TestClient,
    project_and_job: tuple[str, str],
) -> None:
    project_id, job_id = project_and_job
    generic = create_dataset(Path(client.app.state.settings.upload_dir).parent / "generic.nc")
    assert upload_netcdf(client, project_id, job_id, "other.nc", generic).status_code == 201
    assert upload_netcdf(client, project_id, job_id, "not-netcdf.txt", b"anything").status_code == 415
    text_upload = client.post(
        f"/api/projects/{project_id}/jobs/{job_id}/uploads",
        files={"file": ("vic_soil_param.txt", b"text data", "text/plain")},
    )
    assert text_upload.status_code == 201


def test_netcdf_oversize_is_rejected_by_configured_limit(
    tmp_path: Path,
) -> None:
    settings = Settings(
        database_url=f"sqlite:///{(tmp_path / 'limited.sqlite3').as_posix()}",
        upload_dir=tmp_path / "limited_uploads",
        max_upload_size_bytes=64,
        max_netcdf_upload_size_bytes=8,
    )
    with TestClient(create_app(settings)) as client:
        project = client.post("/api/projects", json={"name": "Project"}).json()
        job = client.post(f"/api/projects/{project['id']}/jobs", json={"name": "Job"}).json()
        response = upload_netcdf(client, project["id"], job["id"], "vic_soil_param.nc", b"x" * 9)
    assert response.status_code == 413


def test_netcdf_inspection_is_job_scoped_and_large_variable_summary_is_bounded(
    client: TestClient,
    project_and_job: tuple[str, str],
    tmp_path: Path,
) -> None:
    project_id, job_id = project_and_job
    source = create_dataset(tmp_path / "vic_domain.nc", size=100_001)
    uploaded = upload_netcdf(client, project_id, job_id, "vic_domain.nc", source)
    assert uploaded.status_code == 201, uploaded.text
    upload_id = uploaded.json()["id"]

    other_job = client.post(f"/api/projects/{project_id}/jobs", json={"name": "Other job"}).json()
    not_found = client.get(
        f"/api/projects/{project_id}/jobs/{other_job['id']}/uploads/{upload_id}/inspection"
    )
    assert not_found.status_code == 404

    inspected = client.get(f"/api/projects/{project_id}/jobs/{job_id}/uploads/{upload_id}/inspection")
    assert inspected.status_code == 200
    representation = inspected.json()["representation"]
    variable = next(item for item in representation["variables"] if item["name"] == "large_grid")
    assert variable["summary_status"] == "limit_reached"
    assert variable["numeric_summary"] is None
    assert len(inspected.content) < 50_000


def test_deleting_netcdf_upload_preserves_unrelated_tab2_upload(
    client: TestClient,
    project_and_job: tuple[str, str],
    backend_settings: Settings,
    tmp_path: Path,
) -> None:
    project_id, job_id = project_and_job
    netcdf_bytes = create_dataset(tmp_path / "vic_soil_param.nc")
    netcdf_upload = upload_netcdf(client, project_id, job_id, "vic_soil_param.nc", netcdf_bytes).json()
    yaml_bytes = b"GLOBAL:\n  region_name: Test\n"
    yaml_response = client.post(
        f"/api/projects/{project_id}/jobs/{job_id}/uploads",
        files={"file": ("rat_config.yaml", yaml_bytes, "application/yaml")},
    )
    assert yaml_response.status_code == 201, yaml_response.text
    yaml_upload = yaml_response.json()

    physical_files = list(backend_settings.upload_dir.iterdir())
    netcdf_path = next(path for path in physical_files if path.read_bytes() == netcdf_bytes)
    yaml_path = next(path for path in physical_files if path.read_bytes() == yaml_bytes)

    deleted = client.delete(
        f"/api/projects/{project_id}/jobs/{job_id}/uploads/{netcdf_upload['id']}"
    )

    assert deleted.status_code == 204
    assert not netcdf_path.exists()
    assert yaml_path.read_bytes() == yaml_bytes
    remaining = client.get(f"/api/projects/{project_id}/jobs/{job_id}/uploads").json()
    assert [upload["id"] for upload in remaining] == [yaml_upload["id"]]


def test_upload_collections_are_assigned_by_endpoint_and_isolated(
    client: TestClient,
    project_and_job: tuple[str, str],
    tmp_path: Path,
) -> None:
    project_id, job_id = project_and_job
    netcdf_bytes = create_dataset(tmp_path / "vic_soil_param.nc")
    netcdf_upload = upload_netcdf(client, project_id, job_id, "vic_soil_param.nc", netcdf_bytes).json()
    yaml_bytes = b"GLOBAL:\n  region_name: Test\n"
    yaml_upload = client.post(
        f"/api/projects/{project_id}/jobs/{job_id}/uploads",
        files={"file": ("rat_config.yaml", yaml_bytes, "application/yaml")},
    ).json()

    root = f"/api/projects/{project_id}/jobs/{job_id}/uploads"
    configuration = client.get(root, params={"category": "configuration_input"})
    netcdf = client.get(root, params={"category": "netcdf_parameter_dataset"})
    assert [upload["id"] for upload in configuration.json()] == [yaml_upload["id"]]
    assert [upload["id"] for upload in netcdf.json()] == [netcdf_upload["id"]]
    assert yaml_upload["upload_category"] == "configuration_input"
    assert netcdf_upload["upload_category"] == "netcdf_parameter_dataset"

    cross_inspection = client.get(f"{root}/{yaml_upload['id']}/inspection", params={"category": "netcdf_parameter_dataset"})
    cross_deletion = client.delete(root + f"/{netcdf_upload['id']}", params={"category": "configuration_input"})
    assert cross_inspection.status_code == 404
    assert cross_deletion.status_code == 404
    assert len(client.get(root, params={"category": "configuration_input"}).json()) == 1
    assert len(client.get(root, params={"category": "netcdf_parameter_dataset"}).json()) == 1

    stored_bytes = [path.read_bytes() for path in client.app.state.settings.upload_dir.iterdir()]
    assert netcdf_bytes in stored_bytes
    assert yaml_bytes in stored_bytes
