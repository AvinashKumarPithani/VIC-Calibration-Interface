from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from fastapi import UploadFile

ALLOWED_FILE_EXTENSIONS = frozenset({".yaml", ".yml", ".json", ".txt", ".csv", ".zip", ".nc"})
CONFIGURATION_INPUT_CATEGORY = "configuration_input"
NETCDF_PARAMETER_DATASET_CATEGORY = "netcdf_parameter_dataset"
LEGACY_UNCLASSIFIED_CATEGORY = "legacy_unclassified"
RAT_CONFIGURATION_FILENAMES = frozenset({"rat_config.yaml", "rat_config.yml", "rat_config_template.yaml", "rat_config_template.yml"})
CHUNK_SIZE_BYTES = 64 * 1024


def is_rat_configuration_filename(filename: str) -> bool:
    return filename.lower() in RAT_CONFIGURATION_FILENAMES


class InvalidUploadName(Exception):
    pass


class UnsupportedUploadType(Exception):
    pass


class EmptyUpload(Exception):
    pass


class UploadTooLarge(Exception):
    pass


def safe_original_filename(filename: str | None) -> str:
    # Treat both slash styles as separators, even when the API runs on Windows.
    name = (filename or "").replace("\\", "/").rsplit("/", maxsplit=1)[-1]
    name = "".join(character for character in name if character.isprintable()).strip()
    if not name or name in {".", ".."} or len(name) > 255:
        raise InvalidUploadName
    return name


async def store_upload(
    upload: UploadFile,
    storage_dir: Path,
    max_size_bytes: int,
) -> tuple[str, str, int]:
    original_filename = safe_original_filename(upload.filename)
    extension = Path(original_filename).suffix.lower()
    if extension not in ALLOWED_FILE_EXTENSIONS:
        raise UnsupportedUploadType

    storage_dir.mkdir(parents=True, exist_ok=True)
    storage_filename = f"{uuid4().hex}{extension}"
    storage_path = storage_dir / storage_filename
    file_size = 0

    try:
        with storage_path.open("xb") as destination:
            while chunk := await upload.read(CHUNK_SIZE_BYTES):
                file_size += len(chunk)
                if file_size > max_size_bytes:
                    raise UploadTooLarge
                destination.write(chunk)
        if file_size == 0:
            raise EmptyUpload
    except Exception:
        storage_path.unlink(missing_ok=True)
        raise

    return original_filename, storage_filename, file_size
