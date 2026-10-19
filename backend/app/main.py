from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI
from sqlalchemy import create_engine, event
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

from app.api.routes import router
from app.core.config import Settings
from app.db import Base
from app import models as _models  # noqa: F401 - registers ORM models with Base metadata.


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
        yield
        engine.dispose()

    app = FastAPI(
        title="VIC Calibration Interface API",
        version="0.1.0",
        description="Local project, job, and upload metadata API. Scientific workflows are not executed.",
        lifespan=lifespan,
    )
    app.state.settings = app_settings
    app.state.engine = engine
    app.state.session_factory = session_factory
    app.include_router(router)
    return app


app = create_app()
