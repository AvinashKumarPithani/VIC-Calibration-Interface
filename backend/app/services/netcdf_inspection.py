from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any

import netCDF4
import numpy as np

from app.models import Upload
from app.schemas.inspection import (
    NetCDFDatasetRepresentation,
    NetCDFDimension,
    NetCDFNumericSummary,
    NetCDFVariable,
    UploadInspectionRead,
)

MAX_DIMENSIONS = 32
MAX_VARIABLES = 512
MAX_ELEMENTS_PER_VARIABLE = 100_000
MAX_TOTAL_ELEMENTS = 1_000_000
MAX_ATTRIBUTES_PER_VARIABLE = 32
MAX_ATTRIBUTE_TEXT = 256
MAX_ATTRIBUTE_ARRAY_ITEMS = 32

# Candidate names supplied for discovery only; none are approved for editing.
POTENTIAL_CANDIDATE_NAMES = frozenset({
    "infilt", "ds", "dsmax", "ws", "depth", "ksat", "expt", "bubble",
    "init_moist", "wcr_fract", "wpwp_fract", "resid_moist", "root_depth",
    "root_fract", "lai", "cv",
})
_SENSITIVE_NAME = re.compile(r"secret|password|passwd|token|credential|api[_-]?key|private[_-]?key", re.I)
_PATH_VALUE = re.compile(r"(?:^|\s)(?:[A-Za-z]:[\\/]|/(?!/)|\\\\[^\\]+\\)", re.I)
_SECRET_VALUE = re.compile(r"(?:password|passwd|secret|token|credential)\s*[:=]", re.I)


class NetCDFInspectionError(ValueError):
    """Raised when a file is not a safe, supported NetCDF dataset."""


def _safe_attribute(value: Any, depth: int = 0) -> Any:
    if depth > 2:
        return "[nested attribute omitted]"
    if isinstance(value, np.ndarray):
        flattened = value.reshape(-1)
        result = [_safe_attribute(item, depth + 1) for item in flattened[:MAX_ATTRIBUTE_ARRAY_ITEMS]]
        if flattened.size > MAX_ATTRIBUTE_ARRAY_ITEMS:
            result.append("[additional values omitted]")
        return result
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    if isinstance(value, str):
        if _PATH_VALUE.search(value) or _SECRET_VALUE.search(value):
            return "[sensitive value omitted]"
        if len(value) > MAX_ATTRIBUTE_TEXT:
            return value[:MAX_ATTRIBUTE_TEXT] + "..."
        return value
    if isinstance(value, bool) or value is None or isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return value
    return str(value)[:MAX_ATTRIBUTE_TEXT]


def _variable_attributes(variable: Any) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name in variable.ncattrs()[:MAX_ATTRIBUTES_PER_VARIABLE]:
        if _SENSITIVE_NAME.search(name):
            continue
        if re.search(r"path|filename|file|directory|history|host|username", name, re.I):
            result[name] = "[omitted]"
            continue
        try:
            value = variable.getncattr(name)
        except (AttributeError, RuntimeError, TypeError):
            continue
        result[name] = _safe_attribute(value)
    return result


def _numeric_summary(data: Any) -> NetCDFNumericSummary:
    masked = np.ma.asarray(data)
    raw = np.asarray(masked.data).reshape(-1)
    mask = np.ma.getmaskarray(masked).reshape(-1)
    finite = np.isfinite(raw) & ~mask
    values = raw[finite].astype(np.float64, copy=False)
    missing_count = int(raw.size - values.size)
    if values.size == 0:
        return NetCDFNumericSummary(
            finite_count=0, missing_count=missing_count,
            minimum=None, maximum=None, median=None,
        )
    return NetCDFNumericSummary(
        finite_count=int(values.size),
        missing_count=missing_count,
        minimum=float(np.min(values)),
        maximum=float(np.max(values)),
        median=float(np.median(values)),
    )


def parse_netcdf_path(path: Path) -> NetCDFDatasetRepresentation:
    """Read NetCDF metadata and bounded numeric summaries without changing source bytes."""
    try:
        with netCDF4.Dataset(path, mode="r") as dataset:
            dimensions = list(dataset.dimensions.items())
            variables = list(dataset.variables.items())
            if len(dimensions) > MAX_DIMENSIONS:
                raise NetCDFInspectionError(f"The dataset exceeds the limit of {MAX_DIMENSIONS} dimensions.")
            if len(variables) > MAX_VARIABLES:
                raise NetCDFInspectionError(f"The dataset exceeds the limit of {MAX_VARIABLES} variables.")

            representation_dimensions = [
                NetCDFDimension(name=name, size=len(dimension))
                for name, dimension in dimensions
            ]
            remaining_budget = MAX_TOTAL_ELEMENTS
            represented_variables: list[NetCDFVariable] = []
            for name, variable in variables:
                shape = [int(size) for size in variable.shape]
                element_count = math.prod(shape) if shape else 1
                dtype = np.dtype(variable.dtype)
                is_enum = isinstance(variable.datatype, netCDF4.EnumType)
                is_vlen = isinstance(variable.datatype, netCDF4.VLType)
                is_numeric = np.issubdtype(dtype, np.number) and not np.issubdtype(dtype, np.bool_) and not is_enum
                classification = "numeric" if is_numeric else ("categorical" if is_enum or is_vlen or dtype.kind in "SUO" else "other")
                attributes = _variable_attributes(variable)
                units_value = attributes.get("units")
                units = units_value if isinstance(units_value, str) else None
                summary: NetCDFNumericSummary | None = None
                if not is_numeric:
                    summary_status = "not_numeric"
                elif element_count > MAX_ELEMENTS_PER_VARIABLE or element_count > remaining_budget:
                    summary_status = "limit_reached"
                else:
                    try:
                        summary = _numeric_summary(variable[...] if shape else variable.getValue())
                    except (RuntimeError, ValueError, TypeError, OSError) as error:
                        raise NetCDFInspectionError("A numeric variable could not be read safely.") from error
                    remaining_budget -= element_count
                    summary_status = "complete"
                represented_variables.append(NetCDFVariable(
                    name=name,
                    dimensions=list(variable.dimensions),
                    shape=shape,
                    data_type=str(dtype),
                    classification=classification,
                    units=units,
                    attributes=attributes,
                    numeric_summary=summary,
                    summary_status=summary_status,
                    potential_calibration_candidate=is_numeric and name.casefold() in POTENTIAL_CANDIDATE_NAMES,
                ))
            representation = NetCDFDatasetRepresentation(
                dimensions=representation_dimensions,
                variables=represented_variables,
                variable_count=len(represented_variables),
                summary_limits=(
                    f"Exact summaries are computed for variables up to {MAX_ELEMENTS_PER_VARIABLE:,} elements, "
                    f"within a {MAX_TOTAL_ELEMENTS:,}-element total inspection budget. Larger variables are listed without summaries."
                ),
            )
    except NetCDFInspectionError:
        raise
    except (OSError, RuntimeError, ValueError, TypeError) as error:
        raise NetCDFInspectionError("The uploaded file is not a readable NetCDF dataset.") from error

    return representation


def inspect_netcdf_path(upload: Upload, path: Path) -> UploadInspectionRead:
    representation = parse_netcdf_path(path)
    return UploadInspectionRead(
        upload=upload,
        detected_format="vic_netcdf",
        parse_status="parsed",
        parse_errors=[],
        rat_compatibility="not_checked",
        dependency_availability="not_checked",
        scientific_validity="not_checked",
        representation=representation,
        editable_fields=[],
    )
