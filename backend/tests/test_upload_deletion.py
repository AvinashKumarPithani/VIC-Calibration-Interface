from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.models import Upload


def create_upload(client: TestClient, project_id: str, job_id: str) -> dict[str, object]:
    response = client.post(
        f"/api/projects/{project_id}/jobs/{job_id}/uploads",
        files={"file": ("input.yaml", b"model: vic", "application/yaml")},
    )
    assert response.status_code == 201
    return response.json()


def test_delete_removes_uploaded_file_and_metadata(
    client: TestClient,
    project_and_job: tuple[str, str],
    backend_settings: Settings,
) -> None:
    project_id, job_id = project_and_job
    upload = create_upload(client, project_id, job_id)
    stored_file = next(backend_settings.upload_dir.iterdir())

    response = client.delete(f"/api/projects/{project_id}/jobs/{job_id}/uploads/{upload['id']}")

    assert response.status_code == 204
    assert response.content == b""
    assert not stored_file.exists()
    assert client.get(f"/api/projects/{project_id}/jobs/{job_id}/uploads").json() == []


def test_delete_rejects_upload_from_another_job(
    client: TestClient,
    project_and_job: tuple[str, str],
    backend_settings: Settings,
) -> None:
    project_id, job_id = project_and_job
    other_job = client.post(f"/api/projects/{project_id}/jobs", json={"name": "Other job"}).json()
    upload = create_upload(client, project_id, job_id)
    stored_file = next(backend_settings.upload_dir.iterdir())

    response = client.delete(
        f"/api/projects/{project_id}/jobs/{other_job['id']}/uploads/{upload['id']}"
    )

    assert response.status_code == 404
    assert stored_file.exists()
    assert len(client.get(f"/api/projects/{project_id}/jobs/{job_id}/uploads").json()) == 1


def test_delete_rejects_upload_from_another_project(
    client: TestClient,
    project_and_job: tuple[str, str],
    backend_settings: Settings,
) -> None:
    project_id, job_id = project_and_job
    other_project = client.post("/api/projects", json={"name": "Other project"}).json()
    other_job = client.post(
        f"/api/projects/{other_project['id']}/jobs", json={"name": "Other job"}
    ).json()
    upload = create_upload(client, project_id, job_id)
    stored_file = next(backend_settings.upload_dir.iterdir())

    response = client.delete(
        f"/api/projects/{other_project['id']}/jobs/{other_job['id']}/uploads/{upload['id']}"
    )

    assert response.status_code == 404
    assert stored_file.exists()
    assert len(client.get(f"/api/projects/{project_id}/jobs/{job_id}/uploads").json()) == 1


def test_delete_missing_project_job_and_upload_returns_404(
    client: TestClient,
    project_and_job: tuple[str, str],
) -> None:
    project_id, job_id = project_and_job
    missing_project = client.delete(f"/api/projects/missing/jobs/{job_id}/uploads/missing")
    missing_job = client.delete(f"/api/projects/{project_id}/jobs/missing/uploads/missing")
    missing_upload = client.delete(f"/api/projects/{project_id}/jobs/{job_id}/uploads/missing")

    assert missing_project.status_code == 404
    assert missing_project.json()["detail"] == "Project not found."
    assert missing_job.status_code == 404
    assert missing_job.json()["detail"] == "Job not found in this project."
    assert missing_upload.status_code == 404
    assert missing_upload.json()["detail"] == "Upload not found for this job."


def test_storage_failure_keeps_file_and_metadata(
    client: TestClient,
    project_and_job: tuple[str, str],
    backend_settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_id, job_id = project_and_job
    upload = create_upload(client, project_id, job_id)
    stored_file = next(backend_settings.upload_dir.iterdir())
    original_unlink = Path.unlink

    def fail_for_uploaded_file(path: Path, *args: object, **kwargs: object) -> None:
        if path == stored_file:
            raise PermissionError("simulated storage failure")
        original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_for_uploaded_file)
    response = client.delete(f"/api/projects/{project_id}/jobs/{job_id}/uploads/{upload['id']}")

    assert response.status_code == 500
    assert response.json()["detail"] == "The uploaded file could not be removed from storage."
    assert stored_file.exists()
    assert len(client.get(f"/api/projects/{project_id}/jobs/{job_id}/uploads").json()) == 1


def test_missing_physical_file_allows_stale_metadata_cleanup(
    client: TestClient,
    project_and_job: tuple[str, str],
    backend_settings: Settings,
) -> None:
    project_id, job_id = project_and_job
    upload = create_upload(client, project_id, job_id)
    next(backend_settings.upload_dir.iterdir()).unlink()

    response = client.delete(f"/api/projects/{project_id}/jobs/{job_id}/uploads/{upload['id']}")

    assert response.status_code == 204
    assert client.get(f"/api/projects/{project_id}/jobs/{job_id}/uploads").json() == []


def test_invalid_stored_name_cannot_escape_upload_directory(
    client: TestClient,
    project_and_job: tuple[str, str],
    backend_settings: Settings,
) -> None:
    project_id, job_id = project_and_job
    upload = create_upload(client, project_id, job_id)
    outside_file = backend_settings.upload_dir.parent / "keep.txt"
    outside_file.write_text("keep", encoding="utf-8")

    session = client.app.state.session_factory()
    try:
        record = session.get(Upload, upload["id"])
        assert record is not None
        record.storage_filename = "../keep.txt"
        session.commit()
    finally:
        session.close()

    response = client.delete(f"/api/projects/{project_id}/jobs/{job_id}/uploads/{upload['id']}")

    assert response.status_code == 500
    assert outside_file.read_text(encoding="utf-8") == "keep"
    assert len(client.get(f"/api/projects/{project_id}/jobs/{job_id}/uploads").json()) == 1
