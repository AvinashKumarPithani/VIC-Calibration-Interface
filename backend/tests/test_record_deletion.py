from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import Upload
from app.services import record_deletion
from app.services.record_deletion import recover_staged_upload_deletions


def create_job(client: TestClient, project_id: str, name: str) -> dict[str, str]:
    response = client.post(f"/api/projects/{project_id}/jobs", json={"name": name})
    assert response.status_code == 201
    return response.json()


def create_upload(client: TestClient, project_id: str, job_id: str, filename: str = "input.txt") -> dict[str, object]:
    response = client.post(
        f"/api/projects/{project_id}/jobs/{job_id}/uploads",
        files={"file": (filename, b"sample input", "text/plain")},
    )
    assert response.status_code == 201
    return response.json()


def stored_path(settings: Settings, client: TestClient, upload_id: str) -> Path:
    session = client.app.state.session_factory()
    try:
        upload = session.get(Upload, upload_id)
        assert upload is not None
        return settings.upload_dir / upload.storage_filename
    finally:
        session.close()


def test_delete_job_removes_its_uploads_but_preserves_other_jobs(
    client: TestClient,
    project_and_job: tuple[str, str],
    backend_settings: Settings,
) -> None:
    project_id, job_id = project_and_job
    other_job = create_job(client, project_id, "Keep job")
    deleted_upload = create_upload(client, project_id, job_id)
    kept_upload = create_upload(client, project_id, other_job["id"], "other.txt")
    deleted_path = stored_path(backend_settings, client, deleted_upload["id"])
    kept_path = stored_path(backend_settings, client, kept_upload["id"])

    response = client.delete(f"/api/projects/{project_id}/jobs/{job_id}")

    assert response.status_code == 204
    assert client.get(f"/api/projects/{project_id}").status_code == 200
    assert client.get(f"/api/projects/{project_id}/jobs/{job_id}").status_code == 404
    assert not deleted_path.exists()
    assert kept_path.exists()
    assert len(client.get(f"/api/projects/{project_id}/jobs/{other_job['id']}/uploads").json()) == 1


def test_delete_project_removes_jobs_uploads_and_files_only_for_that_project(
    client: TestClient,
    project_and_job: tuple[str, str],
    backend_settings: Settings,
) -> None:
    project_id, job_id = project_and_job
    second_job = create_job(client, project_id, "Second job")
    other_project = client.post("/api/projects", json={"name": "Keep project"}).json()
    other_job = create_job(client, other_project["id"], "Keep job")
    first_upload = create_upload(client, project_id, job_id)
    second_upload = create_upload(client, project_id, second_job["id"], "second.txt")
    kept_upload = create_upload(client, other_project["id"], other_job["id"], "kept.txt")
    deleted_paths = [
        stored_path(backend_settings, client, first_upload["id"]),
        stored_path(backend_settings, client, second_upload["id"]),
    ]
    kept_path = stored_path(backend_settings, client, kept_upload["id"])

    response = client.delete(f"/api/projects/{project_id}")

    assert response.status_code == 204
    assert client.get(f"/api/projects/{project_id}").status_code == 404
    assert all(not path.exists() for path in deleted_paths)
    assert kept_path.exists()
    assert client.get(f"/api/projects/{other_project['id']}/jobs/{other_job['id']}").status_code == 200


def test_delete_empty_project_succeeds(client: TestClient) -> None:
    project = client.post("/api/projects", json={"name": "Empty project"}).json()

    response = client.delete(f"/api/projects/{project['id']}")

    assert response.status_code == 204
    assert client.get(f"/api/projects/{project['id']}").status_code == 404


def test_delete_job_checks_project_ownership(
    client: TestClient,
    project_and_job: tuple[str, str],
    backend_settings: Settings,
) -> None:
    project_id, job_id = project_and_job
    other_project = client.post("/api/projects", json={"name": "Other project"}).json()
    upload = create_upload(client, project_id, job_id)
    path = stored_path(backend_settings, client, upload["id"])

    response = client.delete(f"/api/projects/{other_project['id']}/jobs/{job_id}")

    assert response.status_code == 404
    assert path.exists()
    assert client.get(f"/api/projects/{project_id}/jobs/{job_id}").status_code == 200


def test_staging_failure_keeps_job_records_and_files(
    client: TestClient,
    project_and_job: tuple[str, str],
    backend_settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_id, job_id = project_and_job
    upload = create_upload(client, project_id, job_id)
    path = stored_path(backend_settings, client, upload["id"])
    original_replace = record_deletion.os.replace

    def fail_upload_stage(source: str | Path, destination: str | Path) -> None:
        if Path(source) == path:
            raise PermissionError("simulated file move failure")
        original_replace(source, destination)

    monkeypatch.setattr(record_deletion.os, "replace", fail_upload_stage)
    response = client.delete(f"/api/projects/{project_id}/jobs/{job_id}")

    assert response.status_code == 500
    assert path.exists()
    assert client.get(f"/api/projects/{project_id}/jobs/{job_id}").status_code == 200
    assert len(client.get(f"/api/projects/{project_id}/jobs/{job_id}/uploads").json()) == 1


def test_database_failure_restores_staged_files_and_keeps_records(
    client: TestClient,
    project_and_job: tuple[str, str],
    backend_settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_id, job_id = project_and_job
    upload = create_upload(client, project_id, job_id)
    path = stored_path(backend_settings, client, upload["id"])
    original_commit = Session.commit

    def fail_commit(session: Session) -> None:
        raise SQLAlchemyError("simulated commit failure")

    monkeypatch.setattr(Session, "commit", fail_commit)
    response = client.delete(f"/api/projects/{project_id}/jobs/{job_id}")
    monkeypatch.setattr(Session, "commit", original_commit)

    assert response.status_code == 500
    assert path.exists()
    assert client.get(f"/api/projects/{project_id}/jobs/{job_id}").status_code == 200
    assert len(client.get(f"/api/projects/{project_id}/jobs/{job_id}/uploads").json()) == 1


def test_startup_recovery_restores_referenced_upload_and_removes_deleted_upload(
    client: TestClient,
    project_and_job: tuple[str, str],
    backend_settings: Settings,
) -> None:
    project_id, job_id = project_and_job
    upload = create_upload(client, project_id, job_id)
    path = stored_path(backend_settings, client, upload["id"])
    staged_path = backend_settings.upload_dir / f"{record_deletion.STAGING_PREFIX}{upload['id']}__{path.name}"
    path.replace(staged_path)

    recover_staged_upload_deletions(client.app.state.session_factory, backend_settings.upload_dir)
    assert path.exists()
    assert not staged_path.exists()

    path.replace(staged_path)
    session = client.app.state.session_factory()
    try:
        session.delete(session.get(Upload, upload["id"]))
        session.commit()
    finally:
        session.close()
    recover_staged_upload_deletions(client.app.state.session_factory, backend_settings.upload_dir)
    assert not path.exists()
    assert not staged_path.exists()
