from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, StrictInt


class NetCDFValuesRead(BaseModel):
    variable: str
    dimensions: list[str]
    shape: list[int]
    selectors: list[int | None]
    indices: list[list[int]]
    values: list[Any]
    source_sha256: str
    has_more: bool = False
    varying_dimensions: list[str] = Field(default_factory=list)
    window_starts: list[int] = Field(default_factory=list)
    window_shape: list[int] = Field(default_factory=list)


class NetCDFValuesRequest(BaseModel):
    variable: str = Field(min_length=1, max_length=256)
    selectors: list[StrictInt | None] = Field(max_length=32)
    start: StrictInt = Field(default=0, ge=0)
    limit: StrictInt = Field(default=1000, ge=1, le=1000)
    window_starts: list[StrictInt] = Field(default_factory=list, max_length=2)
    window_limits: list[StrictInt] = Field(default_factory=list, max_length=2)


class NetCDFCellEdit(BaseModel):
    variable: str = Field(min_length=1, max_length=256)
    indices: list[StrictInt] = Field(min_length=0, max_length=32)
    value: Any


class NetCDFEditSave(BaseModel):
    source_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    edits: list[NetCDFCellEdit] = Field(min_length=1, max_length=500)
