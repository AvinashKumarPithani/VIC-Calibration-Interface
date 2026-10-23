import { Fragment, useEffect, useRef, useState, type ChangeEvent } from "react";
import { Link } from "react-router-dom";
import { api, type InspectedYamlNode, type UploadInspection, type UploadMetadata } from "../../lib/api";
import type { CalibrationJob, Project } from "../setup/types";
import { configurationSections, exampleConfiguration, exampleDependencies, exampleParsedSettings } from "./mockData";
import type { ValidationFinding } from "./types";

interface InputsPageProps {
  project: Project | null;
  job: CalibrationJob | null;
}

const cardClass = "rounded-xl border border-slate-200 bg-white p-2.5 shadow-sm";
const secondaryButton = "inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500";
const primaryButton = "inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUploadDate(value: string) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function displayKey(key: unknown) {
  return typeof key === "string" ? key : JSON.stringify(key);
}

function YamlValue({ node, depth = 0 }: { node: InspectedYamlNode; depth?: number }) {
  if (node.kind === "mapping") {
    if (node.entries.length === 0) return <span className="text-slate-500">Empty mapping</span>;
    return (
      <div className="space-y-1 pl-2">
        {node.entries.map((entry, index) => (
          <details key={`${displayKey(entry.key)}-${index}`} open={depth === 0} className="rounded border border-slate-200 bg-white px-2 py-1">
            <summary className="cursor-pointer break-words text-xs font-semibold text-slate-800">{displayKey(entry.key)}</summary>
            <div className="mt-1 pl-2"><YamlValue node={entry.value} depth={depth + 1} /></div>
          </details>
        ))}
      </div>
    );
  }
  if (node.kind === "sequence") {
    if (node.items.length === 0) return <span className="text-slate-500">Empty list</span>;
    return <ol className="list-inside list-decimal space-y-1 pl-2">{node.items.map((item, index) => <li key={index} className="break-words text-xs text-slate-700"><YamlValue node={item} depth={depth + 1} /></li>)}</ol>;
  }
  if (node.kind === "null") return <span className="text-slate-500">null</span>;
  if (node.kind === "redacted") return <span className="font-medium text-amber-800">[REDACTED]</span>;
  return <span className="break-words text-xs text-slate-800"><span className="mr-1 text-[10px] text-slate-400">{node.scalar_type}</span>{String(node.value)}</span>;
}

function InspectionRepresentationView({ inspection }: { inspection: UploadInspection }) {
  const representation = inspection.representation;
  if (inspection.parse_status !== "parsed") {
    return <p className="text-xs text-slate-500">No parsed representation is available for this file.</p>;
  }
  if (!representation) return <p className="text-xs text-slate-500">The API did not return a representation for this format.</p>;

  if (representation.kind === "yaml_tree") {
    return <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-2"><YamlValue node={representation.root} /></div>;
  }
  if (representation.kind === "vic_parameter_lines") {
    return <div className="max-h-72 overflow-auto rounded-lg border border-slate-200"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-slate-100 text-slate-600"><tr><th className="px-2 py-1">Line</th><th className="px-2 py-1">Kind</th><th className="px-2 py-1">Option / original line</th><th className="px-2 py-1">Value tokens</th></tr></thead><tbody className="divide-y divide-slate-100">{representation.lines.map((line, index) => <tr key={`${line.line_number}-${index}`}><td className="px-2 py-1 text-slate-500">{line.line_number}</td><td className="px-2 py-1 text-slate-500">{line.kind}</td><td className="px-2 py-1 font-mono text-slate-800"><span className="whitespace-pre-wrap break-all">{line.raw || " "}</span></td><td className="px-2 py-1 font-mono text-slate-700">{line.values.join(" | ")}</td></tr>)}</tbody></table></div>;
  }
  if (representation.kind === "routing_positional_records") {
    return <div className="max-h-72 space-y-2 overflow-y-auto">{representation.records.length === 0 ? <p className="text-xs text-slate-500">No records were returned.</p> : representation.records.map((record, index) => <section key={`${record.heading_line_number}-${index}`} className="rounded-lg border border-slate-200 bg-white p-2"><h3 className="text-xs font-semibold text-slate-800">{record.heading_raw || record.heading || `Record ${index + 1}`}</h3><pre className="mt-1 whitespace-pre-wrap break-all font-mono text-xs text-slate-700">{record.lines.length ? record.lines.map((line) => `${line.line_number}: ${line.raw}`).join("\n") : "No positional lines"}</pre></section>)}</div>;
  }
  if (representation.kind === "unit_hydrograph_rows") {
    return <div className="max-h-72 overflow-auto rounded-lg border border-slate-200"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-slate-100 text-slate-600"><tr><th className="px-2 py-1">Line</th><th className="px-2 py-1">Index token</th><th className="px-2 py-1">Value token</th></tr></thead><tbody className="divide-y divide-slate-100">{representation.rows.length === 0 ? <tr><td colSpan={3} className="px-2 py-3 text-slate-500">No numerical rows were returned.</td></tr> : representation.rows.map((row, index) => <tr key={`${row.line_number}-${index}`}><td className="px-2 py-1 text-slate-500">{row.line_number}</td><td className="px-2 py-1 font-mono">{row.index_token}</td><td className="px-2 py-1 font-mono">{row.value_token}</td></tr>)}</tbody></table></div>;
  }
  return <p className="text-xs text-slate-500">No viewer is available for this representation.</p>;
}

export default function InputsPage({ project, job }: InputsPageProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const currentContext = useRef({ projectId: project?.id, jobId: job?.id });
  currentContext.current = { projectId: project?.id, jobId: job?.id };
  const [uploads, setUploads] = useState<UploadMetadata[]>([]);
  const [uploadsLoading, setUploadsLoading] = useState(false);
  const [uploadsError, setUploadsError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<UploadMetadata | null>(null);
  const [deletingUploadId, setDeletingUploadId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [selectedConfigurationUploadId, setSelectedConfigurationUploadId] = useState<string | null>(null);
  const [showConfiguration, setShowConfiguration] = useState(true);
  const [findings, setFindings] = useState<ValidationFinding[] | null>(null);
  const [expandedDependency, setExpandedDependency] = useState<string | null>(null);
  const [inspection, setInspection] = useState<UploadInspection | null>(null);
  const [inspectionLoadingId, setInspectionLoadingId] = useState<string | null>(null);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const inspectionRequestId = useRef(0);
  const inspectionSelectionId = useRef<string | null>(null);

  useEffect(() => {
    if (!project || !job || job.projectId !== project.id) {
      setUploads([]);
      setUploadsLoading(false);
      setUploadsError(null);
      return;
    }

    let active = true;
    setUploads([]);
    setUploadsLoading(true);
    setUploadsError(null);
    setSelectedConfigurationUploadId(null);
    setUploadSuccess(null);
    setUploadError(null);
    setPendingDelete(null);
    setDeleteError(null);
    setFindings(null);
    inspectionRequestId.current += 1;
    inspectionSelectionId.current = null;
    setInspection(null);
    setInspectionLoadingId(null);
    setInspectionError(null);
    api.listUploads(project.id, job.id).then((records) => {
      if (active) setUploads(records);
    }).catch((error: unknown) => {
      if (active) setUploadsError(error instanceof Error ? error.message : "Uploaded files could not be loaded.");
    }).finally(() => {
      if (active) setUploadsLoading(false);
    });

    return () => { active = false; };
  }, [project?.id, job?.id]);

  async function inspectUploadedFile(upload: UploadMetadata) {
    if (!project || !job || job.projectId !== project.id) return;
    const projectId = project.id;
    const jobId = job.id;
    const requestId = ++inspectionRequestId.current;
    inspectionSelectionId.current = upload.id;
    setSelectedConfigurationUploadId(upload.id);
    setInspection(null);
    setInspectionError(null);
    setInspectionLoadingId(upload.id);
    try {
      const result = await api.inspectUpload(projectId, jobId, upload.id);
      if (result.upload.id !== upload.id || result.upload.project_id !== projectId || result.upload.job_id !== jobId) {
        throw new Error("The API returned inspection data for a different uploaded file.");
      }
      if (inspectionRequestId.current === requestId
        && inspectionSelectionId.current === upload.id
        && currentContext.current.projectId === projectId
        && currentContext.current.jobId === jobId) {
        setInspection(result);
      }
    } catch (error) {
      if (inspectionRequestId.current === requestId
        && currentContext.current.projectId === projectId
        && currentContext.current.jobId === jobId) {
        setInspectionError(error instanceof Error ? error.message : "This file could not be inspected.");
      }
    } finally {
      if (inspectionRequestId.current === requestId) setInspectionLoadingId(null);
    }
  }

  async function handleFileSelection(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!project || !job || job.projectId !== project.id) return;

    setUploading(true);
    setUploadError(null);
    setUploadsError(null);
    setUploadSuccess(null);
    setFindings(null);

    try {
      const uploaded = await api.uploadFile(project.id, job.id, file);
      if (uploaded.project_id !== project.id || uploaded.job_id !== job.id) {
        throw new Error("The API returned upload metadata for a different project or job.");
      }
      setSelectedConfigurationUploadId(uploaded.id);
      setUploads((current) => [uploaded, ...current.filter((item) => item.id !== uploaded.id)]);
      setUploadSuccess(`${uploaded.original_filename} uploaded (${formatFileSize(uploaded.file_size)}). Its contents have not been checked.`);

      try {
        const refreshed = await api.listUploads(project.id, job.id);
        setUploads(refreshed);
      } catch (error) {
        setUploadsError(error instanceof Error ? `Upload succeeded, but the file list could not be refreshed: ${error.message}` : "Upload succeeded, but the file list could not be refreshed.");
      }
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "The file could not be uploaded.");
    } finally {
      setUploading(false);
    }
  }

  async function confirmDeleteUpload() {
    if (!project || !job || job.projectId !== project.id || !pendingDelete || deletingUploadId) return;
    const target = pendingDelete;
    setDeletingUploadId(target.id);
    setDeleteError(null);
    try {
      await api.deleteUpload(project.id, job.id, target.id);
      if (currentContext.current.projectId !== project.id || currentContext.current.jobId !== job.id) return;
      setUploads((current) => current.filter((upload) => upload.id !== target.id));
      setSelectedConfigurationUploadId((current) => current === target.id ? null : current);
      if (inspectionSelectionId.current === target.id) {
        inspectionRequestId.current += 1;
        inspectionSelectionId.current = null;
        setInspection(null);
        setInspectionError(null);
        setInspectionLoadingId(null);
      }
      setUploadSuccess(`${target.original_filename} deleted.`);
      setPendingDelete(null);
      try {
        const refreshed = await api.listUploads(project.id, job.id);
        if (currentContext.current.projectId === project.id && currentContext.current.jobId === job.id) {
          setUploads(refreshed);
        }
      } catch (error) {
        if (currentContext.current.projectId !== project.id || currentContext.current.jobId !== job.id) return;
        const message = error instanceof Error ? error.message : "The uploaded-file list could not be refreshed.";
        setUploadsError(`File deleted, but the list could not be refreshed: ${message}`);
      }
    } catch (error) {
      if (currentContext.current.projectId === project.id && currentContext.current.jobId === job.id) {
        setDeleteError(error instanceof Error ? error.message : "The uploaded file could not be deleted.");
      }
    } finally {
      setDeletingUploadId(null);
    }
  }

  function validateMockInputs() {
    setFindings([
      {
        severity: "issue",
        message: inspection
          ? inspection.parse_status === "parsed"
            ? "The file was parsed, but RAT compatibility, dependencies, and scientific validity have not been checked."
            : `The selected file inspection status is ${inspection.parse_status}; RAT compatibility and scientific validity have not been checked.`
          : uploads.length > 0
            ? "Upload metadata is available, but no file has been inspected yet."
            : "No files have been uploaded for this job.",
      },
      {
        severity: "warning",
        message: "Example dependencies are not resolved or checked against the RAT environment.",
      },
      {
        severity: "warning",
        message: "Observed discharge data availability is unknown and must be checked before calibration.",
      },
    ]);
  }

  if (!project || !job) {
    return (
      <section className="mx-auto max-w-4xl px-5 py-10 sm:px-8">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Step 02 / RAT + VIC calibration</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-slate-950">2. Inputs &amp; Configuration</h1>
        <div className={cardClass + " mt-6 border-dashed text-center"}>
          <h2 className="text-lg font-semibold text-slate-900">Select a project and job first</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-600">
            Inputs are shown for the current job. Choose a project and open a job from Setup to inspect its input context.
          </p>
          <Link to="/setup" className={primaryButton + " mt-5"}>Go to Setup</Link>
        </div>
      </section>
    );
  }

  const issueCount = findings?.filter((finding) => finding.severity === "issue").length ?? 0;
  const warningCount = findings?.filter((finding) => finding.severity === "warning").length ?? 0;

  return (
    <div className="min-h-[calc(100vh-5rem)] bg-[#f5f8fc] p-3 sm:p-5 xl:h-[calc(100dvh-6rem)] xl:min-h-0 xl:overflow-hidden xl:p-4">
      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && deletingUploadId === null) setPendingDelete(null);
          }}
        >
          <section role="alertdialog" aria-modal="true" aria-labelledby="delete-upload-title" aria-describedby="delete-upload-description" className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl">
            <h2 id="delete-upload-title" className="text-lg font-semibold text-slate-900">Delete uploaded file?</h2>
            <p id="delete-upload-description" className="mt-2 break-words text-sm leading-5 text-slate-600">
              Permanently delete <strong className="text-slate-800">{pendingDelete.original_filename}</strong> from this job?
            </p>
            {deleteError && <p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{deleteError}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" disabled={deletingUploadId !== null} onClick={() => setPendingDelete(null)} className={secondaryButton + " disabled:opacity-50"}>Cancel</button>
              <button type="button" disabled={deletingUploadId !== null} onClick={confirmDeleteUpload} className="inline-flex items-center justify-center rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:cursor-wait disabled:opacity-60">
                {deletingUploadId ? "Deleting…" : "Delete file"}
              </button>
            </div>
          </section>
        </div>
      )}
      <div className="mx-auto max-w-[1680px] xl:flex xl:h-full xl:min-h-0 xl:flex-col">
        <div className="grid min-h-0 items-stretch gap-3 xl:flex-1 xl:overflow-hidden xl:grid-cols-[210px_minmax(0,1fr)_370px]">
          <aside className="flex min-h-[360px] flex-col rounded-xl border border-slate-200 bg-white p-2.5 shadow-sm xl:h-full xl:min-h-0" aria-label="Current project and job">
            <h2 className="font-semibold text-slate-900">Current context</h2>
            <div className="mt-2 rounded-lg border-l-[3px] border-blue-600 bg-blue-50 p-2.5">
              <p className="text-xs font-medium text-slate-500">Project</p>
              <p className="mt-1 break-words text-sm font-semibold text-slate-900">{project.name}</p>
            </div>
            <div className="mt-1.5 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
              <p className="text-xs font-medium text-slate-500">Current job</p>
              <p className="mt-1 break-words text-sm font-semibold text-slate-900">{job.name}</p>
              <p className="mt-1 text-xs text-slate-500">{job.id}</p>
            </div>
          </aside>

          <section className="min-w-0 space-y-3 xl:grid xl:h-full xl:min-h-0 xl:grid-rows-[auto_auto_minmax(0,1fr)] xl:gap-3 xl:space-y-0">
            <header className="px-1 pb-1 xl:row-start-1">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">
                Step 02 / RAT + VIC calibration
                <span className="ml-2 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-sky-800">Live uploads · mock summaries</span>
              </p>
              <h1 className="mt-1 text-xl font-bold tracking-tight text-slate-950">2. Inputs &amp; Configuration</h1>
              <p className="mt-1 max-w-3xl text-sm leading-5 text-slate-600">
                View this job&apos;s uploaded files and illustrative configuration details. Uploading does not parse or validate files.
              </p>
            </header>

            <div className="grid gap-3 xl:row-start-2 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] xl:items-stretch">
            <section className={cardClass + " min-w-0"} aria-labelledby="config-heading">
              <div className="flex flex-col gap-1.5 border-b border-slate-100 pb-1.5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">A. Main RAT configuration</p>
                  <h2 id="config-heading" className="mt-0.5 text-sm font-semibold text-slate-900">rat_config.yaml</h2>
                  <p className="mt-0.5 text-[11px] leading-4 text-slate-600">Upload a local YAML configuration to this job. The backend records the file but does not parse it.</p>
                </div>
                <span className="w-fit shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">{selectedConfigurationUploadId ? "Uploaded · not parsed" : uploads.length > 0 ? "Upload role not recorded" : "No configuration selected"}</span>
              </div>

              <div className="mt-1.5 grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_230px] sm:items-start">
                <dl className="grid gap-1">
                  <div className="rounded-lg bg-slate-50 px-2 py-1">
                    <dt className="font-medium text-slate-500">Source</dt>
                    <dd className="mt-0.5 text-[10px] leading-3 text-slate-800">{selectedConfigurationUploadId ? "Uploaded to this job" : uploads.length > 0 ? "Existing uploads are not classified" : "No configuration uploaded"}</dd>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-2 py-1">
                    <dt className="font-medium text-slate-500">Stored path</dt>
                    <dd className="mt-0.5 text-[10px] leading-3 text-slate-800">Not exposed by the API</dd>
                  </div>
                </dl>

                <div className="flex flex-col gap-1">
                  <input ref={fileInput} type="file" accept=".yaml,.yml" disabled={uploading || uploadsLoading} className="sr-only" aria-label="Select a local RAT configuration file" onChange={handleFileSelection} />
                  <button type="button" disabled={uploading || uploadsLoading} onClick={() => fileInput.current?.click()} className={secondaryButton + " justify-start px-2.5 py-1.5 text-xs disabled:cursor-wait disabled:opacity-60"}>{uploadsLoading ? "Loading uploads…" : uploading ? "Uploading…" : "Select Configuration"}</button>
                  <button type="button" onClick={() => setShowConfiguration((shown) => !shown)} className={secondaryButton + " justify-start px-2.5 py-1.5 text-xs"}>
                    {showConfiguration ? "Hide Example Configuration" : "View Example Configuration"}
                  </button>
                  <button type="button" onClick={validateMockInputs} className={secondaryButton + " justify-start px-2.5 py-1.5 text-xs"}>Validate Configuration (mock check)</button>
                </div>
              </div>
              {uploadError && <p role="alert" className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-4 text-rose-800">{uploadError}</p>}
              {uploadSuccess && <p role="status" className="mt-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-4 text-sky-900">{uploadSuccess}</p>}
            </section>

            <section className={cardClass + " min-w-0"} aria-labelledby="overview-heading">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">B. Configuration overview</p>
                  <h2 id="overview-heading" className="mt-0.5 text-base font-semibold text-slate-900">Illustrative sections</h2>
                </div>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700">No job values checked</span>
              </div>
              <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                {configurationSections.map((section) => (
                  <div key={section.title} className="rounded-lg border border-slate-200 bg-slate-50/60 px-2 py-1.5">
                    <h3 className="text-xs font-semibold text-slate-800">{section.title}</h3>
                    <p className="mt-0.5 text-[11px] leading-4 text-slate-600">{section.description}</p>
                  </div>
                ))}
              </div>
            </section>

            </div>

            <section className={cardClass + " flex min-h-0 flex-col xl:row-start-3"} aria-labelledby="dependencies-heading">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">C. Referenced files and dependencies</p>
                  <h2 id="dependencies-heading" className="mt-0.5 text-base font-semibold text-slate-900">Example dependencies</h2>
                </div>
                <span className="text-[11px] text-slate-500">Statuses are not checked against a RAT environment.</span>
              </div>
              <div className="mt-1.5 min-h-0 flex-1 overflow-x-auto rounded-lg border border-slate-200">
                <div className="border-b border-slate-200 p-2">
                  <h3 className="text-xs font-semibold text-slate-800">Uploaded files for this job</h3>
                  <p className="mt-0.5 text-[10px] text-slate-500">Upload metadata only; file contents and scientific validity are not checked.</p>
                  {uploadsLoading && <p className="mt-2 text-xs text-slate-500">Loading uploaded files…</p>}
                  {uploadsError && <p role="alert" className="mt-2 text-xs text-rose-700">{uploadsError}</p>}
                  {!uploadsLoading && !uploadsError && uploads.length === 0 && <p className="mt-2 text-xs text-slate-500">No files uploaded for this job.</p>}
                  {uploads.length > 0 && <div className="mt-1 overflow-x-auto"><table className="w-full min-w-[520px] text-left text-[10px]"><thead className="text-slate-500"><tr><th className="px-1 py-1 font-medium">Filename</th><th className="px-1 py-1 font-medium">Size</th><th className="px-1 py-1 font-medium">Uploaded</th><th className="px-1 py-1 font-medium">Inspection</th><th className="px-1 py-1 font-medium">Actions</th></tr></thead><tbody className="divide-y divide-slate-100">{uploads.map((upload) => <tr key={upload.id}><td className="max-w-48 truncate px-1 py-1.5 font-medium text-slate-700" title={upload.original_filename}>{upload.original_filename}</td><td className="whitespace-nowrap px-1 py-1.5 text-slate-600">{formatFileSize(upload.file_size)}</td><td className="whitespace-nowrap px-1 py-1.5 text-slate-600">{formatUploadDate(upload.uploaded_at)}</td><td className="whitespace-nowrap px-1 py-1.5 text-slate-600">{inspection?.upload.id === upload.id ? inspection.parse_status : "Not inspected"}</td><td className="whitespace-nowrap px-1 py-1.5"><button type="button" disabled={inspectionLoadingId !== null || deletingUploadId !== null || uploading} onClick={() => void inspectUploadedFile(upload)} className="mr-1 rounded-md px-2 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 disabled:cursor-wait disabled:opacity-50">{inspectionLoadingId === upload.id ? "Inspecting..." : "Inspect"}</button><button type="button" disabled={deletingUploadId !== null || uploading} onClick={() => { setDeleteError(null); setPendingDelete(upload); }} className="rounded-md px-2 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-rose-500 disabled:cursor-not-allowed disabled:opacity-50">Delete</button></td></tr>)}</tbody></table></div>}
                </div>
                <h3 className="px-2 pt-2 text-xs font-semibold text-slate-700">Illustrative dependencies · not checked</h3>
                <table className="w-full min-w-[740px] border-collapse text-left text-xs">
                  <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] font-semibold text-slate-700">
                    <tr>
                      <th className="w-[24%] px-2 py-1.5">Dependency / type</th>
                      <th className="w-[14%] px-2 py-1.5">Status</th>
                      <th className="w-[25%] px-2 py-1.5">Source / example reference</th>
                      <th className="w-[12%] px-2 py-1.5">Actions</th>
                      <th className="w-[25%] px-2 py-1.5">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {exampleDependencies.map((dependency, index) => {
                      const isExpanded = expandedDependency === dependency.name;
                      const detailsId = "dependency-details-" + index;
                      return (
                        <Fragment key={dependency.name}>
                          <tr className="bg-white align-top">
                            <td className="px-2 py-1">
                              <span className="block font-semibold text-slate-800">{dependency.category}</span>
                              <span className="mt-0.5 block break-all text-[10px] leading-3 text-slate-600">{dependency.name}</span>
                            </td>
                            <td className="px-2 py-1">
                              <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">{dependency.status}</span>
                            </td>
                            <td className="px-2 py-1 text-[10px] leading-[14px] text-slate-600">{dependency.exampleReference}</td>
                            <td className="px-2 py-1">
                              <button
                                type="button"
                                aria-expanded={isExpanded}
                                aria-controls={detailsId}
                                onClick={() => setExpandedDependency(isExpanded ? null : dependency.name)}
                                className="rounded-md px-2 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
                              >
                                {isExpanded ? "Hide" : "View"}
                              </button>
                            </td>
                            <td className="px-2 py-1 text-[10px] leading-[14px] text-slate-600">{dependency.role}</td>
                          </tr>
                          <tr id={detailsId} hidden={!isExpanded}>
                            <td colSpan={5} className="bg-blue-50/60 px-3 py-2 text-[11px] leading-4 text-slate-700">
                              <strong>{dependency.category}:</strong> {dependency.role} {dependency.exampleReference}
                            </td>
                          </tr>
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </section>

          <aside className="min-w-0 space-y-2 xl:flex xl:h-full xl:min-h-0 xl:flex-col xl:overflow-hidden">
            <div className="min-h-0 space-y-2 overflow-x-hidden xl:flex-1 xl:overflow-y-auto xl:overscroll-contain">
            <section className={cardClass + " shrink-0"} aria-labelledby="preview-heading">
              {inspection ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <h2 id="preview-heading" className="text-sm font-semibold text-blue-700">File inspection</h2>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">{inspection.parse_status}</span>
                  </div>
                  <p className="mt-1 break-words text-xs font-medium text-slate-800">{inspection.upload.original_filename} - {inspection.detected_format.replaceAll("_", " ")}</p>
                  <div className="mt-1 grid grid-cols-1 gap-1 text-[10px] text-slate-600">
                    <span>RAT compatibility: {inspection.rat_compatibility}</span>
                    <span>Dependency availability: {inspection.dependency_availability}</span>
                    <span>Scientific validity: {inspection.scientific_validity}</span>
                  </div>
                  {inspection.parse_errors.length > 0 && <ul className="mt-2 space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-2">{inspection.parse_errors.map((error, index) => <li key={`${error.code}-${index}`} className="text-xs text-amber-900">{error.message}</li>)}</ul>}
                  <div className="mt-2 border-t border-slate-100 pt-2"><InspectionRepresentationView inspection={inspection} /></div>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <h2 id="preview-heading" className="text-sm font-semibold text-blue-700">Configuration preview</h2>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">Example only</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-4 text-slate-500">Not loaded from the selected job or GangaServer.</p>
                  {inspectionLoadingId ? <p role="status" className="mt-2 text-xs text-slate-600">Inspecting selected upload...</p> : inspectionError ? <p role="alert" className="mt-2 rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">{inspectionError}</p> : null}
                  {showConfiguration ? (
                    <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-2.5 text-[10px] leading-[14px] text-slate-100"><code>{exampleConfiguration}</code></pre>
                  ) : (
                    <div className="mt-2 grid min-h-24 place-items-center rounded-lg border border-dashed border-slate-300 px-3 text-center text-xs text-slate-500">Example preview hidden. Use View Example Configuration in the main configuration panel.</div>
                  )}
                  <div className="mt-2 border-t border-slate-100 pt-1.5">
                    <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-semibold text-slate-800">Configuration summary</h3><span className="text-[10px] font-medium text-slate-500">Mock fields</span></div>
                    <p className="mt-0.5 text-[10px] leading-4 text-slate-500">Illustrative keys only; no settings have been parsed.</p>
                    <dl className="mt-0.5 grid grid-cols-2 gap-x-2 text-[10px] leading-3.5">{exampleParsedSettings.map((setting) => <div key={setting.label} className="flex min-w-0 justify-between gap-2 border-b border-slate-100 py-0.5"><dt className="truncate text-slate-500">{setting.label}</dt><dd className="shrink-0 font-medium text-slate-700">{setting.value}</dd></div>)}</dl>
                  </div>
                </>
              )}
            </section>

            <section className={cardClass + " shrink-0"} aria-labelledby="validation-heading">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">D. Validation summary</p>
                  <h2 id="validation-heading" className="mt-0.5 text-base font-semibold text-slate-900">{findings ? "Issues found" : "Not validated"}</h2>
                </div>
                <span className="rounded-full bg-amber-50 px-2 py-1 text-[10px] font-semibold text-amber-800">Prototype checks</span>
              </div>
              {findings ? (
                <>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg bg-rose-50 p-2 text-rose-900"><span className="block text-[10px]">Issues</span><strong>{issueCount}</strong></div>
                    <div className="rounded-lg bg-amber-50 p-2 text-amber-900"><span className="block text-[10px]">Warnings</span><strong>{warningCount}</strong></div>
                  </div>
                  <ul className="mt-2 space-y-1.5">
                    {findings.map((finding) => (
                      <li key={finding.message} className="flex gap-2 text-xs leading-4 text-slate-700">
                        <span aria-hidden="true" className={finding.severity === "issue" ? "text-rose-600" : "text-amber-600"}>
                          {finding.severity === "issue" ? "!" : "\u2022"}
                        </span>
                        <span>{finding.message}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="mt-2 text-xs leading-4 text-slate-600">No checks have been run. Input readiness and server file availability are unknown.</p>
              )}
              <button type="button" onClick={validateMockInputs} className={secondaryButton + " mt-2 w-full"}>
                Validate Inputs (mock checks)
              </button>
              <p className="mt-1.5 text-[10px] leading-4 text-slate-500">No YAML parsing, file-existence checks, path resolution, or scientific validation occurs.</p>

            </section>
            </div>

            <section className={cardClass + " shrink-0 border-blue-200"}>
              <Link to="/parameters" className={primaryButton + " w-full"}>
                Continue to Parameters &amp; Calibration <span aria-hidden="true">&rarr;</span>
              </Link>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
