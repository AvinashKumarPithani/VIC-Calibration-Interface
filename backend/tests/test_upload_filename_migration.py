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


def test_pre_category_database_classifies_legacy_tab2_inputs_without_touching_bytes(tmp_path: Path) -> None:
    database_path = tmp_path / "pre_category.sqlite3"
    upload_dir = tmp_path / "legacy_uploads"
    settings = Settings(
        database_url=f"sqlite:///{database_path.as_posix()}",
        upload_dir=upload_dir,
        max_upload_size_bytes=64,
    )
    seed_engine = create_engine(settings.database_url)
    Base.metadata.create_all(seed_engine)
    with Session(seed_engine) as session:
        project = Project(name="Legacy project")
        job = Job(name="Legacy job", project=project)
        session.add(job)
        session.flush()
        project_id, job_id = project.id, job.id
        session.commit()
    with seed_engine.begin() as connection:
        connection.exec_driver_sql("ALTER TABLE uploads DROP COLUMN upload_category")
        connection.exec_driver_sql(
            "INSERT INTO uploads (id, project_id, job_id, original_filename, storage_filename, file_size, uploaded_at) "
            "VALUES ('legacy-yaml', ?, ?, 'rat_config.yaml', 'legacy-yaml.bin', 5, '2025-01-01 00:00:00.000000')",
            (project_id, job_id),
        )
        connection.exec_driver_sql(
            "INSERT INTO uploads (id, project_id, job_id, original_filename, storage_filename, file_size, uploaded_at) "
            "VALUES ('legacy-netcdf', ?, ?, 'vic_soil_param.nc', 'legacy-netcdf.bin', 5, '2025-01-01 00:00:00.000000')",
            (project_id, job_id),
        )
        connection.exec_driver_sql(
            "INSERT INTO uploads (id, project_id, job_id, original_filename, storage_filename, file_size, uploaded_at) "
            "VALUES ('legacy-unknown', ?, ?, 'forcing.csv', 'legacy-unknown.bin', 5, '2025-01-01 00:00:00.000000')",
            (project_id, job_id),
        )
    seed_engine.dispose()
    upload_dir.mkdir()
    (upload_dir / "legacy-yaml.bin").write_bytes(b"yaml!")
    (upload_dir / "legacy-netcdf.bin").write_bytes(b"netcd")
    (upload_dir / "legacy-unknown.bin").write_bytes(b"csv!!")

    for _ in range(2):
        with TestClient(create_app(settings)) as client:
            root = f"/api/projects/{project_id}/jobs/{job_id}/uploads"
            all_records = client.get(root).json()
            categories = {record["id"]: record["upload_category"] for record in all_records}
            assert categories == {
                "legacy-yaml": "configuration_input",
                "legacy-netcdf": "legacy_unclassified",
                "legacy-unknown": "legacy_unclassified",
            }
            config_records = client.get(root, params={"category": "configuration_input"}).json()
            assert [record["id"] for record in config_records] == ["legacy-yaml"]
            assert client.get(root, params={"category": "netcdf_parameter_dataset"}).json() == []
            legacy_records = client.get(root, params={"category": "legacy_unclassified"}).json()
            assert {record["id"] for record in legacy_records} == {"legacy-netcdf", "legacy-unknown"}

    assert (upload_dir / "legacy-yaml.bin").read_bytes() == b"yaml!"
    assert (upload_dir / "legacy-netcdf.bin").read_bytes() == b"netcd"
    assert (upload_dir / "legacy-unknown.bin").read_bytes() == b"csv!!"
