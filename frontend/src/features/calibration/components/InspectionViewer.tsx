import { useState } from "react";
import type { InspectedYamlNode, UploadInspection, UploadInspectionRepresentation } from "../../../lib/api";

function keyLabel(key: unknown): string {
  return typeof key === "string" ? key : JSON.stringify(key) ?? String(key);
}

type ExpansionMode = "default" | "all" | "none";

function YamlValue({ node, depth, expansionMode }: { node: InspectedYamlNode; depth: number; expansionMode: ExpansionMode }) {
  if (node.kind === "mapping") {
    if (node.entries.length === 0) return <span className="text-xs italic text-slate-500">Empty mapping</span>;
    return (
      <div className="space-y-1.5">
        {node.entries.map((entry, index) => (
          <details key={`${keyLabel(entry.key)}-${index}`} open={expansionMode === "all" || (expansionMode === "default" && depth === 0)} className="rounded-lg border border-slate-200 bg-white">
            <summary className="cursor-pointer break-words px-3 py-2 text-sm font-semibold text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500">
              {keyLabel(entry.key)}
            </summary>
            <div className="border-t border-slate-100 px-3 py-2 pl-5">
              <YamlValue node={entry.value} depth={depth + 1} expansionMode={expansionMode} />
            </div>
          </details>
        ))}
      </div>
    );
  }
  if (node.kind === "sequence") {
    if (node.items.length === 0) return <span className="text-xs italic text-slate-500">Empty list</span>;
    return (
      <ol className="list-inside list-decimal space-y-1.5">
        {node.items.map((item, index) => (
          <li key={index} className="break-words rounded-md bg-slate-50 px-2 py-1 text-sm text-slate-700">
            <YamlValue node={item} depth={depth + 1} expansionMode={expansionMode} />
          </li>
        ))}
      </ol>
    );
  }
  if (node.kind === "null") return <span className="text-sm italic text-slate-500">null</span>;
  if (node.kind === "redacted") return <span className="text-sm font-medium text-amber-800">[REDACTED]</span>;
  return (
    <span className="break-words text-sm text-slate-800">
      <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase text-slate-500">{node.scalar_type ?? "value"}</span>
      {String(node.value ?? "")}
    </span>
  );
}

function YamlTreeView({ root }: { root: InspectedYamlNode }) {
  const [expansionMode, setExpansionMode] = useState<ExpansionMode>("default");
  const [treeVersion, setTreeVersion] = useState(0);
  function setExpansion(mode: ExpansionMode) {
    setExpansionMode(mode);
    setTreeVersion((version) => version + 1);
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={() => setExpansion("all")} className="rounded-md px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500">Expand all</button>
        <button type="button" onClick={() => setExpansion("none")} className="rounded-md px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500">Collapse all</button>
      </div>
      <div key={treeVersion}>
        <YamlValue node={root} depth={0} expansionMode={expansionMode} />
      </div>
    </div>
  );
}

interface VicGroup {
  title: string;
  headingLine: number | null;
  lines: Extract<UploadInspectionRepresentation, { kind: "vic_parameter_lines" }>["lines"];
}

type VicLine = Extract<UploadInspectionRepresentation, { kind: "vic_parameter_lines" }>["lines"][number];

function commentHeading(line: VicLine, previousLine: VicLine | undefined): string | null {
  if (line.kind !== "comment" || (previousLine && previousLine.kind !== "blank")) return null;
  const heading = line.raw.replace(/^\s*#+\s?/, "").replace(/\s*#+\s*$/, "").trim();
  if (!heading || heading.length > 48 || !/^[A-Za-z][A-Za-z -]*$/.test(heading)) return null;
  const words = heading.split(/\s+/);
  if (words.length > 5 || heading.includes("  ")) return null;
  return heading;
}

function groupVicLines(lines: VicGroup["lines"]): VicGroup[] {
  const groups: VicGroup[] = [];
  let current: VicGroup = { title: "Before first section", headingLine: null, lines: [] };
  let foundHeading = false;

  lines.forEach((line, index) => {
    const heading = commentHeading(line, lines[index - 1]);
    if (heading !== null) {
      if (current.lines.length > 0 || current.headingLine !== null) groups.push(current);
      current = { title: heading, headingLine: line.line_number, lines: [] };
      foundHeading = true;
    } else {
      current.lines.push(line);
    }
  });

  if (current.lines.length > 0 || current.headingLine !== null) groups.push(current);
  if (!foundHeading && groups.length === 1) groups[0].title = "VIC parameter file";
  return groups;
}

function VicEntry({ line }: { line: VicLine }) {
  if (line.kind === "blank") return null;
  if (line.kind === "comment") {
    return <div className="flex gap-2 px-3 py-1 text-slate-500"><span className="shrink-0 font-mono text-[10px] text-slate-400">{line.line_number}</span><code className="whitespace-pre-wrap break-words text-[11px]">{line.raw}</code></div>;
  }

  return (
    <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] items-start gap-3 px-3 py-1.5 sm:gap-4">
      <div className="min-w-0">
        <code className="block break-words text-xs font-semibold text-slate-800">{line.option}</code>
        <span className="mt-0.5 block font-mono text-[10px] text-slate-400">Line {line.line_number}</span>
      </div>
      <code className="min-w-0 whitespace-pre-wrap break-words text-xs text-slate-700">{line.value_text ?? line.values.join(" ")}</code>
    </div>
  );
}

function VicLinesView({ lines }: { lines: VicGroup["lines"] }) {
  const groups = groupVicLines(lines);
  const [expandAll, setExpandAll] = useState(true);
  const [showBlankLines, setShowBlankLines] = useState(false);
  const [groupVersion, setGroupVersion] = useState(0);
  function setGroupExpansion(expanded: boolean) {
    setExpandAll(expanded);
    setGroupVersion((version) => version + 1);
  }

  if (lines.length === 0) return <p className="text-sm text-slate-500">No lines were returned.</p>;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-500">
          <input type="checkbox" checked={showBlankLines} onChange={(event) => setShowBlankLines(event.target.checked)} className="h-3 w-3 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
          Show blank lines
        </label>
        <div className="flex gap-2">
          <button type="button" onClick={() => setGroupExpansion(true)} className="rounded-md px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500">Expand all</button>
          <button type="button" onClick={() => setGroupExpansion(false)} className="rounded-md px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500">Collapse all</button>
        </div>
      </div>
      <div key={groupVersion} className="space-y-2">
        {groups.map((group, index) => {
          const visibleLines = group.lines.filter((line) => line.kind !== "blank" || showBlankLines);
          return (
            <details key={`${group.headingLine ?? "leading"}-${index}`} open={expandAll} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              <summary className="cursor-pointer break-words bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500">
                {group.title}<span className="ml-2 text-xs font-normal text-slate-500">{group.headingLine !== null ? `Line ${group.headingLine}` : "Unsectioned lines"}</span>
              </summary>
              <div className="divide-y divide-slate-100 border-t border-slate-200">
                {visibleLines.length === 0 ? <p className="px-3 py-2 text-xs italic text-slate-500">No parameter lines in this section.</p> : visibleLines.map((line, lineIndex) => <VicEntry key={`${line.line_number}-${lineIndex}`} line={line} />)}
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

function RoutingRecordsView({ records }: { records: Extract<UploadInspectionRepresentation, { kind: "routing_positional_records" }>["records"] }) {
  if (records.length === 0) return <p className="text-sm text-slate-500">No routing records were returned.</p>;
  return (
    <div className="space-y-3">
      {records.map((record, index) => (
        <section key={`${record.heading_line_number}-${index}`} className="rounded-lg border border-slate-200 bg-white">
          <h3 className="border-b border-slate-100 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-800">
            {record.heading_raw ?? record.heading ?? `Record ${index + 1}`}
            {record.heading_line_number !== null && <span className="ml-2 text-xs font-normal text-slate-500">Line {record.heading_line_number}</span>}
          </h3>
          {record.lines.length === 0 ? <p className="px-3 py-2 text-xs italic text-slate-500">No positional values in this record.</p> : (
            <div className="divide-y divide-slate-100">
              {record.lines.map((line, lineIndex) => <div key={`${line.line_number}-${lineIndex}`} className="flex gap-3 px-3 py-2"><span className="w-12 shrink-0 font-mono text-xs text-slate-500">{line.line_number}</span><code className="whitespace-pre-wrap break-all text-xs text-slate-800">{line.raw}</code></div>)}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function HydrographView({ rows }: { rows: Extract<UploadInspectionRepresentation, { kind: "unit_hydrograph_rows" }>["rows"] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full max-w-2xl text-left text-sm">
        <thead className="bg-slate-100 text-xs font-semibold uppercase tracking-wide text-slate-600"><tr><th className="px-3 py-2">Line</th><th className="px-3 py-2">Index token</th><th className="px-3 py-2">Value token</th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {rows.length === 0 ? <tr><td colSpan={3} className="px-3 py-4 text-sm text-slate-500">No valid numerical rows were returned.</td></tr> : rows.map((row, index) => <tr key={`${row.line_number}-${index}`}><td className="px-3 py-2 font-mono text-xs text-slate-500">{row.line_number}</td><td className="px-3 py-2 font-mono text-sm text-slate-800">{row.index_token}</td><td className="px-3 py-2 font-mono text-sm text-slate-800">{row.value_token}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

function NetCDFView({ dataset }: { dataset: Extract<UploadInspectionRepresentation, { kind: "netcdf_dataset" }> }) {
  const [query, setQuery] = useState("");
  const filteredVariables = dataset.variables.filter((variable) =>
    variable.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const candidateVariables = filteredVariables.filter((variable) => variable.potential_calibration_candidate);
  const otherVariables = filteredVariables.filter((variable) => !variable.potential_calibration_candidate);

  function variableTable(variables: typeof dataset.variables) {
    return (
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[850px] text-left text-xs">
          <thead className="bg-slate-100 font-semibold text-slate-600">
            <tr>
              <th className="px-3 py-2">Variable</th><th className="px-3 py-2">Dimensions / shape</th>
              <th className="px-3 py-2">Type</th><th className="px-3 py-2">Units</th>
              <th className="px-3 py-2">Numeric summary</th><th className="px-3 py-2">Counts</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {variables.map((variable) => (
              <tr key={variable.name} className="align-top">
                <td className="px-3 py-2 font-mono font-semibold text-slate-800">
                  {variable.name}
                  {variable.potential_calibration_candidate && <span className="mt-1 block max-w-48 rounded bg-amber-50 px-1.5 py-1 font-sans text-[10px] font-medium text-amber-800">Potential calibration candidate · requires scientific confirmation</span>}
                  {Object.keys(variable.attributes).length > 0 && <details className="mt-1 font-sans font-normal">
                    <summary className="cursor-pointer text-[10px] text-blue-700">Variable attributes</summary>
                    <dl className="mt-1 space-y-1 text-[10px] text-slate-600">
                      {Object.entries(variable.attributes).map(([name, value]) => <div key={name} className="break-words"><dt className="inline font-medium">{name}: </dt><dd className="inline">{typeof value === "string" ? value : JSON.stringify(value)}</dd></div>)}
                    </dl>
                  </details>}
                </td>
                <td className="px-3 py-2 text-slate-700">
                  <div className="break-words">{variable.dimensions.length ? variable.dimensions.join(" × ") : "scalar"}</div>
                  <div className="mt-0.5 font-mono text-[10px] text-slate-500">[{variable.shape.join(", ")}]</div>
                </td>
                <td className="px-3 py-2 text-slate-700">{variable.data_type}<span className="mt-0.5 block text-[10px] text-slate-500">{variable.classification}</span></td>
                <td className="max-w-40 break-words px-3 py-2 text-slate-700">{variable.units ?? "—"}</td>
                <td className="px-3 py-2 text-slate-700">
                  {variable.numeric_summary ? (
                    <div className="space-y-0.5">
                      <div>min {variable.numeric_summary.minimum ?? "—"}</div>
                      <div>median {variable.numeric_summary.median ?? "—"}</div>
                      <div>max {variable.numeric_summary.maximum ?? "—"}</div>
                    </div>
                  ) : variable.summary_status === "limit_reached" ? "Summary skipped: size limit" : "Not numeric"}
                </td>
                <td className="px-3 py-2 text-[10px] text-slate-700">{variable.numeric_summary ? <span className="whitespace-nowrap">{variable.numeric_summary.finite_count.toLocaleString()} finite · {variable.numeric_summary.missing_count.toLocaleString()} missing</span> : "—"}</td>
              </tr>
            ))}
            {variables.length === 0 && <tr><td colSpan={6} className="px-3 py-4 text-slate-500">No matching variables.</td></tr>}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <section className="space-y-4" aria-label="NetCDF dataset inspection">
      <details className="text-xs text-slate-500">
        <summary className="w-fit cursor-pointer select-none rounded px-1 py-0.5 text-blue-700 hover:bg-blue-50">ⓘ About this inspection</summary>
        <p className="mt-1 max-w-3xl rounded-md bg-slate-50 px-2 py-1.5 leading-5">Dataset metadata parsing does not validate RAT compatibility or scientific validity. Candidate labels are for discovery only, are not approved calibration controls, and all NetCDF values are read-only.</p>
      </details>
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Dataset dimensions</h3>
        {dataset.dimensions.length ? <dl className="mt-2 flex flex-wrap gap-2">{dataset.dimensions.map((dimension) => <div key={dimension.name} className="rounded-md bg-slate-50 px-2.5 py-1.5 text-xs"><dt className="inline font-medium text-slate-700">{dimension.name}: </dt><dd className="inline text-slate-600">{dimension.size.toLocaleString()}</dd></div>)}</dl> : <p className="mt-2 text-xs text-slate-500">No named dimensions.</p>}
        <p className="mt-2 text-xs text-slate-500">{dataset.variable_count.toLocaleString()} variables. {dataset.summary_limits}</p>
      </div>
      <label className="block text-xs font-medium text-slate-700">
        Filter variables
        <input value={query} onChange={(event) => setQuery(event.target.value)} type="search" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" placeholder="Search variable names..." />
      </label>
      <section>
        <h3 className="mb-2 text-sm font-semibold text-slate-900">Potential calibration candidates ({candidateVariables.length})</h3>
        {candidateVariables.length ? variableTable(candidateVariables) : <p className="rounded-md bg-slate-50 p-3 text-xs text-slate-500">No listed candidate variables were found in this dataset.</p>}
      </section>
      <section>
        <h3 className="mb-2 text-sm font-semibold text-slate-900">Other dataset variables ({otherVariables.length})</h3>
        {variableTable(otherVariables)}
      </section>
    </section>
  );
}

export default function InspectionViewer({ inspection }: { inspection: UploadInspection }) {
  const representation = inspection.representation;
  if (!representation) return <p className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">This file could not be displayed in a supported parameter view. {inspection.parse_errors[0]?.message ?? "The backend did not return a supported representation."}</p>;
  switch (representation.kind) {
    case "yaml_tree": return <YamlTreeView root={representation.root} />;
    case "vic_parameter_lines": return <VicLinesView lines={representation.lines} />;
    case "routing_positional_records": return <RoutingRecordsView records={representation.records} />;
    case "unit_hydrograph_rows": return <HydrographView rows={representation.rows} />;
    case "netcdf_dataset": return <NetCDFView dataset={representation} />;
    default: return <p className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">No viewer is available for this inspection format.</p>;
  }
}
