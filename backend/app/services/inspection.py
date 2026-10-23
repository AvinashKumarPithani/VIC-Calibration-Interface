from __future__ import annotations

import math
import re
from collections.abc import Mapping
from datetime import date, datetime
from pathlib import Path, PureWindowsPath
from typing import Any

import yaml
from fastapi import HTTPException
from yaml.constructor import ConstructorError
from yaml.nodes import MappingNode

from app.models import Upload
from app.schemas.inspection import (
    InspectionParseError,
    RoutingLine,
    RoutingRecord,
    RoutingTextRepresentation,
    UnitHydrographRepresentation,
    UnitHydrographRow,
    UploadInspectionRead,
    VicLine,
    VicTextRepresentation,
    YamlEntry,
    YamlNode,
    YamlTreeRepresentation,
)
from app.services.uploads import RAT_CONFIGURATION_FILENAMES


class UniqueKeySafeLoader(yaml.SafeLoader):
    """Safe YAML loader that rejects duplicate mapping keys instead of losing data."""


def _construct_unique_mapping(loader: UniqueKeySafeLoader, node: MappingNode, deep: bool = False) -> dict[Any, Any]:
    if not isinstance(node, MappingNode):
        raise ConstructorError(None, None, "expected a mapping node", node.start_mark)
    result: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        try:
            duplicate = key in result
        except TypeError as exc:
            raise ConstructorError(None, None, "unhashable mapping key", key_node.start_mark) from exc
        if duplicate:
            raise ConstructorError(None, None, "duplicate mapping key", key_node.start_mark)
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


UniqueKeySafeLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    _construct_unique_mapping,
)

_SECRET_KEY = re.compile(r"(?:secret|password|passwd|passphrase|token|credential|api[_-]?key|access[_-]?key|private[_-]?key)", re.I)
_RAT_SECTIONS = {
    "GLOBAL", "BASIN", "METSIM", "VIC", "VIC PARAMETERS", "ROUTING",
    "ROUTING PARAMETERS", "GEE", "ALTIMETER", "POST_PROCESSING", "CLEAN_UP",
    "CONFIDENTIAL", "PLUGINS",
}


def read_stored_upload(upload: Upload, storage_dir: Path) -> bytes:
    """Read an upload only when its generated storage name resolves inside storage_dir."""
    root = storage_dir.resolve()
    stored_name = upload.storage_filename
    if (
        Path(stored_name).name != stored_name
        or PureWindowsPath(stored_name).name != stored_name
        or Path(stored_name).is_absolute()
        or PureWindowsPath(stored_name).is_absolute()
    ):
        raise HTTPException(status_code=500, detail="Stored upload location is invalid.")

    path = (root / stored_name).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=500, detail="Stored upload location is invalid.") from None
    try:
        return path.read_bytes()
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Uploaded file content is unavailable.") from None
    except OSError:
        raise HTTPException(status_code=500, detail="Uploaded file content could not be read.") from None


def inspect_upload_content(upload: Upload, content: bytes) -> UploadInspectionRead:
    filename = PureWindowsPath(upload.original_filename).name.lower()
    expected_format = _format_from_filename(filename)
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        return _result(upload, expected_format or "unknown", "malformed", [
            InspectionParseError(code="invalid_encoding", message="The uploaded text file is not valid UTF-8.")
        ])

    if filename.endswith((".yaml", ".yml")):
        return _inspect_yaml(upload, filename, text, expected_format)
    if expected_format == "vic_global_text":
        representation = _parse_vic_text(text)
        entries = [line for line in representation.lines if line.kind == "entry"]
        has_entries = bool(entries)
        missing_values = [line for line in entries if not line.values]
        errors = [InspectionParseError(
            code="missing_vic_values",
            message=f"VIC option at line {line.line_number} has no value tokens.",
            line=line.line_number,
        ) for line in missing_values]
        if not has_entries:
            errors.append(InspectionParseError(
                code="no_vic_entries",
                message="No VIC option/value entries were found.",
            ))
        return _result(upload, expected_format, "parsed" if has_entries and not errors else "malformed", errors, representation)
    if expected_format == "routing_parameter_text":
        representation = _parse_routing_text(text)
        has_records = any(record.heading_raw is not None and record.lines for record in representation.records)
        errors = [] if has_records else [InspectionParseError(
            code="routing_records_not_found",
            message="No comment-delimited routing headings with positional values were found.",
        )]
        return _result(upload, expected_format, "parsed" if has_records else "malformed", errors, representation)
    if expected_format == "unit_hydrograph_text":
        representation, errors = _parse_hydrograph(text)
        return _result(upload, expected_format, "malformed" if errors else "parsed", errors, representation)

    return _result(upload, "unknown", "unsupported", [
        InspectionParseError(code="unsupported_format", message="This filename or file format is not supported for inspection.")
    ])


def _format_from_filename(filename: str) -> str | None:
    if filename in RAT_CONFIGURATION_FILENAMES:
        return "rat_yaml"
    if filename == "vic_params.txt":
        return "vic_global_text"
    if filename == "route_param.txt":
        return "routing_parameter_text"
    if filename == "uh.txt":
        return "unit_hydrograph_text"
    return None


def _inspect_yaml(
    upload: Upload,
    filename: str,
    text: str,
    expected_format: str | None,
) -> UploadInspectionRead:
    try:
        document = yaml.load(text, Loader=UniqueKeySafeLoader)
    except yaml.YAMLError as error:
        mark = getattr(error, "problem_mark", None)
        details = []
        if mark is not None:
            details = [InspectionParseError(
                code="invalid_yaml",
                message=f"Invalid YAML syntax at line {mark.line + 1}, column {mark.column + 1}.",
                line=mark.line + 1,
                column=mark.column + 1,
            )]
        if not details:
            details = [InspectionParseError(code="invalid_yaml", message="Invalid YAML syntax.")]
        inferred_format = expected_format or ("metsim_yaml" if filename == "params.yaml" else "unknown")
        return _result(upload, inferred_format, "malformed", details)

    # Filenames provide context for malformed-file errors, but never establish
    # that arbitrary valid YAML is a RAT or MetSim configuration.
    actual_format = None
    if isinstance(document, Mapping):
        keys = {str(key).strip().upper() for key in document}
        looks_like_metsim = "METSIM" in keys and "CHUNKS" in keys
        looks_like_rat = {"GLOBAL", "BASIN"}.issubset(keys)
        if looks_like_metsim and looks_like_rat:
            return _result(upload, "unknown", "unsupported", [
                InspectionParseError(code="ambiguous_format", message="The YAML document matches more than one supported configuration structure.")
            ])
        if looks_like_metsim:
            actual_format = "metsim_yaml"
        elif looks_like_rat:
            actual_format = "rat_yaml"
    if actual_format is None:
        return _result(upload, "unknown", "unsupported", [
            InspectionParseError(code="unsupported_format", message="The YAML document is valid but is not a recognized RAT or MetSim configuration.")
        ])

    try:
        secret_container_ids, secret_scalars = _collect_secret_values(document)
        root = _yaml_node(document, set(), secret_container_ids, secret_scalars)
    except ValueError as error:
        return _result(upload, actual_format, "unsupported", [
            InspectionParseError(code="unsupported_yaml_structure", message=str(error))
        ])
    return _result(upload, actual_format, "parsed", [], YamlTreeRepresentation(root=root))


def _collect_secret_values(document: Any) -> tuple[set[int], set[tuple[type, str]]]:
    secret_container_ids: set[int] = set()
    secret_scalars: set[tuple[type, str]] = set()
    visited: set[tuple[int, bool]] = set()

    def visit(value: Any, is_secret: bool = False) -> None:
        identity = id(value)
        marker = (identity, is_secret)
        if marker in visited:
            return
        visited.add(marker)
        if isinstance(value, Mapping):
            if is_secret:
                secret_container_ids.add(identity)
            for key, child in value.items():
                child_is_secret = (
                    is_secret
                    or _SECRET_KEY.search(str(key)) is not None
                    or str(key).strip().upper() == "CONFIDENTIAL"
                )
                visit(child, child_is_secret)
        elif isinstance(value, (list, tuple)):
            if is_secret:
                secret_container_ids.add(identity)
            for child in value:
                visit(child, is_secret)
        elif is_secret:
            secret_scalars.add((type(value), repr(value)))

    visit(document)
    return secret_container_ids, secret_scalars


def _yaml_node(
    value: Any,
    ancestors: set[int],
    secret_container_ids: set[int],
    secret_scalars: set[tuple[type, str]],
) -> YamlNode:
    if id(value) in secret_container_ids or (
        not isinstance(value, (Mapping, list, tuple))
        and (type(value), repr(value)) in secret_scalars
    ):
        return YamlNode(kind="redacted", scalar_type="redacted", value="[REDACTED]")
    if value is None:
        return YamlNode(kind="null", scalar_type="null", value=None)
    if isinstance(value, Mapping):
        identity = id(value)
        if identity in ancestors:
            raise ValueError("Recursive YAML aliases are not supported for inspection.")
        next_ancestors = ancestors | {identity}
        entries = []
        for key, child in value.items():
            safe_key = _json_scalar(key)[0]
            if (type(key), repr(key)) in secret_scalars:
                safe_key = "[REDACTED]"
            if _SECRET_KEY.search(str(key)) or str(key).strip().upper() == "CONFIDENTIAL":
                entries.append(YamlEntry(key=safe_key, value=YamlNode(kind="redacted", scalar_type="redacted", value="[REDACTED]")))
            else:
                entries.append(YamlEntry(
                    key=safe_key,
                    value=_yaml_node(child, next_ancestors, secret_container_ids, secret_scalars),
                ))
        return YamlNode(kind="mapping", entries=entries)
    if isinstance(value, (list, tuple)):
        identity = id(value)
        if identity in ancestors:
            raise ValueError("Recursive YAML aliases are not supported for inspection.")
        next_ancestors = ancestors | {identity}
        return YamlNode(kind="sequence", items=[
            _yaml_node(item, next_ancestors, secret_container_ids, secret_scalars) for item in value
        ])
    scalar, scalar_type = _json_scalar(value)
    return YamlNode(kind="scalar", scalar_type=scalar_type, value=scalar)


def _json_scalar(value: Any) -> tuple[Any, str]:
    if isinstance(value, bool):
        return value, "boolean"
    if isinstance(value, int):
        return value, "integer"
    if isinstance(value, float):
        return (value, "number") if math.isfinite(value) else (str(value), "non_finite_number")
    if isinstance(value, datetime):
        return value.isoformat(), "datetime"
    if isinstance(value, date):
        return value.isoformat(), "date"
    if isinstance(value, str):
        return value, "string"
    if value is None:
        return None, "null"
    raise ValueError("This YAML scalar type is not supported for inspection.")


def _parse_vic_text(text: str) -> VicTextRepresentation:
    lines: list[VicLine] = []
    for number, raw in enumerate(text.splitlines(), start=1):
        stripped = raw.strip()
        if not stripped:
            lines.append(VicLine(line_number=number, kind="blank", raw=raw))
        elif stripped.startswith("#"):
            lines.append(VicLine(line_number=number, kind="comment", raw=raw))
        else:
            match = re.match(r"^\s*(\S+)(?:\s+(.*?))?\s*$", raw)
            if match is None:
                lines.append(VicLine(line_number=number, kind="comment", raw=raw))
            else:
                value_text = match.group(2) or ""
                lines.append(VicLine(
                    line_number=number,
                    kind="entry",
                    raw=raw,
                    option=match.group(1),
                    values=value_text.split(),
                    value_text=value_text,
                ))
    return VicTextRepresentation(lines=lines)


def _parse_routing_text(text: str) -> RoutingTextRepresentation:
    records: list[RoutingRecord] = []
    heading: str | None = None
    heading_raw: str | None = None
    heading_line_number: int | None = None
    lines: list[RoutingLine] = []

    def flush() -> None:
        nonlocal heading, heading_raw, heading_line_number, lines
        if heading_raw is not None or lines:
            records.append(RoutingRecord(
                heading=heading,
                heading_raw=heading_raw,
                heading_line_number=heading_line_number,
                lines=lines,
            ))
        heading = None
        heading_raw = None
        heading_line_number = None
        lines = []

    for number, raw in enumerate(text.splitlines(), start=1):
        stripped = raw.strip()
        if stripped.startswith("#"):
            flush()
            heading = stripped[1:].strip() or None
            heading_raw = raw
            heading_line_number = number
        else:
            lines.append(RoutingLine(line_number=number, raw=raw))
    flush()
    return RoutingTextRepresentation(records=records)


def _parse_hydrograph(text: str) -> tuple[UnitHydrographRepresentation, list[InspectionParseError]]:
    rows: list[UnitHydrographRow] = []
    errors: list[InspectionParseError] = []
    for number, raw in enumerate(text.splitlines(), start=1):
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        tokens = stripped.split()
        if len(tokens) != 2:
            errors.append(InspectionParseError(
                code="invalid_hydrograph_row",
                message=f"Expected two numeric columns on line {number}.",
                line=number,
            ))
            continue
        try:
            index = int(tokens[0])
            value = float(tokens[1])
            if not math.isfinite(value):
                raise ValueError
        except ValueError:
            errors.append(InspectionParseError(
                code="invalid_hydrograph_row",
                message=f"Expected an integer index and finite numeric value on line {number}.",
                line=number,
            ))
            continue
        rows.append(UnitHydrographRow(
            line_number=number,
            index_token=tokens[0],
            value_token=tokens[1],
            index=index,
            value=value,
        ))
    if not rows and not errors:
        errors.append(InspectionParseError(code="empty_hydrograph", message="No numerical rows were found."))
    return UnitHydrographRepresentation(rows=rows), errors


def _result(
    upload: Upload,
    detected_format: str,
    parse_status: str,
    errors: list[InspectionParseError],
    representation: Any = None,
) -> UploadInspectionRead:
    return UploadInspectionRead(
        upload=upload,
        detected_format=detected_format,
        parse_status=parse_status,
        parse_errors=errors,
        representation=representation,
    )
