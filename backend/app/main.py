from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import sessionmaker

from app.api.routes import router
from app.core.config import Settings
from app.db import Base
from app import models as _models  # noqa: F401 - registers ORM models with Base metadata.
from app.models.records import RAT_CONFIGURATION_UNIQUE_INDEX
from app.services.record_deletion import recover_staged_upload_deletions


def install_sqlite_upload_filename_enforcement(engine: Engine) -> None:
    """Install repeatable trigger enforcement without rewriting legacy upload rows."""
    with engine.begin() as connection:
        # Older versions may have created this index. It cannot coexist with legacy
        # duplicate names, so replace it with an insert-time rule that preserves them.
        connection.exec_driver_sql("DROP INDEX IF EXISTS uq_uploads_job_original_filename")
        connection.exec_driver_sql(
            """
            CREATE TRIGGER IF NOT EXISTS trg_uploads_unique_job_filename_insert
            BEFORE INSERT ON uploads
            FOR EACH ROW
            WHEN EXISTS (
                SELECT 1 FROM uploads
                WHERE project_id = NEW.project_id
                  AND job_id = NEW.job_id
                  AND original_filename = NEW.original_filename
            )
            BEGIN
                SELECT RAISE(ABORT, 'duplicate upload filename for job');
            END
            """
        )
        connection.exec_driver_sql(
            """
            CREATE TRIGGER IF NOT EXISTS trg_uploads_unique_job_filename_update
            BEFORE UPDATE OF project_id, job_id, original_filename ON uploads
            FOR EACH ROW
            WHEN EXISTS (
                SELECT 1 FROM uploads
                WHERE project_id = NEW.project_id
                  AND job_id = NEW.job_id
                  AND original_filename = NEW.original_filename
                  AND id <> OLD.id
            )
            BEGIN
                SELECT RAISE(ABORT, 'duplicate upload filename for job');
            END
            """
        )


def create_app(settings: Settings | None = None) -> FastAPI:
    app_settings = settings or Settings.from_environment()
    url = make_url(app_settings.database_url)
    connect_args = {"check_same_thread": False} if url.get_backend_name() == "sqlite" else {}

    if url.get_backend_name() == "sqlite" and url.database not in (None, "", ":memory:"):
        Path(url.database).expanduser().parent.mkdir(parents=True, exist_ok=True)

    engine = create_engine(app_settings.database_url, connect_args=connect_args, pool_pre_ping=True)
    if url.get_backend_name() == "sqlite":
        @event.listens_for(engine, "connect")
        def enable_sqlite_foreign_keys(connection, _record) -> None:
            cursor = connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    session_factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        app_settings.upload_dir.mkdir(parents=True, exist_ok=True)
        Base.metadata.create_all(bind=engine)
        if engine.dialect.name == "sqlite":
            RAT_CONFIGURATION_UNIQUE_INDEX.create(bind=engine, checkfirst=True)
            install_sqlite_upload_filename_enforcement(engine)
        recover_staged_upload_deletions(session_factory, app_settings.upload_dir)
        yield
        engine.dispose()

    app = FastAPI(
        title="VIC Calibration Interface API",
        version="0.1.0",
        description="Local project, job, and upload metadata API. Scientific workflows are not executed.",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Accept", "Content-Type"],
    )
    app.state.settings = app_settings
    app.state.engine = engine
    app.state.session_factory = session_factory
    app.include_router(router)
    return app


app = create_app()
