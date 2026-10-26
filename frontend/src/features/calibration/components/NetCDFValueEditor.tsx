import { useEffect, useMemo, useRef, useState } from "react";
import { api, type NetCDFCellEdit, type NetCDFValues, type UploadMetadata } from "../../../lib/api";
import { ValueRequestGuard } from "./valueRequestGuard";
import { defaultSelectors, editKey, filterVariablesWithSelection, matchesVariableView, setPendingEdit } from "./netcdfEditorState";

type Dataset = Extract<NonNullable<import("../../../lib/api").UploadInspection["representation"]>, { kind: "netcdf_dataset" }>;

interface Props { projectId: string; jobId: string; uploadId: string; dataset: Dataset; selectedVariable?: string | null; onVariableChange?: (name: string) => void; onSaved: (upload: UploadMetadata) => void }
type PendingEdit = NetCDFCellEdit & { original: unknown };

export default function NetCDFValueEditor({ projectId, jobId, uploadId, dataset, selectedVariable, onVariableChange, onSaved }: Props) {
  const [query, setQuery] = useState("");
  const dataVariables = dataset.variables.filter((item) => !item.is_coordinate);
  const [localName, setName] = useState(dataVariables[0]?.name ?? "");
  const name = selectedVariable && dataVariables.some((item) => item.name === selectedVariable) ? selectedVariable : localName;
  const variable = dataset.variables.find((item) => item.name === name);
  const variables = useMemo(() => filterVariablesWithSelection(dataVariables, query, name), [dataset.variables, query, name]);
  const [selectors, setSelectors] = useState<Array<number | null>>([]);
  const [view, setView] = useState<NetCDFValues | null>(null);
  const [pending, setPending] = useState<Map<string, PendingEdit>>(new Map());
  const [start, setStart] = useState(0);
  const [windowStarts, setWindowStarts] = useState([0, 0]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestGuard = useRef(new ValueRequestGuard());

  useEffect(() => {
    setSelectors(variable ? defaultSelectors(variable.shape) : []);
    setStart(0);
    setWindowStarts([0, 0]);
    setView(null);
    setPending(new Map());
    return () => requestGuard.current.invalidate();
  }, [uploadId, name]);

  function invalidateValueRequest() {
    requestGuard.current.invalidate();
    setLoading(false);
  }

  async function loadValues(pageStart = start, pageWindows = windowStarts) {
    if (!name) return;
    const requestGeneration = requestGuard.current.begin();
    const requestName = name;
    const requestUploadId = uploadId;
    const requestSelectors = [...selectors];
    const requestWindows = [...pageWindows];
    setLoading(true); setError(null);
    try {
      const result = await api.netcdfValues(projectId, jobId, requestUploadId, requestName, requestSelectors, pageStart, requestWindows, [20, 20]);
      if (requestGuard.current.isCurrent(requestGeneration)) {
        if (!matchesVariableView(result, requestName, requestSelectors, variable?.dimensions, variable?.shape)) {
          throw new Error("The returned NetCDF values do not match the selected variable's dimensions and shape. Reload the file inspection before continuing.");
        }
        setView(result);
      }
    } catch (reason) {
      if (requestGuard.current.isCurrent(requestGeneration)) setError(reason instanceof Error ? reason.message : "Values could not be loaded.");
    } finally {
      if (requestGuard.current.isCurrent(requestGeneration)) setLoading(false);
    }
  }
  function queue(index: number[], original: unknown, raw: string) {
    if (raw === "" && /^(u?int|float|double)/i.test(variable?.data_type ?? "")) { setPending(setPendingEdit(pending, { variable: name, indices: index, value: null, original }, original)); return; }
    let value: unknown = raw;
    if (/^(u?int|float|double)/i.test(variable?.data_type ?? "")) {
      value = Number(raw);
      if (!Number.isFinite(value)) { setError("Enter a finite number, or leave blank to use the variable's declared missing value."); return; }
    }
    setPending(setPendingEdit(pending, { variable: name, indices: index, value, original }, original)); setError(null);
  }
  async function save() {
    if (!view || pending.size === 0) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const edits = [...pending.values()].map(({ original: _original, ...edit }) => edit);
      const artifact = await api.saveNetcdfEdits(projectId, jobId, uploadId, view.source_sha256, edits);
      setPending(new Map()); setNotice(`Saved and verified ${artifact.original_filename}.`); onSaved(artifact);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Edits could not be saved."); }
    finally { setSaving(false); }
  }
  return <section className="mt-4 rounded-xl border border-blue-200 bg-blue-50/40 p-4" aria-label="NetCDF value editor">
    <h3 className="text-sm font-semibold text-slate-900">Browse and edit stored values</h3>
    <p className="mt-1 text-xs text-slate-600">Data variables only; coordinates and metadata remain read-only. Each view is limited to 1,000 cells.</p>
    <div className="mt-3 grid gap-3 md:grid-cols-2">
      <label className="text-xs font-medium">Search data variables<input className="mt-1 w-full rounded border px-2 py-1.5" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Variable name" /></label>
      <label className="text-xs font-medium">Variable<select className="mt-1 w-full rounded border bg-white px-2 py-1.5" value={name} onChange={(event) => {
        const nextName = event.target.value;
        invalidateValueRequest();
        setName(nextName);
        onVariableChange?.(nextName);
        const nextVariable = dataset.variables.find((item) => item.name === nextName);
        setSelectors(nextVariable ? defaultSelectors(nextVariable.shape) : []);
        setStart(0);
        setWindowStarts([0, 0]);
        setView(null);
        setPending(new Map());
      }}>{variables.map((item) => <option key={item.name} value={item.name}>{item.name} · {item.dimensions.join(" × ") || "scalar"} · {item.data_type}{item.name === name && !item.name.toLowerCase().includes(query.trim().toLowerCase()) ? " � current selection" : ""}</option>)}</select></label>
    </div>
    {variable && <div className="mt-3 rounded bg-white p-3 text-xs"><p><strong>Shape:</strong> [{variable.shape.join(", ") || "scalar"}] · <strong>Dimension order:</strong> {variable.dimensions.join(" → ") || "scalar"}</p>
      {variable.dimensions.map((dimension, axis) => <label key={dimension} className="mr-3 mt-2 inline-flex items-center gap-1">{dimension} index
        <input aria-label={`${dimension} dimension index; blank shows all`} type="number" min={0} max={Math.max(0, variable.shape[axis] - 1)} step={1} placeholder="all (grid axis)" className="w-24 rounded border px-1 py-1" value={selectors[axis] ?? ""} onChange={(event) => { invalidateValueRequest(); setStart(0); setWindowStarts([0, 0]); setView(null); setSelectors((current) => current.map((item, i) => i === axis ? (event.target.value === "" ? null : Number(event.target.value)) : item)); }} />
      </label>)}
      <button type="button" disabled={loading} onClick={() => void loadValues()} className="ml-2 mt-2 rounded bg-slate-800 px-3 py-1.5 font-semibold text-white disabled:opacity-50">{loading ? "Loading…" : "Load values"}</button>
    </div>}
    {error && <p role="alert" className="mt-2 text-xs text-rose-700">{error}</p>}{notice && <p role="status" className="mt-2 text-xs text-emerald-700">{notice}</p>}
    {view && matchesVariableView(view, name, selectors, variable?.dimensions, variable?.shape) && <><p className="mt-3 text-xs text-slate-600">Showing {view.values.length} actual values · {view.dimensions.join(" × ") || "scalar"} · shape [{view.shape.join(", ")}] · varying [{view.varying_dimensions.join(", ") || "none"}] · window start [{view.window_starts.join(", ")}]. Empty means missing/unavailable (never coerced to zero).</p>{view.varying_dimensions.length === 2 ? <div className="mt-2 flex flex-wrap gap-2">{view.varying_dimensions.map((dimension, axis) => { const dimensionAxis = view.dimensions.indexOf(dimension); const atEnd = view.window_starts[axis] + view.window_shape[axis] >= view.shape[dimensionAxis]; return <span key={dimension} className="flex gap-1"><button type="button" disabled={loading || windowStarts[axis] === 0} onClick={() => { const next = [...windowStarts]; next[axis] = Math.max(0, next[axis] - 20); setWindowStarts(next); void loadValues(0, next); }} className="rounded border px-2 py-1 text-xs">Previous {dimension}</button><button type="button" disabled={loading || atEnd} onClick={() => { const next = [...windowStarts]; next[axis] += 20; setWindowStarts(next); void loadValues(0, next); }} className="rounded border px-2 py-1 text-xs">Next {dimension}</button></span>; })}</div> : (view.has_more || start > 0) && <div className="mt-2 flex gap-2"><button type="button" disabled={loading || start === 0} onClick={() => { const next = Math.max(0, start - 1000); setStart(next); void loadValues(next); }} className="rounded border px-2 py-1 text-xs disabled:opacity-40">Previous 1,000</button><button type="button" disabled={loading || !view.has_more} onClick={() => { const next = start + 1000; setStart(next); void loadValues(next); }} className="rounded border px-2 py-1 text-xs disabled:opacity-40">Next 1,000</button></div>}
      <div className="mt-2 max-h-80 overflow-auto rounded border bg-white"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-slate-100">{view.varying_dimensions.length === 2 ? <tr><th className="p-2">{view.varying_dimensions[0]} ↓ / {view.varying_dimensions[1]} →</th>{[...new Set(view.indices.map((indices) => indices[view.dimensions.indexOf(view.varying_dimensions[1])]))].map((column) => <th key={column} className="p-2 font-mono">{column}</th>)}</tr> : <tr><th className="p-2">Indices ({view.dimensions.join(", ") || "scalar"})</th><th className="p-2">Stored value</th><th className="p-2">Edit value</th></tr>}</thead><tbody className="divide-y">{view.varying_dimensions.length === 2 ? [...new Set(view.indices.map((indices) => indices[view.dimensions.indexOf(view.varying_dimensions[0])]))].map((row) => <tr key={row}><th className="p-2 font-mono">{row}</th>{[...new Set(view.indices.map((indices) => indices[view.dimensions.indexOf(view.varying_dimensions[1])]))].map((column) => { const i = view.indices.findIndex((indices) => indices[view.dimensions.indexOf(view.varying_dimensions[0])] === row && indices[view.dimensions.indexOf(view.varying_dimensions[1])] === column); const indices = view.indices[i]; const value = view.values[i]; const key = editKey(indices); const changed = pending.get(key); return <td key={column} className="border-l p-1"><span className="block font-mono text-[10px] text-slate-500">{value === null ? "missing" : String(value)}</span><input aria-label={`Edit ${view.variable} at indices ${indices.join(",")}`} className="w-24 rounded border px-1 py-1" value={changed ? (changed.value === null ? "" : String(changed.value)) : (value === null ? "" : String(value))} onChange={(event) => queue(indices, value, event.target.value)} /></td>; })}</tr>) : view.values.map((value, i) => { const indices = view.indices[i] ?? []; const key = editKey(indices); const changed = pending.get(key); return <tr key={key}><td className="p-2 font-mono">[{indices.join(", ")}]</td><td className="p-2 font-mono">{value === null ? "missing / non-finite" : String(value)}</td><td className="p-2"><input aria-label={`Edit indices ${indices.join(",") || "scalar"}`} className="w-40 rounded border px-2 py-1" value={changed ? (changed.value === null ? "" : String(changed.value)) : (value === null ? "" : String(value))} onChange={(event) => queue(indices, value, event.target.value)} /></td></tr>; })}</tbody></table></div>
      {!!pending.size && <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3"><p className="text-xs font-semibold">Review {pending.size} unsaved cell edit{pending.size === 1 ? "" : "s"}</p><ul className="mt-1 max-h-28 overflow-auto text-xs">{[...pending.entries()].map(([key, edit]) => <li key={key} className="flex justify-between gap-2 py-0.5"><span>[{key || "scalar"}] · original {String(edit.original ?? "missing")} → proposed {String(edit.value ?? "missing")}</span><button className="text-rose-700 underline" type="button" onClick={() => { const next = new Map(pending); next.delete(key); setPending(next); }}>Cancel</button></li>)}</ul><div className="mt-2 flex gap-2"><button type="button" disabled={saving} onClick={() => void save()} className="rounded bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{saving ? "Saving and verifying…" : "Save separate NetCDF"}</button><button type="button" disabled={saving} onClick={() => setPending(new Map())} className="rounded border px-3 py-1.5 text-xs">Discard all edits</button></div></div>}
    </>}
  </section>;
}
