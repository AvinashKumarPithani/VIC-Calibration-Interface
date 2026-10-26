from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ParameterDraftChange(BaseModel):
    field_id: str = Field(min_length=1, max_length=500)
    value: Any


class ParameterDraftSave(BaseModel):
    expected_revision: int | None = Field(default=None, ge=1)
    source_format: Literal[
        "rat_yaml", "metsim_yaml", "vic_global_text", "routing_parameter_text", "unit_hydrograph_text"
    ]
    changes: list[ParameterDraftChange] = Field(min_length=1)


class ParameterDraftRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str
    job_id: str
    source_upload_id: str
    source_format: str
    revision: int
    changes: list[ParameterDraftChange]
    created_at: datetime
    updated_at: datetime
