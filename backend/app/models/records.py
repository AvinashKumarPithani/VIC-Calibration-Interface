from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, ForeignKeyConstraint, Index, JSON, String, Text, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.services.uploads import LEGACY_UNCLASSIFIED_CATEGORY, RAT_CONFIGURATION_FILENAMES


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    modified_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    jobs: Mapped[list["Job"]] = relationship(back_populates="project", cascade="all, delete-orphan")


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (UniqueConstraint("id", "project_id", name="uq_jobs_id_project"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    modified_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    project: Mapped[Project] = relationship(back_populates="jobs")
    uploads: Mapped[list["Upload"]] = relationship(back_populates="job", cascade="all, delete-orphan")


class Upload(Base):
    __tablename__ = "uploads"
    __table_args__ = (
        ForeignKeyConstraint(
            ["job_id", "project_id"],
            ["jobs.id", "jobs.project_id"],
            ondelete="CASCADE",
            name="fk_uploads_job_project",
        ),
        Index(
            "uq_uploads_one_rat_configuration_per_job",
            "project_id",
            "job_id",
            unique=True,
            sqlite_where=text(
                "lower(original_filename) IN "
                "('rat_config.yaml', 'rat_config.yml', 'rat_config_template.yaml', 'rat_config_template.yml')"
            ),
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    job_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    upload_category: Mapped[str] = mapped_column(
        String(40), nullable=False, default=LEGACY_UNCLASSIFIED_CATEGORY,
        server_default=text("'legacy_unclassified'"),
    )
    storage_filename: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    source_upload_id: Mapped[str | None] = mapped_column(ForeignKey("uploads.id", ondelete="SET NULL"), nullable=True, index=True)
    file_size: Mapped[int] = mapped_column(nullable=False)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    job: Mapped[Job] = relationship(back_populates="uploads")
    parameter_draft: Mapped["ParameterDraft | None"] = relationship(back_populates="upload", cascade="all, delete-orphan", uselist=False)


class ParameterDraft(Base):
    """A revisioned overlay tied to one immutable uploaded source file."""

    __tablename__ = "parameter_drafts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True)
    source_upload_id: Mapped[str] = mapped_column(ForeignKey("uploads.id", ondelete="CASCADE"), nullable=False, unique=True, index=True)
    source_format: Mapped[str] = mapped_column(String(40), nullable=False)
    source_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    revision: Mapped[int] = mapped_column(nullable=False, default=1)
    changes: Mapped[list[dict]] = mapped_column(JSON, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    upload: Mapped[Upload] = relationship(back_populates="parameter_draft")


RAT_CONFIGURATION_UNIQUE_INDEX = next(
    index for index in Upload.__table__.indexes
    if index.name == "uq_uploads_one_rat_configuration_per_job"
)
