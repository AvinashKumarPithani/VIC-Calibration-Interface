from __future__ import annotations

from collections.abc import Generator
import hashlib
from pathlib import Path, PureWindowsPath
from uuid import uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.models import Job, ParameterDraft, Project, Upload
from app.models.records import utc_now
from app.schemas.records import JobCreate, JobRead, ProjectCreate, ProjectRead, UploadCategory, UploadRead
from app.schemas.inspection import UploadInspectionRead
from app.schemas.parameter_drafts import ParameterDraftRead, ParameterDraftSave
from app.schemas.netcdf_editor import NetCDFEditSave, NetCDFValuesRead, NetCDFValuesRequest
from app.services.inspection import inspect_upload_content, read_stored_upload, stored_upload_path
from app.services.netcdf_inspection import NetCDFInspectionError, inspect_netcdf_path, parse_netcdf_path
from app.services.netcdf_editor import NetCDFEditError, fingerprint as netcdf_fingerprint, read_values as read_netcdf_values, save_edits as save_netcdf_edits
from app.services import parameter_drafts as draft_policy
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
    CONFIGURATION_INPUT_CATEGORY,
    NETCDF_PARAMETER_DATASET_CATEGORY,
    is_rat_configuration_filename,
    safe_original_filename,
    store_upload,
)

router = APIRouter()


def _get_scoped_upload(project_id: str, job_id: str, upload_id: str, db: Session) -> Upload:
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
    return upload


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


async def _create_upload(
    project_id: str,
    job_id: str,
    file: UploadFile,
    request: Request,
    db: Session,
    upload_category: str,
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
        candidate_extension = Path(candidate_name).suffix.lower()
        is_netcdf_upload = upload_category == NETCDF_PARAMETER_DATASET_CATEGORY
        if is_netcdf_upload and candidate_extension != ".nc":
            raise UnsupportedUploadType
        if not is_netcdf_upload and candidate_extension == ".nc":
            raise UnsupportedUploadType
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
            settings.max_netcdf_upload_size_bytes if is_netcdf_upload else settings.max_upload_size_bytes,
        )
        storage_path = settings.upload_dir / storage_filename
        record = Upload(
            project_id=project_id,
            job_id=job_id,
            original_filename=original_filename,
            upload_category=upload_category,
            storage_filename=storage_filename,
            file_size=file_size,
        )
        if is_netcdf_upload:
            # Reject malformed or unsupported datasets before recording the upload.
            parse_netcdf_path(storage_path)
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
        netcdf_limit_mib = settings.max_netcdf_upload_size_bytes / (1024 * 1024)
        detail = f"The NetCDF file exceeds the configured {netcdf_limit_mib:g} MiB limit." if candidate_extension == ".nc" else "The file exceeds the configured size limit."
        if storage_path is not None:
            storage_path.unlink(missing_ok=True)
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=detail) from None
    except NetCDFInspectionError as error:
        if storage_path is not None:
            storage_path.unlink(missing_ok=True)
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)) from None
    except HTTPException:
        if storage_path is not None:
            storage_path.unlink(missing_ok=True)
        raise
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


@router.post(
    "/api/projects/{project_id}/jobs/{job_id}/uploads",
    response_model=UploadRead,
    status_code=status.HTTP_201_CREATED,
    tags=["uploads"],
)
async def create_configuration_upload(
    project_id: str,
    job_id: str,
    file: UploadFile = File(...),
    request: Request = None,
    db: Session = Depends(get_session),
) -> Upload:
    return await _create_upload(project_id, job_id, file, request, db, CONFIGURATION_INPUT_CATEGORY)


@router.post(
    "/api/projects/{project_id}/jobs/{job_id}/netcdf-uploads",
    response_model=UploadRead,
    status_code=status.HTTP_201_CREATED,
    tags=["uploads"],
)
async def create_netcdf_upload(
    project_id: str,
    job_id: str,
    file: UploadFile = File(...),
    request: Request = None,
    db: Session = Depends(get_session),
) -> Upload:
    return await _create_upload(project_id, job_id, file, request, db, NETCDF_PARAMETER_DATASET_CATEGORY)


@router.get(
    "/api/projects/{project_id}/jobs/{job_id}/uploads",
    response_model=list[UploadRead],
    tags=["uploads"],
)
def list_uploads(
    project_id: str,
    job_id: str,
    category: UploadCategory | None = Query(default=None),
    db: Session = Depends(get_session),
) -> list[Upload]:
    job = db.scalar(select(Job).where(Job.id == job_id, Job.project_id == project_id))
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found in this project.")
    statement = select(Upload).where(Upload.project_id == project_id, Upload.job_id == job_id)
    if category is not None:
        statement = statement.where(Upload.upload_category == category)
    statement = statement.order_by(Upload.uploaded_at.desc(), Upload.id)
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
    category: UploadCategory | None = Query(default=None),
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
    if category is not None and upload.upload_category != category:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload not found in this collection.")
    if Path(upload.original_filename).suffix.lower() == ".nc":
        if upload.upload_category != NETCDF_PARAMETER_DATASET_CATEGORY:
            raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="This upload is not a NetCDF dataset.")
        netcdf_path = stored_upload_path(upload, request.app.state.settings.upload_dir)
        if not netcdf_path.is_file():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Uploaded file content is unavailable.")
        return inspect_netcdf_path(upload, netcdf_path)
    content = read_stored_upload(upload, request.app.state.settings.upload_dir)
    return inspect_upload_content(upload, content)


@router.post("/api/projects/{project_id}/jobs/{job_id}/uploads/{upload_id}/netcdf-values", response_model=NetCDFValuesRead, tags=["NetCDF editor"])
def netcdf_values(project_id: str, job_id: str, upload_id: str, payload: NetCDFValuesRequest, request: Request, db: Session = Depends(get_session)) -> dict:
    upload = _get_scoped_upload(project_id, job_id, upload_id, db)
    if upload.upload_category != NETCDF_PARAMETER_DATASET_CATEGORY:
        raise HTTPException(status_code=404, detail="NetCDF upload not found for this job.")
    path = stored_upload_path(upload, request.app.state.settings.upload_dir)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Uploaded file content is unavailable.")
    try:
        return read_netcdf_values(path, payload.variable, payload.selectors, payload.start, payload.limit,
                                  payload.window_starts, payload.window_limits)
    except NetCDFEditError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None


@router.post("/api/projects/{project_id}/jobs/{job_id}/uploads/{upload_id}/netcdf-edits", response_model=UploadRead, status_code=status.HTTP_201_CREATED, tags=["NetCDF editor"])
def save_netcdf_edits_endpoint(project_id: str, job_id: str, upload_id: str, payload: NetCDFEditSave, request: Request, db: Session = Depends(get_session)) -> Upload:
    source = _get_scoped_upload(project_id, job_id, upload_id, db)
    if source.upload_category != NETCDF_PARAMETER_DATASET_CATEGORY:
        raise HTTPException(status_code=404, detail="NetCDF upload not found for this job.")
    source_path = stored_upload_path(source, request.app.state.settings.upload_dir)
    if not source_path.is_file():
        raise HTTPException(status_code=404, detail="Uploaded file content is unavailable.")
    if netcdf_fingerprint(source_path) != payload.source_sha256:
        raise HTTPException(status_code=409, detail="The source file changed. Reload it before saving edits.")
    storage_name = f"{uuid4().hex}.nc"
    output_path = Path(request.app.state.settings.upload_dir) / storage_name
    try:
        save_netcdf_edits(source_path, output_path, payload.source_sha256, payload.edits)
        file_size = output_path.stat().st_size
        if file_size > request.app.state.settings.max_netcdf_upload_size_bytes:
            raise NetCDFEditError("The verified output exceeds the configured NetCDF size limit.")
        artifact = Upload(
            project_id=project_id, job_id=job_id,
            original_filename=f"edited_{Path(source.original_filename).stem}_{uuid4().hex[:8]}.nc",
            upload_category=NETCDF_PARAMETER_DATASET_CATEGORY,
            storage_filename=storage_name, file_size=file_size, source_upload_id=source.id,
        )
        parse_netcdf_path(output_path)
        db.add(artifact)
        db.commit()
        db.refresh(artifact)
        return artifact
    except NetCDFEditError as error:
        output_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=str(error)) from None
    except NetCDFInspectionError:
        output_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail="The written NetCDF output failed inspection.") from None
    except (IntegrityError, SQLAlchemyError):
        db.rollback()
        output_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="The verified NetCDF output could not be registered.") from None
    except OSError:
        output_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="The NetCDF output could not be stored.") from None


@router.get("/api/projects/{project_id}/jobs/{job_id}/uploads/{upload_id}/download", tags=["uploads"])
def download_upload(project_id: str, job_id: str, upload_id: str, request: Request, db: Session = Depends(get_session)) -> FileResponse:
    upload = _get_scoped_upload(project_id, job_id, upload_id, db)
    if upload.upload_category != NETCDF_PARAMETER_DATASET_CATEGORY:
        raise HTTPException(status_code=404, detail="NetCDF upload not found for this job.")
    path = stored_upload_path(upload, request.app.state.settings.upload_dir)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Uploaded file content is unavailable.")
    return FileResponse(path, media_type="application/x-netcdf", filename=upload.original_filename)

@router.get(
    "/api/projects/{project_id}/jobs/{job_id}/uploads/{upload_id}/draft",
    response_model=ParameterDraftRead | None,
    tags=["parameter drafts"],
)
def get_parameter_draft(
    project_id: str, job_id: str, upload_id: str, request: Request, db: Session = Depends(get_session),
) -> ParameterDraft | None:
    upload = _get_scoped_upload(project_id, job_id, upload_id, db)
    draft = db.scalar(select(ParameterDraft).where(
        ParameterDraft.project_id == project_id,
        ParameterDraft.job_id == job_id,
        ParameterDraft.source_upload_id == upload_id,
    ))
    if draft is None:
        return None
    content = read_stored_upload(upload, request.app.state.settings.upload_dir)
    if hashlib.sha256(content).hexdigest() != draft.source_sha256:
        db.delete(draft)
        try:
            db.commit()
        except SQLAlchemyError:
            db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="The stale parameter draft could not be cleared.") from None
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The source upload changed. Its saved draft was cleared.")
    return draft


@router.put(
    "/api/projects/{project_id}/jobs/{job_id}/uploads/{upload_id}/draft",
    response_model=ParameterDraftRead,
    tags=["parameter drafts"],
)
def save_parameter_draft(
    project_id: str,
    job_id: str,
    upload_id: str,
    payload: ParameterDraftSave,
    request: Request,
    db: Session = Depends(get_session),
) -> ParameterDraft:
    upload = _get_scoped_upload(project_id, job_id, upload_id, db)
    content = read_stored_upload(upload, request.app.state.settings.upload_dir)
    inspection = inspect_upload_content(upload, content)
    if inspection.parse_status != "parsed" or inspection.representation is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Only successfully parsed supported files can have a parameter draft.")
    if payload.source_format != inspection.detected_format:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The source file format changed. Reload its inspection before saving.")
    changes = draft_policy.validate_draft_changes(inspection, payload.changes)
    fingerprint = hashlib.sha256(content).hexdigest()
    draft = db.scalar(select(ParameterDraft).where(
        ParameterDraft.project_id == project_id,
        ParameterDraft.job_id == job_id,
        ParameterDraft.source_upload_id == upload_id,
    ).with_for_update())
    try:
        if draft is None:
            if payload.expected_revision is not None:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The draft changed or was removed. Reload it before saving.")
            draft = ParameterDraft(
                project_id=project_id, job_id=job_id, source_upload_id=upload_id,
                source_format=inspection.detected_format, source_sha256=fingerprint,
                revision=1, changes=changes,
            )
            db.add(draft)
        else:
            if payload.expected_revision != draft.revision:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The draft has a newer revision. Reload it before saving.")
            updated = db.execute(update(ParameterDraft).where(
                ParameterDraft.id == draft.id,
                ParameterDraft.revision == payload.expected_revision,
            ).values(
                source_format=inspection.detected_format,
                source_sha256=fingerprint,
                revision=draft.revision + 1,
                changes=changes,
                updated_at=utc_now(),
            ))
            if updated.rowcount != 1:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The draft has a newer revision. Reload it before saving.")
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The parameter draft changed concurrently. Reload it before saving.") from None
    except SQLAlchemyError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="The parameter draft could not be saved.") from None
    saved_draft = db.scalar(select(ParameterDraft).where(
        ParameterDraft.project_id == project_id,
        ParameterDraft.job_id == job_id,
        ParameterDraft.source_upload_id == upload_id,
    ))
    if saved_draft is None:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="The saved parameter draft could not be loaded.")
    return saved_draft


@router.delete(
    "/api/projects/{project_id}/jobs/{job_id}/uploads/{upload_id}/draft",
    status_code=status.HTTP_204_NO_CONTENT,
    tags=["parameter drafts"],
)
def discard_parameter_draft(project_id: str, job_id: str, upload_id: str, db: Session = Depends(get_session)) -> None:
    _get_scoped_upload(project_id, job_id, upload_id, db)
    draft = db.scalar(select(ParameterDraft).where(
        ParameterDraft.project_id == project_id,
        ParameterDraft.job_id == job_id,
        ParameterDraft.source_upload_id == upload_id,
    ))
    if draft is not None:
        db.delete(draft)
        try:
            db.commit()
        except SQLAlchemyError:
            db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="The parameter draft could not be discarded.") from None
    return None


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
    category: UploadCategory | None = Query(default=None),
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
    if category is not None and upload.upload_category != category:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload not found in this collection.")

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
