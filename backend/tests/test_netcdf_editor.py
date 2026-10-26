from pathlib import Path

import netCDF4
import numpy as np
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from app.models import Upload


def fixture_bytes(path: Path) -> bytes:
    with netCDF4.Dataset(path, "w", format="NETCDF4") as dataset:
        dataset.createDimension("row", 2)
        dataset.createDimension("col", 3)
        dataset.createDimension("band", 2)
        dataset.createDimension("nlayer", 3)
        dataset.createDimension("large", 1201)
        dataset.title = "synthetic test"
        row = dataset.createVariable("row", "i4", ("row",))
        row[:] = [10, 20]
        values = dataset.createVariable("field", "f4", ("row", "col"), fill_value=-999.0, zlib=True)
        values.units = "arbitrary units"
        values[:] = np.array([[1, 2, -999], [4, 5, 6]], dtype=np.float32)
        cube = dataset.createVariable("cube", "i2", ("band", "row", "col"))
        cube[:] = np.arange(12, dtype=np.int16).reshape(2, 2, 3)
        layer = dataset.createVariable("layer", "i4", ("nlayer",))
        layer[:] = [1, 2, 3]
        elev = dataset.createVariable("elev", "f8", ("row", "col"))
        elev[:] = np.array([[0.41, 1.25, 2.5], [5.75, 8.0, 10.5]], dtype=np.float64)
        soil_density = dataset.createVariable("soil_density", "f8", ("nlayer", "row", "col"))
        soil_density[:] = 2685.0
        dataset.createVariable("large_values", "i4", ("large",))
        scalar = dataset.createVariable("scalar", "i2")
        scalar.assignValue(7)
    return path.read_bytes()


def upload(client: TestClient, project_id: str, job_id: str, content: bytes) -> dict:
    response = client.post(f"/api/projects/{project_id}/jobs/{job_id}/netcdf-uploads", files={"file": ("test.nc", content)})
    assert response.status_code == 201, response.text
    return response.json()


def test_values_edit_save_verify_download_and_reinspect(tmp_path: Path) -> None:
    settings = Settings(database_url=f"sqlite:///{(tmp_path / 'editor.sqlite3').as_posix()}", upload_dir=tmp_path / "uploads", max_upload_size_bytes=2_000_000, max_netcdf_upload_size_bytes=2_000_000)
    with TestClient(create_app(settings)) as client:
        project = client.post("/api/projects", json={"name": "Test"}).json()
        job = client.post(f"/api/projects/{project['id']}/jobs", json={"name": "Job"}).json()
        original = fixture_bytes(tmp_path / "source.nc")
        source = upload(client, project["id"], job["id"], original)
        root = f"/api/projects/{project['id']}/jobs/{job['id']}/uploads/{source['id']}"
        view = client.post(root + "/netcdf-values", json={"variable": "field", "selectors": [None, None]})
        assert view.status_code == 200, view.text
        assert view.json()["indices"] == [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]]
        assert view.json()["values"][2] is None
        scalar = client.post(root + "/netcdf-values", json={"variable": "scalar", "selectors": []})
        assert scalar.status_code == 200 and scalar.json()["values"] == [7]
        layer_values = client.post(root + "/netcdf-values", json={"variable": "layer", "selectors": [None]}).json()
        assert layer_values["shape"] == [3] and layer_values["dimensions"] == ["nlayer"]
        assert layer_values["indices"] == [[0], [1], [2]] and layer_values["values"] == [1, 2, 3]
        elev_values = client.post(root + "/netcdf-values", json={"variable": "elev", "selectors": [None, None], "window_limits": [2, 3]}).json()
        assert elev_values["shape"] == [2, 3] and elev_values["dimensions"] == ["row", "col"]
        assert elev_values["indices"] == [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]]
        assert elev_values["values"] == [0.41, 1.25, 2.5, 5.75, 8.0, 10.5]
        soil_values = client.post(root + "/netcdf-values", json={"variable": "soil_density", "selectors": [0, None, None], "window_limits": [2, 3]}).json()
        assert soil_values["shape"] == [3, 2, 3] and soil_values["dimensions"] == ["nlayer", "row", "col"]
        assert all(index[0] == 0 for index in soil_values["indices"])
        assert soil_values["values"] == [2685.0] * 6
        row = client.post(root + "/netcdf-values", json={"variable": "field", "selectors": [1, None]}).json()
        assert row["indices"] == [[1, 0], [1, 1], [1, 2]]
        cube = client.post(root + "/netcdf-values", json={"variable": "cube", "selectors": [1, None, 1]}).json()
        assert cube["indices"] == [[1, 0, 1], [1, 1, 1]] and cube["values"] == [7, 10]
        cube_grid = client.post(root + "/netcdf-values", json={"variable": "cube", "selectors": [1, None, None], "window_starts": [0, 1], "window_limits": [2, 2]}).json()
        assert cube_grid["varying_dimensions"] == ["row", "col"]
        assert cube_grid["window_starts"] == [0, 1] and cube_grid["window_shape"] == [2, 2]
        assert cube_grid["indices"] == [[1, 0, 1], [1, 0, 2], [1, 1, 1], [1, 1, 2]]
        assert cube_grid["values"] == [7, 8, 10, 11]
        page_one = client.post(root + "/netcdf-values", json={"variable": "large_values", "selectors": [None]}).json()
        page_two = client.post(root + "/netcdf-values", json={"variable": "large_values", "selectors": [None], "start": 1000}).json()
        assert len(page_one["values"]) == 1000 and page_one["has_more"]
        assert page_two["indices"][0] == [1000] and len(page_two["values"]) == 201 and not page_two["has_more"]
        edits = [
            {"variable": "field", "indices": [1, 2], "value": 9.25},
            {"variable": "field", "indices": [0, 0], "value": 8.5},
            {"variable": "cube", "indices": [1, 1, 2], "value": 17},
        ]
        saved = client.post(root + "/netcdf-edits", json={"source_sha256": view.json()["source_sha256"], "edits": edits})
        assert saved.status_code == 201, saved.text
        artifact = saved.json()
        assert artifact["source_upload_id"] == source["id"]
        download = client.get(f"/api/projects/{project['id']}/jobs/{job['id']}/uploads/{artifact['id']}/download")
        assert download.status_code == 200
        assert download.content != original
        inspect = client.get(f"/api/projects/{project['id']}/jobs/{job['id']}/uploads/{artifact['id']}/inspection")
        assert inspect.status_code == 200
        values = client.post(f"/api/projects/{project['id']}/jobs/{job['id']}/uploads/{artifact['id']}/netcdf-values", json={"variable": "field", "selectors": [None, None]}).json()
        assert values["values"][-1] == 9.25 and values["values"][0] == 8.5
        cube_values = client.post(f"/api/projects/{project['id']}/jobs/{job['id']}/uploads/{artifact['id']}/netcdf-values", json={"variable": "cube", "selectors": [1, None, None], "window_starts": [0, 0], "window_limits": [2, 3]}).json()
        assert cube_values["values"][-1] == 17
        database = client.app.state.session_factory()
        try:
            source_record = database.get(Upload, source["id"])
            assert (settings.upload_dir / source_record.storage_filename).read_bytes() == original
        finally:
            database.close()
        assert inspect.json()["representation"]["attributes"]["title"] == "synthetic test"
        variables = {item["name"]: item for item in inspect.json()["representation"]["variables"]}
        assert variables["row"]["shape"] == [2]
        with netCDF4.Dataset(settings.upload_dir / client.app.state.session_factory().get(Upload, artifact["id"]).storage_filename) as edited_file:
            assert edited_file.variables["field"].filters()["zlib"] is True
        assert client.get(root + "/download").content == original


def test_netcdf_editor_rejects_stale_source_invalid_index_and_cross_job_access(client: TestClient, project_and_job: tuple[str, str], tmp_path: Path) -> None:
    project_id, job_id = project_and_job
    source = upload(client, project_id, job_id, fixture_bytes(tmp_path / "invalid.nc"))
    root = f"/api/projects/{project_id}/jobs/{job_id}/uploads/{source['id']}"
    values = client.post(root + "/netcdf-values", json={"variable": "field", "selectors": [None, None]}).json()
    bad_index = client.post(root + "/netcdf-edits", json={"source_sha256": values["source_sha256"], "edits": [{"variable": "field", "indices": [9, 0], "value": 1}]})
    assert bad_index.status_code == 422
    stale = client.post(root + "/netcdf-edits", json={"source_sha256": "0" * 64, "edits": [{"variable": "field", "indices": [0, 0], "value": 1}]})
    assert stale.status_code == 409
    other = client.post(f"/api/projects/{project_id}/jobs/other-job/uploads/{source['id']}/netcdf-values", json={"variable": "field", "selectors": [None, None]})
    assert other.status_code == 404
    oversized = client.post(root + "/netcdf-values", json={"variable": "cube", "selectors": [None, None, None]})
    assert oversized.status_code == 422
    oversized_window = client.post(root + "/netcdf-values", json={"variable": "field", "selectors": [None, None], "window_limits": [40, 40]})
    assert oversized_window.status_code == 422


def test_classic_netcdf_data_model_is_preserved(client: TestClient, project_and_job: tuple[str, str], tmp_path: Path) -> None:
    project_id, job_id = project_and_job
    path = tmp_path / "classic.nc"
    with netCDF4.Dataset(path, "w", format="NETCDF3_CLASSIC") as dataset:
        dataset.createDimension("x", 2)
        values = dataset.createVariable("values", "f4", ("x",))
        values[:] = [1, 2]
    source = upload(client, project_id, job_id, path.read_bytes())
    root = f"/api/projects/{project_id}/jobs/{job_id}/uploads/{source['id']}"
    view = client.post(root + "/netcdf-values", json={"variable": "values", "selectors": [None]}).json()
    response = client.post(root + "/netcdf-edits", json={"source_sha256": view["source_sha256"], "edits": [{"variable": "values", "indices": [1], "value": 3.5}]})
    assert response.status_code == 201, response.text
    artifact = client.app.state.session_factory().get(Upload, response.json()["id"])
    with netCDF4.Dataset(client.app.state.settings.upload_dir / artifact.storage_filename) as edited:
        assert edited.data_model == "NETCDF3_CLASSIC"
        assert edited.variables["values"][:].tolist() == [1.0, 3.5]
