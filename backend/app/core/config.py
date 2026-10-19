from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    database_url: str
    upload_dir: Path
    max_upload_size_bytes: int

    @classmethod
    def from_environment(cls) -> "Settings":
        load_dotenv(BACKEND_DIR / ".env", override=False)

        default_database_path = BACKEND_DIR / "storage" / "vic_calibration.db"
        default_upload_dir = BACKEND_DIR / "storage" / "uploads"
        database_url = os.getenv(
            "DATABASE_URL",
            f"sqlite:///{default_database_path.as_posix()}",
        )
        upload_dir = Path(os.getenv("UPLOAD_DIR", str(default_upload_dir))).expanduser().resolve()

        try:
            max_upload_size_bytes = int(os.getenv("MAX_UPLOAD_SIZE_BYTES", str(10 * 1024 * 1024)))
        except ValueError as exc:
            raise ValueError("MAX_UPLOAD_SIZE_BYTES must be a positive integer.") from exc
        if max_upload_size_bytes <= 0:
            raise ValueError("MAX_UPLOAD_SIZE_BYTES must be a positive integer.")

        return cls(
            database_url=database_url,
            upload_dir=upload_dir,
            max_upload_size_bytes=max_upload_size_bytes,
        )
