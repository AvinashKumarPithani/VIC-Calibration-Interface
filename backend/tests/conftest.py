from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


@pytest.fixture
def backend_settings(tmp_path: Path) -> Settings:
    database_path = tmp_path / "test.sqlite3"
    return Settings(
        database_url=f"sqlite:///{database_path.as_posix()}",
        upload_dir=tmp_path / "uploads",
        max_upload_size_bytes=64,
    )


@pytest.fixture
def client(backend_settings: Settings):
    app = create_app(backend_settings)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def project_and_job(client: TestClient) -> tuple[str, str]:
    project_response = client.post("/api/projects", json={"name": "Test basin", "description": "Test project"})
    assert project_response.status_code == 201
    project_id = project_response.json()["id"]

    job_response = client.post(
        f"/api/projects/{project_id}/jobs",
        json={"name": "Baseline", "description": "Initial experiment"},
    )
    assert job_response.status_code == 201
    return project_id, job_response.json()["id"]
