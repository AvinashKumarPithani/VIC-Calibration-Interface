from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=500)

    @field_validator("name", mode="before")
    @classmethod
    def trim_name(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class ProjectRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    description: str | None
    created_at: datetime
    modified_at: datetime


class JobCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=500)

    @field_validator("name", mode="before")
    @classmethod
    def trim_name(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class JobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str
    name: str
    description: str | None
    created_at: datetime
    modified_at: datetime


class UploadRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str
    job_id: str
    original_filename: str
    upload_category: Literal["configuration_input", "netcdf_parameter_dataset", "legacy_unclassified"]
    file_size: int
    uploaded_at: datetime
    source_upload_id: str | None = None


UploadCategory = Literal["configuration_input", "netcdf_parameter_dataset", "legacy_unclassified"]
