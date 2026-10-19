from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


def test_health(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_project_and_job_crud(client: TestClient) -> None:
    created_project = client.post("/api/projects", json={"name": "  Narmada  ", "description": "Calibration"})
    assert created_project.status_code == 201
    project = created_project.json()
    assert project["name"] == "Narmada"
    assert client.get("/api/projects").json()[0]["id"] == project["id"]
    assert client.get(f"/api/projects/{project['id']}").json()["description"] == "Calibration"

    created_job = client.post(
        f"/api/projects/{project['id']}/jobs",
        json={"name": "  Baseline  ", "description": "First run setup"},
    )
    assert created_job.status_code == 201
    job = created_job.json()
    assert job["name"] == "Baseline"
    assert job["project_id"] == project["id"]
    assert client.get(f"/api/projects/{project['id']}/jobs").json()[0]["id"] == job["id"]
    assert client.get(f"/api/projects/{project['id']}/jobs/{job['id']}").json()["id"] == job["id"]


def test_missing_project_and_job_return_404(client: TestClient) -> None:
    missing_id = "missing-project"
    assert client.get(f"/api/projects/{missing_id}").status_code == 404
    assert client.get(f"/api/projects/{missing_id}/jobs").status_code == 404
    assert client.post(f"/api/projects/{missing_id}/jobs", json={"name": "Job"}).status_code == 404
    assert client.get(f"/api/projects/{missing_id}/jobs/missing-job").status_code == 404


def test_project_job_relationship_is_enforced(client: TestClient, project_and_job: tuple[str, str]) -> None:
    project_id, job_id = project_and_job
    other_project = client.post("/api/projects", json={"name": "Other basin"}).json()
    other_id = other_project["id"]

    assert client.get(f"/api/projects/{other_id}/jobs/{job_id}").status_code == 404
    assert client.get(f"/api/projects/{other_id}/jobs/{job_id}/uploads").status_code == 404
    assert client.post(
        f"/api/projects/{other_id}/jobs/{job_id}/uploads",
        files={"file": ("input.csv", b"a,b\n1,2", "text/csv")},
    ).status_code == 404
    assert client.get(f"/api/projects/{project_id}/jobs/{job_id}").status_code == 200


def test_upload_and_list_metadata_without_storage_path(
    client: TestClient,
    project_and_job: tuple[str, str],
    backend_settings: Settings,
) -> None:
    project_id, job_id = project_and_job
    response = client.post(
        f"/api/projects/{project_id}/jobs/{job_id}/uploads",
        files={"file": ("forcing.csv", b"date,value\n2020-01-01,2", "text/csv")},
    )
    assert response.status_code == 201
    metadata = response.json()
    assert metadata["original_filename"] == "forcing.csv"
    assert metadata["file_size"] == len(b"date,value\n2020-01-01,2")
    assert "storage_filename" not in metadata
    assert "path" not in metadata

    uploads = client.get(f"/api/projects/{project_id}/jobs/{job_id}/uploads").json()
    assert len(uploads) == 1
    assert uploads[0]["id"] == metadata["id"]
    stored_files = list(backend_settings.upload_dir.iterdir())
    assert len(stored_files) == 1
    assert stored_files[0].read_bytes() == b"date,value\n2020-01-01,2"
    assert stored_files[0].name != "forcing.csv"


def test_reject_empty_upload(client: TestClient, project_and_job: tuple[str, str]) -> None:
    project_id, job_id = project_and_job
    response = client.post(
        f"/api/projects/{project_id}/jobs/{job_id}/uploads",
        files={"file": ("empty.yaml", b"", "application/yaml")},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "Empty files are not accepted."
    assert client.get(f"/api/projects/{project_id}/jobs/{job_id}/uploads").json() == []


def test_reject_unsupported_file_type(client: TestClient, project_and_job: tuple[str, str]) -> None:
    project_id, job_id = project_and_job
    response = client.post(
        f"/api/projects/{project_id}/jobs/{job_id}/uploads",
        files={"file": ("script.exe", b"not allowed", "application/octet-stream")},
    )
    assert response.status_code == 415
    assert client.get(f"/api/projects/{project_id}/jobs/{job_id}/uploads").json() == []


def test_reject_upload_over_configured_size(client: TestClient, project_and_job: tuple[str, str], backend_settings: Settings) -> None:
    project_id, job_id = project_and_job
    response = client.post(
        f"/api/projects/{project_id}/jobs/{job_id}/uploads",
        files={"file": ("large.txt", b"x" * (backend_settings.max_upload_size_bytes + 1), "text/plain")},
    )
    assert response.status_code == 413
    assert response.json()["detail"] == "The file exceeds the configured size limit."
    assert client.get(f"/api/projects/{project_id}/jobs/{job_id}/uploads").json() == []
    assert list(backend_settings.upload_dir.iterdir()) == []


def test_upload_storage_name_is_independent_of_client_path(
    client: TestClient,
    project_and_job: tuple[str, str],
    backend_settings: Settings,
) -> None:
    project_id, job_id = project_and_job
    response = client.post(
        f"/api/projects/{project_id}/jobs/{job_id}/uploads",
        files={"file": ("../../forcing.yaml", b"safe: true\n", "application/yaml")},
    )
    assert response.status_code == 201
    assert response.json()["original_filename"] == "forcing.yaml"
    assert len(list(backend_settings.upload_dir.iterdir())) == 1
    assert not (backend_settings.upload_dir.parent / "forcing.yaml").exists()


def test_upload_lists_are_isolated_by_job(client: TestClient, project_and_job: tuple[str, str]) -> None:
    project_id, first_job_id = project_and_job
    second_job = client.post(f"/api/projects/{project_id}/jobs", json={"name": "Second job"}).json()
    response = client.post(
        f"/api/projects/{project_id}/jobs/{first_job_id}/uploads",
        files={"file": ("parameters.txt", b"alpha=1", "text/plain")},
    )
    assert response.status_code == 201
    assert len(client.get(f"/api/projects/{project_id}/jobs/{first_job_id}/uploads").json()) == 1
    assert client.get(f"/api/projects/{project_id}/jobs/{second_job['id']}/uploads").json() == []


def test_records_and_uploads_survive_new_app_instance(
    tmp_path,
    backend_settings: Settings,
) -> None:
    first_app = create_app(backend_settings)
    with TestClient(first_app) as first_client:
        project = first_client.post("/api/projects", json={"name": "Persistent"}).json()
        job = first_client.post(
            f"/api/projects/{project['id']}/jobs",
            json={"name": "Persistent job"},
        ).json()
        upload_response = first_client.post(
            f"/api/projects/{project['id']}/jobs/{job['id']}/uploads",
            files={"file": ("config.yaml", b"model: vic", "application/yaml")},
        )
        assert upload_response.status_code == 201

    second_app = create_app(backend_settings)
    with TestClient(second_app) as second_client:
        assert second_client.get(f"/api/projects/{project['id']}").status_code == 200
        assert second_client.get(f"/api/projects/{project['id']}/jobs/{job['id']}").status_code == 200
        assert len(second_client.get(f"/api/projects/{project['id']}/jobs/{job['id']}/uploads").json()) == 1

    assert len(list(backend_settings.upload_dir.iterdir())) == 1
