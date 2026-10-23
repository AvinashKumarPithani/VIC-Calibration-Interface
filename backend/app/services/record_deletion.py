from __future__ import annotations

import os
from pathlib import Path, PureWindowsPath
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.models import Upload

STAGING_PREFIX = ".vic-delete__"


class UploadStorageDeletionError(Exception):
    pass


def _safe_upload_path(storage_dir: Path, storage_filename: str) -> Path:
    if (
        Path(storage_filename).name != storage_filename
        or PureWindowsPath(storage_filename).name != storage_filename
        or Path(storage_filename).is_absolute()
        or PureWindowsPath(storage_filename).is_absolute()
    ):
        raise UploadStorageDeletionError
    resolved = (storage_dir / storage_filename).resolve()
    if resolved == storage_dir or not resolved.is_relative_to(storage_dir):
        raise UploadStorageDeletionError
    return resolved


def stage_upload_files(uploads: list[Upload], upload_dir: Path) -> list[tuple[Path, Path]]:
    storage_dir = upload_dir.resolve()
    staged: list[tuple[Path, Path]] = []
    try:
        for upload in uploads:
            original = _safe_upload_path(storage_dir, upload.storage_filename)
            if not original.exists():
                continue
            staged_path = storage_dir / f"{STAGING_PREFIX}{upload.id}__{upload.storage_filename}"
            os.replace(original, staged_path)
            staged.append((original, staged_path))
    except (OSError, UploadStorageDeletionError) as error:
        restore_staged_upload_files(staged)
        raise UploadStorageDeletionError from error
    return staged


def restore_staged_upload_files(staged: list[tuple[Path, Path]]) -> None:
    for original, staged_path in reversed(staged):
        if staged_path.exists():
            os.replace(staged_path, original)


def finalize_staged_upload_files(staged: list[tuple[Path, Path]]) -> None:
    for _, staged_path in staged:
        staged_path.unlink(missing_ok=True)


def recover_staged_upload_deletions(session_factory: sessionmaker, upload_dir: Path) -> None:
    """Restore staged files if metadata remains, otherwise finish a prior deletion."""
    storage_dir = upload_dir.resolve()
    if not storage_dir.exists():
        return
    with session_factory() as session:
        referenced_names = set(session.scalars(select(Upload.storage_filename)).all())

    for staged_path in storage_dir.glob(f"{STAGING_PREFIX}*"):
        parts = staged_path.name.split("__", maxsplit=2)
        if len(parts) != 3 or parts[0] != ".vic-delete":
            continue
        _, upload_id, storage_filename = parts
        if not upload_id or not storage_filename:
            continue
        original = _safe_upload_path(storage_dir, storage_filename)
        if storage_filename in referenced_names:
            if not original.exists():
                os.replace(staged_path, original)
            else:
                staged_path.unlink(missing_ok=True)
        else:
            staged_path.unlink(missing_ok=True)
