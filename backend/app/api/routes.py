from __future__ import annotations

from collections.abc import Generator

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.models import Job, Project, Upload
from app.models.records import utc_now
from app.schemas.records import JobCreate, JobRead, ProjectCreate, ProjectRead, UploadRead
from app.services.uploads import (
    EmptyUpload,
    InvalidUploadName,
    UploadTooLarge,
    UnsupportedUploadType,
    store_upload,
)

router = APIRouter()


def get_session(request: Request) -> Generator[Session, None, None]:
    session = request.app.state.session_factory()
    try:
        yield session
    finally:
        session.close()


@router.get("/health", tags=["health"])
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/api/projects", response_model=ProjectRead, status_code=status.HTTP_201_CREATED, tags=["projects"])
def create_project(payload: ProjectCreate, db: Session = Depends(get_session)) -> Project:
    project = Project(name=payload.name, description=payload.description)
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


@router.get("/api/projects", response_model=list[ProjectRead], tags=["projects"])
def list_projects(db: Session = Depends(get_session)) -> list[Project]:
    return list(db.scalars(select(Project).order_by(Project.created_at.desc(), Project.id)).all())


@router.get("/api/projects/{project_id}", response_model=ProjectRead, tags=["projects"])
def get_project(project_id: str, db: Session = Depends(get_session)) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    return project


@router.post(
    "/api/projects/{project_id}/jobs",
    response_model=JobRead,
    status_code=status.HTTP_201_CREATED,
    tags=["jobs"],
)
def create_job(project_id: str, payload: JobCreate, db: Session = Depends(get_session)) -> Job:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    job = Job(project_id=project.id, name=payload.name, description=payload.description)
    project.modified_at = utc_now()
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


@router.get("/api/projects/{project_id}/jobs", response_model=list[JobRead], tags=["jobs"])
def list_jobs(project_id: str, db: Session = Depends(get_session)) -> list[Job]:
    if db.get(Project, project_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    statement = select(Job).where(Job.project_id == project_id).order_by(Job.created_at.desc(), Job.id)
    return list(db.scalars(statement).all())


@router.get("/api/projects/{project_id}/jobs/{job_id}", response_model=JobRead, tags=["jobs"])
def get_job(project_id: str, job_id: str, db: Session = Depends(get_session)) -> Job:
    job = db.scalar(select(Job).where(Job.id == job_id, Job.project_id == project_id))
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found in this project.")
    return job


@router.post(
    "/api/projects/{project_id}/jobs/{job_id}/uploads",
    response_model=UploadRead,
    status_code=status.HTTP_201_CREATED,
    tags=["uploads"],
)
async def create_upload(
    project_id: str,
    job_id: str,
    file: UploadFile = File(...),
    request: Request = None,
    db: Session = Depends(get_session),
) -> Upload:
    job = db.scalar(select(Job).where(Job.id == job_id, Job.project_id == project_id))
    if job is None:
        await file.close()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found in this project.")

    settings = request.app.state.settings
    storage_path: Path | None = None
    try:
        original_filename, storage_filename, file_size = await store_upload(
            file,
            settings.upload_dir,
            settings.max_upload_size_bytes,
        )
        storage_path = settings.upload_dir / storage_filename
        record = Upload(
            project_id=project_id,
            job_id=job_id,
            original_filename=original_filename,
            storage_filename=storage_filename,
            file_size=file_size,
        )
        db.add(record)
        db.commit()
        db.refresh(record)
        return record
    except InvalidUploadName:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="A valid filename is required.") from None
    except UnsupportedUploadType:
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="This file type is not supported.") from None
    except EmptyUpload:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty files are not accepted.") from None
    except UploadTooLarge:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="The file exceeds the configured size limit.") from None
    except SQLAlchemyError:
        db.rollback()
        if storage_path is not None:
            storage_path.unlink(missing_ok=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="The upload could not be recorded.") from None
    except OSError:
        if storage_path is not None:
            storage_path.unlink(missing_ok=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="The upload could not be stored.") from None
    finally:
        await file.close()


@router.get(
    "/api/projects/{project_id}/jobs/{job_id}/uploads",
    response_model=list[UploadRead],
    tags=["uploads"],
)
def list_uploads(project_id: str, job_id: str, db: Session = Depends(get_session)) -> list[Upload]:
    job = db.scalar(select(Job).where(Job.id == job_id, Job.project_id == project_id))
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found in this project.")
    statement = select(Upload).where(Upload.project_id == project_id, Upload.job_id == job_id).order_by(Upload.uploaded_at.desc(), Upload.id)
    return list(db.scalars(statement).all())
