from __future__ import annotations

import math
from typing import Any

from fastapi import HTTPException, status

from app.schemas.inspection import EditableParameterField, UploadInspectionRead
from app.schemas.parameter_drafts import ParameterDraftChange


def approved_fields_for_inspection(_inspection: UploadInspectionRead) -> list[EditableParameterField]:
    """Return only fields with explicit, project-approved metadata.

    This project has not approved a calibration parameter catalogue yet, so
    every supported file currently remains read-only.
    """
    return []


def validate_draft_changes(
    inspection: UploadInspectionRead, changes: list[ParameterDraftChange]
) -> list[dict[str, Any]]:
    approved = {field.field_id: field for field in approved_fields_for_inspection(inspection)}
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for change in changes:
        field = approved.get(change.field_id)
        if field is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="This parameter has no approved editing rules and remains read-only.",
            )
        if change.field_id in seen:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="A parameter may appear only once in a draft.")
        seen.add(change.field_id)
        validators = {
            "string": lambda value: isinstance(value, str),
            "integer": lambda value: isinstance(value, int) and not isinstance(value, bool),
            "number": lambda value: isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value),
            "boolean": lambda value: isinstance(value, bool),
        }
        if not validators[field.data_type](change.value):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=f"{field.label} must be a {field.data_type} value.")
        if field.required and change.value == "":
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=f"{field.label} is required.")
        if field.allowed_values and change.value not in field.allowed_values:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=f"{field.label} is not an allowed value.")
        if isinstance(change.value, (int, float)) and not isinstance(change.value, bool):
            if field.minimum is not None and change.value < field.minimum:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=f"{field.label} is below its approved minimum.")
            if field.maximum is not None and change.value > field.maximum:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=f"{field.label} is above its approved maximum.")
        normalized.append({"field_id": change.field_id, "value": change.value})
    return normalized

