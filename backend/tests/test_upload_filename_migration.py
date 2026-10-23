from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, insert, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
import pytest

from app.core.config import Settings
from app.db import Base
from app.main import create_app
from app.models import Job, Project, Upload


def test_startup_preserves_legacy_duplicate_uploads_and_migration_is_repeatable(tmp_path: Path) -> None:
    database_path = tmp_path / "legacy.sqlite3"
    upload_dir = tmp_path / "uploads"
    settings = Settings(
        database_url=f"sqlite:///{database_path.as_posix()}",
        upload_dir=upload_dir,
        max_upload_size_bytes=64,
    )
    seed_engine = create_engine(settings.database_url)
    Base.metadata.create_all(seed_engine)

    upload_dir.mkdir()
    (upload_dir / "legacy-a.txt").write_bytes(b"legacy bytes A")
    (upload_dir / "legacy-b.txt").write_bytes(b"legacy bytes B")
    with Session(seed_engine) as session:
        project = Project(name="Legacy project")
        job = Job(name="Legacy job", project=project)
        session.add(job)
        session.flush()
        project_id, job_id = project.id, job.id
        session.add_all([
            Upload(
                id="legacy-upload-a",
                project_id=project_id,
                job_id=job_id,
                original_filename="same-input.txt",
                storage_filename="legacy-a.txt",
                file_size=len(b"legacy bytes A"),
            ),
            Upload(
                id="legacy-upload-b",
                project_id=project_id,
                job_id=job_id,
                original_filename="same-input.txt",
                storage_filename="legacy-b.txt",
                file_size=len(b"legacy bytes B"),
            ),
        ])
        session.commit()
    seed_engine.dispose()

    for _ in range(2):
        with TestClient(create_app(settings)) as client:
            uploads_url = f"/api/projects/{project_id}/jobs/{job_id}/uploads"
            records = client.get(uploads_url).json()
            assert {record["id"] for record in records} == {"legacy-upload-a", "legacy-upload-b"}
            rejected = client.post(uploads_url, files={"file": ("same-input.txt", b"new bytes", "text/plain")})
            assert rejected.status_code == 409
            assert "same-input.txt" in rejected.json()["detail"]

            other_job = client.post(
                f"/api/projects/{project_id}/jobs",
                json={"name": "Other job"},
            ).json()
            allowed = client.post(
                f"/api/projects/{project_id}/jobs/{other_job['id']}/uploads",
                files={"file": ("same-input.txt", b"other job bytes", "text/plain")},
            )
            assert allowed.status_code == 201

    # The database trigger also protects callers that bypass the API precheck.
    with pytest.raises(IntegrityError, match="duplicate upload filename for job"):
        with create_engine(settings.database_url).begin() as connection:
            connection.execute(insert(Upload).values(
                id="bypass-upload",
                project_id=project_id,
                job_id=job_id,
                original_filename="same-input.txt",
                storage_filename="bypass.txt",
                file_size=1,
            ))

    assert (upload_dir / "legacy-a.txt").read_bytes() == b"legacy bytes A"
    assert (upload_dir / "legacy-b.txt").read_bytes() == b"legacy bytes B"
    with create_engine(settings.database_url).connect() as connection:
        legacy_records = connection.execute(
            select(Upload.id, Upload.storage_filename)
            .where(Upload.job_id == job_id)
            .order_by(Upload.id)
        ).all()
    assert legacy_records == [
        ("legacy-upload-a", "legacy-a.txt"),
        ("legacy-upload-b", "legacy-b.txt"),
    ]
