from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel

from app.schemas.records import UploadRead


class InspectionParseError(BaseModel):
    code: str
    message: str
    line: int | None = None
    column: int | None = None


class YamlNode(BaseModel):
    kind: Literal["mapping", "sequence", "scalar", "null", "redacted"]
    scalar_type: str | None = None
    value: Any = None
    entries: list[YamlEntry] = []
    items: list[YamlNode] = []


class YamlEntry(BaseModel):
    key: Any
    value: YamlNode


YamlNode.model_rebuild()


class YamlTreeRepresentation(BaseModel):
    kind: Literal["yaml_tree"] = "yaml_tree"
    root: YamlNode


class VicLine(BaseModel):
    line_number: int
    kind: Literal["blank", "comment", "entry"]
    raw: str
    option: str | None = None
    values: list[str] = []
    value_text: str | None = None


class VicTextRepresentation(BaseModel):
    kind: Literal["vic_parameter_lines"] = "vic_parameter_lines"
    lines: list[VicLine]


class RoutingLine(BaseModel):
    line_number: int
    raw: str


class RoutingRecord(BaseModel):
    heading: str | None = None
    heading_raw: str | None = None
    heading_line_number: int | None = None
    lines: list[RoutingLine]


class RoutingTextRepresentation(BaseModel):
    kind: Literal["routing_positional_records"] = "routing_positional_records"
    records: list[RoutingRecord]


class UnitHydrographRow(BaseModel):
    line_number: int
    index_token: str
    value_token: str
    index: int
    value: float


class UnitHydrographRepresentation(BaseModel):
    kind: Literal["unit_hydrograph_rows"] = "unit_hydrograph_rows"
    rows: list[UnitHydrographRow]


class NetCDFDimension(BaseModel):
    name: str
    size: int


class NetCDFNumericSummary(BaseModel):
    finite_count: int
    missing_count: int
    minimum: float | None
    maximum: float | None
    median: float | None


class NetCDFVariable(BaseModel):
    name: str
    dimensions: list[str]
    shape: list[int]
    data_type: str
    classification: Literal["numeric", "categorical", "other"]
    units: str | None = None
    attributes: dict[str, Any] = {}
    numeric_summary: NetCDFNumericSummary | None = None
    summary_status: Literal["complete", "limit_reached", "not_numeric"]
    is_coordinate: bool = False
    is_coordinate: bool = False


class NetCDFDatasetRepresentation(BaseModel):
    kind: Literal["netcdf_dataset"] = "netcdf_dataset"
    dimensions: list[NetCDFDimension]
    variables: list[NetCDFVariable]
    variable_count: int
    summary_limits: str
    attributes: dict[str, Any] = {}
    attributes: dict[str, Any] = {}


InspectionRepresentation = (
    YamlTreeRepresentation
    | VicTextRepresentation
    | RoutingTextRepresentation
    | UnitHydrographRepresentation
    | NetCDFDatasetRepresentation
)


class EditableParameterField(BaseModel):
    """A parameter that has explicit, server-approved editing metadata."""

    field_id: str
    label: str
    data_type: Literal["string", "integer", "number", "boolean"]
    current_value: Any
    required: bool = False
    minimum: int | float | None = None
    maximum: int | float | None = None
    allowed_values: list[Any] = []


class UploadInspectionRead(BaseModel):
    upload: UploadRead
    detected_format: Literal[
        "rat_yaml",
        "metsim_yaml",
        "vic_global_text",
        "routing_parameter_text",
        "unit_hydrograph_text",
        "vic_netcdf",
        "unknown",
    ]
    parse_status: Literal["parsed", "malformed", "unsupported"]
    parse_errors: list[InspectionParseError]
    rat_compatibility: Literal["not_checked"] = "not_checked"
    dependency_availability: Literal["not_checked"] = "not_checked"
    scientific_validity: Literal["not_checked"] = "not_checked"
    representation: InspectionRepresentation | None = None
    editable_fields: list[EditableParameterField] = []
