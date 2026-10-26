from __future__ import annotations

import hashlib
import math
import os
from pathlib import Path
from typing import Any
from uuid import uuid4

import numpy as np
import netCDF4
import xarray as xr

MAX_VALUE_CELLS = 1000
_NETCDF_ENCODING_KEYS = frozenset({
    "dtype", "_FillValue", "zlib", "complevel", "fletcher32", "contiguous", "chunksizes",
    "shuffle", "least_significant_digit", "compression", "significant_digits", "quantize_mode",
    "endian", "szip", "szip_coding", "szip_pixels_per_block", "zstd", "bzip2", "blosc",
    "blosc_shuffle",
})


class NetCDFEditError(ValueError):
    pass


def fingerprint(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _open(path: Path) -> xr.Dataset:
    try:
        return xr.open_dataset(path, engine="netcdf4", decode_cf=False, mask_and_scale=False, decode_times=False)
    except Exception as error:
        raise NetCDFEditError("This NetCDF encoding cannot be opened safely for value editing.") from error


def _json_value(value: Any) -> Any:
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _same_attributes(left: dict[str, Any], right: dict[str, Any]) -> bool:
    if left.keys() != right.keys():
        return False
    for key in left:
        try:
            np.testing.assert_equal(np.asarray(left[key]), np.asarray(right[key]))
        except (AssertionError, TypeError, ValueError):
            return False
    return True


def read_values(path: Path, name: str, selectors: list[int | None], start: int = 0, limit: int = MAX_VALUE_CELLS,
                window_starts: list[int] | None = None, window_limits: list[int] | None = None) -> dict[str, Any]:
    sha = fingerprint(path)
    try:
        with _open(path) as dataset:
            if name not in dataset.data_vars:
                raise NetCDFEditError("Select a data variable. Coordinates are read-only.")
            variable = dataset[name]
            shape = list(variable.shape)
            if len(selectors) != len(shape):
                raise NetCDFEditError("The selector count does not match the variable dimensions.")
            fixed: dict[str, int] = {}
            for dimension, size, selector in zip(variable.dims, shape, selectors):
                if selector is not None:
                    if isinstance(selector, bool) or selector < 0 or selector >= size:
                        raise NetCDFEditError("A selected index is outside the variable shape.")
                    fixed[dimension] = selector
            remaining_dims = [dimension for dimension in variable.dims if dimension not in fixed]
            remaining_shape = [shape[variable.dims.index(dimension)] for dimension in remaining_dims]
            count = math.prod(remaining_shape) if remaining_shape else 1
            has_more = False
            starts = list(window_starts or [])
            limits = list(window_limits or [])
            if len(remaining_dims) > 2:
                raise NetCDFEditError("Fix dimensions until at most two vary to browse a table or grid.")
            if len(remaining_dims) == 2:
                if not starts:
                    starts = [0, 0]
                if not limits:
                    limits = [min(20, remaining_shape[0]), min(20, remaining_shape[1])]
                if len(starts) != 2 or len(limits) != 2 or any(i < 0 for i in starts) or any(i < 1 for i in limits):
                    raise NetCDFEditError("Provide valid starts and positive limits for both varying dimensions.")
                if limits[0] * limits[1] > MAX_VALUE_CELLS:
                    raise NetCDFEditError(f"Each grid window is limited to {MAX_VALUE_CELLS} cells.")
                for axis, dimension in enumerate(remaining_dims):
                    size = shape[variable.dims.index(dimension)]
                    if starts[axis] >= size:
                        raise NetCDFEditError("The requested grid window starts beyond the dimension shape.")
                    fixed[dimension] = slice(starts[axis], min(starts[axis] + limits[axis], size))
                    has_more = has_more or starts[axis] + limits[axis] < size
            elif count > limit:
                if len(remaining_dims) != 1:
                    raise NetCDFEditError("Select indices until at most two dimensions vary.")
                dimension = remaining_dims[0]
                size = shape[variable.dims.index(dimension)]
                fixed[dimension] = slice(start, min(start + limit, size))
                has_more = start + limit < size
            elif start:
                raise NetCDFEditError("The requested page starts beyond the end of this view.")
            view = variable.isel(fixed)
            values = np.asarray(view.values)
            if values.size > limit:
                raise NetCDFEditError(f"Each view is limited to {limit} values.")
            rows = []
            for local_index in np.ndindex(values.shape):
                local = dict(zip(remaining_dims, local_index))
                rows.append([
                    (int(fixed[dim].start or 0) + local.get(dim, 0)) if isinstance(fixed.get(dim), slice)
                    else local.get(dim, fixed.get(dim, 0))
                    for dim in variable.dims
                ])
            if values.ndim == 0:
                rows = [[]]
                raw_values = [values.item()]
            else:
                raw_values = values.reshape(-1).tolist()
            fill = variable.encoding.get("_FillValue", variable.attrs.get("_FillValue"))
            def display_value(value: Any) -> Any:
                if fill is not None:
                    try:
                        if value == fill:
                            return None
                    except (TypeError, ValueError):
                        pass
                return _json_value(value)
            actual_starts = [int(fixed[dim].start or 0) if isinstance(fixed.get(dim), slice) else 0 for dim in remaining_dims]
            window_shape = [int(values.shape[axis]) for axis in range(values.ndim)] if values.ndim else []
            return {"variable": name, "dimensions": list(variable.dims), "shape": shape,
                    "selectors": selectors, "indices": rows, "values": [display_value(v) for v in raw_values],
                    "source_sha256": sha, "has_more": has_more, "varying_dimensions": remaining_dims,
                    "window_starts": actual_starts, "window_shape": window_shape}
    except NetCDFEditError:
        raise
    except Exception as error:
        raise NetCDFEditError("Values could not be read from this NetCDF variable.") from error


def save_edits(source: Path, output: Path, expected_sha: str, edits: list[Any]) -> None:
    if fingerprint(source) != expected_sha:
        raise NetCDFEditError("The source file changed. Reload it before saving edits.")
    temporary = output.with_name(f".{uuid4().hex}.tmp.nc")
    try:
        with netCDF4.Dataset(source, mode="r") as source_file:
            source_format = source_file.data_model
            if source_file.groups:
                raise NetCDFEditError("Editing grouped NetCDF datasets is not supported; no output was written.")
            if any(isinstance(variable.datatype, (netCDF4.EnumType, netCDF4.VLType, netCDF4.CompoundType)) for variable in source_file.variables.values()):
                raise NetCDFEditError("This dataset uses enum, variable-length, or compound types that cannot be safely rewritten.")
        supported_formats = {"NETCDF4", "NETCDF4_CLASSIC", "NETCDF3_CLASSIC", "NETCDF3_64BIT_OFFSET", "NETCDF3_64BIT_DATA"}
        if source_format not in supported_formats:
            raise NetCDFEditError("This NetCDF data model cannot be preserved by the available xarray engine.")
        with _open(source) as opened:
            dataset = opened.load()
        if fingerprint(source) != expected_sha:
            raise NetCDFEditError("The source file changed while it was being prepared. Reload before saving.")
        seen: set[tuple[str, tuple[int, ...]]] = set()
        for edit in edits:
            if edit.variable not in dataset.data_vars:
                raise NetCDFEditError("Edits may target data variables only.")
            variable = dataset[edit.variable]
            index = tuple(edit.indices)
            if len(index) != variable.ndim or any(isinstance(i, bool) or i < 0 or i >= variable.shape[axis] for axis, i in enumerate(index)):
                raise NetCDFEditError("An edit index does not match the variable shape.")
            key = (edit.variable, index)
            if key in seen:
                raise NetCDFEditError("An edit batch contains duplicate cell indices.")
            seen.add(key)
            dtype = variable.dtype
            value = edit.value
            if value is None:
                fill = variable.encoding.get("_FillValue", variable.attrs.get("_FillValue"))
                if fill is None:
                    raise NetCDFEditError("This variable has no missing-value marker; a missing value cannot be written.")
                value = fill
            if dtype.kind in "iu":
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)) or float(value) != int(value):
                    raise NetCDFEditError("An integer variable requires a whole-number value.")
                limits = np.iinfo(dtype)
                if not limits.min <= int(value) <= limits.max:
                    raise NetCDFEditError("The value cannot be represented in the variable data type.")
            elif dtype.kind == "f":
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    raise NetCDFEditError("A numeric variable requires a numeric value.")
                with np.errstate(over="ignore", invalid="ignore"):
                    converted = np.asarray(value, dtype=dtype).item()
                if math.isfinite(float(value)) and not math.isfinite(float(converted)):
                    raise NetCDFEditError("The value cannot be represented in the variable data type.")
                value = converted
            elif dtype.kind in "SUO":
                if not isinstance(value, str):
                    raise NetCDFEditError("A text variable requires a string value.")
            else:
                raise NetCDFEditError("This NetCDF variable type is not supported for editing.")
            variable.values[index] = value
        encodings: dict[str, dict[str, Any]] = {}
        for name, variable in dataset.variables.items():
            encoding = {key: value for key, value in variable.encoding.items() if key in _NETCDF_ENCODING_KEYS}
            if "_FillValue" not in variable.encoding and "_FillValue" not in variable.attrs:
                encoding["_FillValue"] = None
            encodings[name] = encoding
        dataset.to_netcdf(
            temporary, engine="netcdf4", format=source_format, encoding=encodings,
            unlimited_dims=dataset.encoding.get("unlimited_dims"),
        )
        with _open(temporary) as check:
            with netCDF4.Dataset(temporary, mode="r") as check_file:
                if check_file.data_model != source_format:
                    raise NetCDFEditError("The output file format did not match the source NetCDF data model.")
            if set(check.variables) != set(dataset.variables):
                raise NetCDFEditError("The written file did not preserve all dataset variables.")
            for name in dataset.variables:
                actual_variable, expected_variable = check[name], dataset[name]
                if (actual_variable.dims != expected_variable.dims or actual_variable.shape != expected_variable.shape
                        or actual_variable.dtype != expected_variable.dtype or not _same_attributes(actual_variable.attrs, expected_variable.attrs)):
                    raise NetCDFEditError("The written file did not preserve variable structure, type, or attributes.")
                try:
                    np.testing.assert_equal(actual_variable.values, expected_variable.values)
                except AssertionError as error:
                    raise NetCDFEditError("The written file changed a value outside the requested edits.") from error
            if not _same_attributes(check.attrs, dataset.attrs):
                raise NetCDFEditError("The written file did not preserve dataset attributes.")
            for edit in edits:
                actual = check[edit.variable].values[tuple(edit.indices)].item()
                wanted = dataset[edit.variable].values[tuple(edit.indices)].item()
                if not (actual == wanted or (isinstance(actual, float) and isinstance(wanted, float) and math.isnan(actual) and math.isnan(wanted))):
                    raise NetCDFEditError("The written file failed value verification.")
        os.replace(temporary, output)
    except NetCDFEditError:
        raise
    except Exception as error:
        raise NetCDFEditError("The edited dataset could not be serialized and verified with the supported NetCDF engine.") from error
    finally:
        temporary.unlink(missing_ok=True)
