from __future__ import annotations

from collections.abc import Generator
from pathlib import Path, PureWindowsPath

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.models import Job, Project, Upload
from app.models.records import utc_now
from app.schemas.records import JobCreate, JobRead, ProjectCreate, ProjectRead, UploadRead
from app.schemas.inspection import UploadInspectionRead
from app.services.inspection import inspect_upload_content, read_stored_upload
from app.services.record_deletion import (
    UploadStorageDeletionError,
    finalize_staged_upload_files,
    restore_staged_upload_files,
    stage_upload_files,
)
from app.services.uploads import (
    EmptyUpload,
    InvalidUploadName,
    UploadTooLarge,
    UnsupportedUploadType,
    RAT_CONFIGURATION_FILENAMES,
    is_rat_configuration_filename,
    safe_original_filename,
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


@router.put("/api/projects/{project_id}", response_model=ProjectRead, tags=["projects"])
def update_project(project_id: str, payload: ProjectCreate, db: Session = Depends(get_session)) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    project.name = payload.name
    project.description = payload.description
    project.modified_at = utc_now()
    db.commit()
    db.refresh(project)
    return project


@router.delete("/api/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["projects"])
def delete_project(project_id: str, request: Request, db: Session = Depends(get_session)) -> None:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    uploads = list(db.scalars(select(Upload).where(Upload.project_id == project_id)).all())
    try:
        staged = stage_upload_files(uploads, request.app.state.settings.upload_dir)
    except UploadStorageDeletionError:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Project files could not be prepared for deletion.") from None
    try:
        db.delete(project)
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        try:
            restore_staged_upload_files(staged)
        except OSError:
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Project deletion failed; file recovery will be retried on backend startup.") from None
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Project and its records could not be deleted.") from None
    try:
        finalize_staged_upload_files(staged)
    except OSError:
        # Staged files are inaccessible to upload APIs and are removed on next startup.
        pass
    return None

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


@router.delete("/api/projects/{project_id}/jobs/{job_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["jobs"])
def delete_job(project_id: str, job_id: str, request: Request, db: Session = Depends(get_session)) -> None:
    if db.get(Project, project_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    job = db.scalar(select(Job).where(Job.id == job_id, Job.project_id == project_id))
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found in this project.")
    uploads = list(db.scalars(select(Upload).where(
        Upload.project_id == project_id,
        Upload.job_id == job_id,
    )).all())
    try:
        staged = stage_upload_files(uploads, request.app.state.settings.upload_dir)
    except UploadStorageDeletionError:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Job files could not be prepared for deletion.") from None
    try:
        db.delete(job)
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        try:
            restore_staged_upload_files(staged)
        except OSError:
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Job deletion failed; file recovery will be retried on backend startup.") from None
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Job and its records could not be deleted.") from None
    try:
        finalize_staged_upload_files(staged)
    except OSError:
        # Staged files are inaccessible to upload APIs and are removed on next startup.
        pass
    return None


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
    is_rat_upload = False
    try:
        candidate_name = safe_original_filename(file.filename)
        is_rat_upload = is_rat_configuration_filename(candidate_name)
        duplicate_filename = db.scalar(select(Upload.id).where(
            Upload.project_id == project_id,
            Upload.job_id == job_id,
            Upload.original_filename == candidate_name,
        ))
        if duplicate_filename is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"A file named '{candidate_name}' already exists in this job. Delete the existing file before uploading a replacement.",
            )
        if is_rat_upload:
            existing_rat_config = db.scalar(select(Upload.id).where(
                Upload.project_id == project_id,
                Upload.job_id == job_id,
                func.lower(Upload.original_filename).in_(RAT_CONFIGURATION_FILENAMES),
            ))
            if existing_rat_config is not None:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="A RAT configuration already exists for this job. Delete it before uploading a replacement.",
                )

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
    except IntegrityError:
        db.rollback()
        if storage_path is not None:
            storage_path.unlink(missing_ok=True)
        if db.scalar(select(Upload.id).where(
            Upload.project_id == project_id,
            Upload.job_id == job_id,
            Upload.original_filename == candidate_name,
        )) is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"A file named '{candidate_name}' already exists in this job. Delete the existing file before uploading a replacement.",
            ) from None
        if is_rat_upload and db.scalar(select(Upload.id).where(
            Upload.project_id == project_id,
            Upload.job_id == job_id,
            func.lower(Upload.original_filename).in_(RAT_CONFIGURATION_FILENAMES),
        )) is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A RAT configuration already exists for this job. Delete it before uploading a replacement.",
            ) from None
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="The upload could not be recorded.") from None
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


@router.get(
    "/api/projects/{project_id}/jobs/{job_id}/uploads/{upload_id}/inspection",
    response_model=UploadInspectionRead,
    tags=["uploads"],
)
def inspect_job_upload(
    project_id: str,
    job_id: str,
    upload_id: str,
    request: Request,
    db: Session = Depends(get_session),
) -> UploadInspectionRead:
    if db.get(Project, project_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    job = db.scalar(select(Job).where(Job.id == job_id, Job.project_id == project_id))
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found in this project.")
    upload = db.scalar(select(Upload).where(
        Upload.id == upload_id,
        Upload.project_id == project_id,
        Upload.job_id == job_id,
    ))
    if upload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload not found for this job.")
    content = read_stored_upload(upload, request.app.state.settings.upload_dir)
    return inspect_upload_content(upload, content)

@router.delete(
    "/api/projects/{project_id}/jobs/{job_id}/uploads/{upload_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    tags=["uploads"],
)
def delete_upload(
    project_id: str,
    job_id: str,
    upload_id: str,
    request: Request,
    db: Session = Depends(get_session),
) -> None:
    if db.get(Project, project_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")

    job = db.scalar(select(Job).where(Job.id == job_id, Job.project_id == project_id))
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found in this project.")

    upload = db.scalar(select(Upload).where(
        Upload.id == upload_id,
        Upload.project_id == project_id,
        Upload.job_id == job_id,
    ))
    if upload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload not found for this job.")

    storage_dir = Path(request.app.state.settings.upload_dir).resolve()
    stored_name = upload.storage_filename
    if (
        Path(stored_name).name != stored_name
        or PureWindowsPath(stored_name).name != stored_name
        or Path(stored_name).is_absolute()
        or PureWindowsPath(stored_name).is_absolute()
    ):
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Stored upload location is invalid.")
    stored_path = (storage_dir / stored_name).resolve()
    if stored_path == storage_dir or not stored_path.is_relative_to(storage_dir):
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Stored upload location is invalid.")

    try:
        stored_path.unlink(missing_ok=True)
    except OSError:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="The uploaded file could not be removed from storage.",
        ) from None

    try:
        db.delete(upload)
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="The file was removed, but its metadata could not be deleted.",
        ) from None
