import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Link } from "react-router-dom";
import { api, type InspectedYamlNode, type UploadInspection, type UploadMetadata } from "../../lib/api";
import { clearSavedInspectionUploadId, readSavedInspectionUploadId, saveInspectionUploadId } from "../../lib/inspectionState";
import { notifyUploadDeleted, notifyUploadInspected, UPLOAD_INSPECTED_EVENT, UPLOAD_INSPECTION_FAILED_EVENT, type FailedInspectionContext } from "../../lib/uploadEvents";
import type { CalibrationJob, Project } from "../setup/types";
import { exampleConfiguration } from "./mockData";

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

type BasinOverviewField = { key: string; label: string; value: string };
type BasinOverviewGroup = { title: string; fields: BasinOverviewField[] };
const inspectedUploadStorageKey = "vic-calibration:inputs-inspected-upload";
const ratConfigurationFilenames = new Set(["rat_config.yaml", "rat_config.yml", "rat_config_template.yaml", "rat_config_template.yml"]);

function isRatConfigurationFilename(filename: string): boolean {
  return ratConfigurationFilenames.has(filename.toLowerCase());
}

interface SavedInspectedUpload {
  projectId: string;
  jobId: string;
  uploadId: string;
}

function readSavedInspection(): SavedInspectedUpload | null {
  try {
    const stored = sessionStorage.getItem(inspectedUploadStorageKey);
    if (!stored) return null;
    const value: unknown = JSON.parse(stored);
    if (typeof value === "object" && value !== null
      && "projectId" in value && typeof value.projectId === "string"
      && "jobId" in value && typeof value.jobId === "string"
      && "uploadId" in value && typeof value.uploadId === "string") {
      return { projectId: value.projectId, jobId: value.jobId, uploadId: value.uploadId };
    }
    sessionStorage.removeItem(inspectedUploadStorageKey);
  } catch {
    // Browser storage may be disabled or unavailable.
  }
  return null;
}

function saveInspectionSelection(selection: SavedInspectedUpload): void {
  saveInspectionUploadId(selection.projectId, selection.jobId, selection.uploadId);
  try {
    sessionStorage.setItem(inspectedUploadStorageKey, JSON.stringify(selection));
  } catch {
    // Inspection remains usable for the current page even if it cannot be restored.
  }
}

function clearSavedInspection(projectId?: string, jobId?: string, uploadId?: string): void {
  if (projectId && jobId) clearSavedInspectionUploadId(projectId, jobId, uploadId);
  const saved = readSavedInspection();
  if (!saved || (projectId && saved.projectId !== projectId) || (jobId && saved.jobId !== jobId) || (uploadId && saved.uploadId !== uploadId)) return;
  try {
    sessionStorage.removeItem(inspectedUploadStorageKey);
  } catch {
    // Ignore unavailable storage.
  }
}

type FileInspectionState = {
  status: "loading" | "parsed" | "malformed" | "unsupported" | "failed";
  result?: UploadInspection;
  error?: string;
};

function inspectionStateLabel(state: FileInspectionState | undefined): string {
  if (!state) return "Not inspected";
  if (state.status === "loading") return "Inspecting…";
  if (state.status === "failed") return "Inspection failed";
  if (state.status === "parsed") return "Parsed";
  if (state.status === "malformed") return "Malformed";
  return "Unsupported";
}

function configurationOverview(inspection: UploadInspection | null, selectedUploadId: string | null, projectId: string, jobId: string): BasinOverviewGroup[] {
  if (!inspection || inspection.upload.id !== selectedUploadId || inspection.upload.project_id !== projectId || inspection.upload.job_id !== jobId || inspection.parse_status !== "parsed" || inspection.detected_format !== "rat_yaml" || inspection.representation?.kind !== "yaml_tree") return [];
  const root = inspection.representation.root;
  if (root.kind !== "mapping") return [];
  const basinEntry = root.entries.find((entry) => displayKey(entry.key)?.toUpperCase() === "BASIN");
  if (!basinEntry || basinEntry.value.kind !== "mapping") return [];

  const fieldDefinitions = [
    { key: "region_name", label: "Region", group: "Basin identity" },
    { key: "basin_name", label: "Basin", group: "Basin identity" },
    { key: "basin_id", label: "Basin ID", group: "Basin identity" },
    { key: "spin_up", label: "Spin-up", group: "Simulation period" },
    { key: "start", label: "Start", group: "Simulation period" },
    { key: "end", label: "End", group: "Simulation period" },
  ];
  const values = fieldDefinitions.flatMap((definition) => {
    const entry = basinEntry.value.entries.find((item) => displayKey(item.key)?.toLowerCase() === definition.key);
    const value = entry?.value;
    if (!value || value.kind !== "scalar" || value.value === null || value.value === undefined) return [];
    const text = String(value.value);
    if (text.trim().length === 0) return [];
    return [{ ...definition, value: text }];
  });

  return ["Basin identity", "Simulation period"].flatMap((title) => {
    const fields = values.filter((field) => field.group === title);
    return fields.length > 0 ? [{ title, fields }] : [];
  });
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
    return <div className="min-h-0 flex-1 space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-2"><YamlValue node={representation.root} /></div>;
  }
  if (representation.kind === "vic_parameter_lines") {
    return <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-slate-200"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-slate-100 text-slate-600"><tr><th className="px-2 py-1">Line</th><th className="px-2 py-1">Kind</th><th className="px-2 py-1">Option / original line</th><th className="px-2 py-1">Value tokens</th></tr></thead><tbody className="divide-y divide-slate-100">{representation.lines.map((line, index) => <tr key={`${line.line_number}-${index}`}><td className="px-2 py-1 text-slate-500">{line.line_number}</td><td className="px-2 py-1 text-slate-500">{line.kind}</td><td className="px-2 py-1 font-mono text-slate-800"><span className="whitespace-pre-wrap break-all">{line.raw || " "}</span></td><td className="px-2 py-1 font-mono text-slate-700">{line.values.join(" | ")}</td></tr>)}</tbody></table></div>;
  }
  if (representation.kind === "routing_positional_records") {
    return <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">{representation.records.length === 0 ? <p className="text-xs text-slate-500">No records were returned.</p> : representation.records.map((record, index) => <section key={`${record.heading_line_number}-${index}`} className="rounded-lg border border-slate-200 bg-white p-2"><h3 className="text-xs font-semibold text-slate-800">{record.heading_raw || record.heading || `Record ${index + 1}`}</h3><pre className="mt-1 whitespace-pre-wrap break-all font-mono text-xs text-slate-700">{record.lines.length ? record.lines.map((line) => `${line.line_number}: ${line.raw}`).join("\n") : "No positional lines"}</pre></section>)}</div>;
  }
  if (representation.kind === "unit_hydrograph_rows") {
    return <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-slate-200"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-slate-100 text-slate-600"><tr><th className="px-2 py-1">Line</th><th className="px-2 py-1">Index token</th><th className="px-2 py-1">Value token</th></tr></thead><tbody className="divide-y divide-slate-100">{representation.rows.length === 0 ? <tr><td colSpan={3} className="px-2 py-3 text-slate-500">No numerical rows were returned.</td></tr> : representation.rows.map((row, index) => <tr key={`${row.line_number}-${index}`}><td className="px-2 py-1 text-slate-500">{row.line_number}</td><td className="px-2 py-1 font-mono">{row.index_token}</td><td className="px-2 py-1 font-mono">{row.value_token}</td></tr>)}</tbody></table></div>;
  }
  return <p className="text-xs text-slate-500">No viewer is available for this representation.</p>;
}

export default function InputsPage({ project, job }: InputsPageProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadNoticeTimer = useRef<number | null>(null);
  const uploadInProgress = useRef(false);
  const currentContext = useRef({ projectId: project?.id, jobId: job?.id });
  currentContext.current = { projectId: project?.id, jobId: job?.id };
  const [uploads, setUploads] = useState<UploadMetadata[]>([]);
  const uploadsRef = useRef<UploadMetadata[]>(uploads);
  uploadsRef.current = uploads;
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploadsLoading, setUploadsLoading] = useState(false);
  const [uploadsError, setUploadsError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<{ message: string; tone: "success" | "error" | "warning" } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<UploadMetadata | null>(null);
  const [deletingUploadId, setDeletingUploadId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [selectedConfigurationUploadId, setSelectedConfigurationUploadId] = useState<string | null>(null);
  const [inspection, setInspection] = useState<UploadInspection | null>(null);
  const [fileInspectionStates, setFileInspectionStates] = useState<Record<string, FileInspectionState>>({});
  const [ratConfigurationInspection, setRatConfigurationInspection] = useState<UploadInspection | null>(null);
  const [ratInspectionLoadingId, setRatInspectionLoadingId] = useState<string | null>(null);
  const [inspectionLoadingId, setInspectionLoadingId] = useState<string | null>(null);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [inspectionErrorUploadId, setInspectionErrorUploadId] = useState<string | null>(null);
  const inspectionRequestId = useRef(0);
  const fileInspectionRequestIds = useRef(new Map<string, number>());
  const ratInspectionRequestId = useRef(0);
  const inspectionSelectionId = useRef<string | null>(null);

  useEffect(() => () => {
    if (uploadNoticeTimer.current !== null) window.clearTimeout(uploadNoticeTimer.current);
  }, []);

  function showUploadNotice(message: string, tone: "success" | "error" | "warning" = "warning") {
    if (uploadNoticeTimer.current !== null) window.clearTimeout(uploadNoticeTimer.current);
    setUploadNotice({ message, tone });
    uploadNoticeTimer.current = window.setTimeout(() => {
      setUploadNotice(null);
      uploadNoticeTimer.current = null;
    }, 3500);
  }

  useEffect(() => {
    if (!project || !job || job.projectId !== project.id) {
      setUploads([]);
      uploadsRef.current = [];
      setFileInspectionStates({});
      fileInspectionRequestIds.current.clear();
      setPendingFile(null);
      setUploadsLoading(false);
      setUploadsError(null);
      setSelectedConfigurationUploadId(null);
      inspectionRequestId.current += 1;
      inspectionSelectionId.current = null;
      setInspection(null);
      setInspectionLoadingId(null);
      setInspectionError(null);
      setInspectionErrorUploadId(null);
      ratInspectionRequestId.current += 1;
      setRatConfigurationInspection(null);
      setRatInspectionLoadingId(null);
      setUploading(false);
      return;
    }

    const savedInspection = readSavedInspection();
    if (savedInspection && (savedInspection.projectId !== project.id || savedInspection.jobId !== job.id)) {
      clearSavedInspection();
    }

    let active = true;
    setUploads([]);
    uploadsRef.current = [];
    setFileInspectionStates({});
    fileInspectionRequestIds.current.clear();
    setPendingFile(null);
    setUploadsLoading(true);
    setUploadsError(null);
    setSelectedConfigurationUploadId(null);
    setPendingDelete(null);
    setDeleteError(null);
    inspectionRequestId.current += 1;
    inspectionSelectionId.current = null;
    setInspection(null);
    setInspectionLoadingId(null);
    setInspectionError(null);
    setInspectionErrorUploadId(null);
    ratInspectionRequestId.current += 1;
    setRatConfigurationInspection(null);
    setRatInspectionLoadingId(null);
    api.listUploads(project.id, job.id).then((records) => {
      if (!active) return;
      setUploads(records);
      const saved = readSavedInspection();
      const ratUpload = records.find((record) => isRatConfigurationFilename(record.original_filename)) ?? null;
      const preferredUpload = ratUpload
        ?? records.find((record) => /\.(yaml|yml|txt)$/i.test(record.original_filename))
        ?? records[0]
        ?? null;
      const sharedSavedId = readSavedInspectionUploadId(project.id, job.id);
      const savedId = sharedSavedId ?? (saved?.projectId === project.id && saved.jobId === job.id ? saved.uploadId : null);
      const selectedUpload = savedId ? records.find((record) => record.id === savedId) ?? preferredUpload : preferredUpload;
      if (savedId && !records.some((record) => record.id === savedId)) clearSavedInspection(project.id, job.id, savedId);
      uploadsRef.current = records;
      setFileInspectionStates({});
      fileInspectionRequestIds.current.clear();
      void Promise.all(records.map((upload) => inspectUploadedFile(upload, upload.id === selectedUpload?.id)));
    }).catch((error: unknown) => {
      if (active) setUploadsError(error instanceof Error ? error.message : "Uploaded files could not be loaded.");
    }).finally(() => {
      if (active) setUploadsLoading(false);
    });

    return () => { active = false; };
  }, [project?.id, job?.id]);

  useEffect(() => {
    function handleUploadInspected(event: Event) {
      const result = (event as CustomEvent<UploadInspection>).detail;
      const { projectId, jobId } = currentContext.current;
      if (!result
        || result.upload.project_id !== projectId
        || result.upload.job_id !== jobId
        || !uploadsRef.current.some((upload) => upload.id === result.upload.id)) return;

      fileInspectionRequestIds.current.set(
        result.upload.id,
        (fileInspectionRequestIds.current.get(result.upload.id) ?? 0) + 1,
      );
      setFileInspectionStates((current) => ({
        ...current,
        [result.upload.id]: { status: result.parse_status, result },
      }));
      if (isRatConfigurationFilename(result.upload.original_filename)) {
        ratInspectionRequestId.current += 1;
        setRatInspectionLoadingId(null);
        setRatConfigurationInspection(result.parse_status === "parsed" && result.detected_format === "rat_yaml" ? result : null);
      }
      inspectionRequestId.current += 1;
      inspectionSelectionId.current = result.upload.id;
      setSelectedConfigurationUploadId(result.upload.id);
      setInspection(result);
      setInspectionLoadingId(null);
      setInspectionError(null);
      setInspectionErrorUploadId(null);
      saveInspectionSelection({ projectId, jobId, uploadId: result.upload.id });
    }
    window.addEventListener(UPLOAD_INSPECTED_EVENT, handleUploadInspected);
    function handleUploadInspectionFailed(event: Event) {
      const detail = (event as CustomEvent<FailedInspectionContext>).detail;
      const { projectId, jobId } = currentContext.current;
      if (!detail
        || detail.projectId !== projectId
        || detail.jobId !== jobId
        || !uploadsRef.current.some((upload) => upload.id === detail.uploadId)) return;

      fileInspectionRequestIds.current.set(
        detail.uploadId,
        (fileInspectionRequestIds.current.get(detail.uploadId) ?? 0) + 1,
      );
      setFileInspectionStates((current) => ({
        ...current,
        [detail.uploadId]: { status: "failed", result: current[detail.uploadId]?.result, error: detail.message },
      }));
      setInspectionLoadingId((current) => current === detail.uploadId ? null : current);
      setInspectionError(detail.message);
      setInspectionErrorUploadId(detail.uploadId);
      if (isRatConfigurationFilename(uploadsRef.current.find((upload) => upload.id === detail.uploadId)?.original_filename ?? "")) {
        ratInspectionRequestId.current += 1;
        setRatInspectionLoadingId(null);
        setRatConfigurationInspection(null);
      }
    }
    window.addEventListener(UPLOAD_INSPECTION_FAILED_EVENT, handleUploadInspectionFailed);
    return () => {
      window.removeEventListener(UPLOAD_INSPECTED_EVENT, handleUploadInspected);
      window.removeEventListener(UPLOAD_INSPECTION_FAILED_EVENT, handleUploadInspectionFailed);
    };
  }, []);

  async function fetchUploadInspection(projectId: string, jobId: string, upload: UploadMetadata): Promise<UploadInspection> {
    const result = await api.inspectUpload(projectId, jobId, upload.id);
    if (result.upload.id !== upload.id || result.upload.project_id !== projectId || result.upload.job_id !== jobId) {
      throw new Error("The API returned inspection data for a different uploaded file.");
    }
    return result;
  }

  async function inspectUploadedFile(upload: UploadMetadata, selectAsLatest = true): Promise<UploadInspection | null> {
    if (!project || !job || job.projectId !== project.id) return null;
    const projectId = project.id;
    const jobId = job.id;
    const isRatUpload = isRatConfigurationFilename(upload.original_filename);
    const fileRequestId = (fileInspectionRequestIds.current.get(upload.id) ?? 0) + 1;
    fileInspectionRequestIds.current.set(upload.id, fileRequestId);
    const previewRequestId = selectAsLatest ? ++inspectionRequestId.current : null;
    const ratRequestId = isRatUpload ? ++ratInspectionRequestId.current : null;
    if (selectAsLatest) {
      inspectionSelectionId.current = upload.id;
      setInspectionError(null);
      setInspectionErrorUploadId(null);
      setInspectionLoadingId(upload.id);
    }
    setFileInspectionStates((current) => ({
      ...current,
      [upload.id]: { status: "loading", result: current[upload.id]?.result },
    }));
    if (ratRequestId !== null) {
      setRatInspectionLoadingId(upload.id);
    }
    const requestIsCurrent = () => fileInspectionRequestIds.current.get(upload.id) === fileRequestId
      && currentContext.current.projectId === projectId
      && currentContext.current.jobId === jobId
      && uploadsRef.current.some((record) => record.id === upload.id);
    try {
      const result = await fetchUploadInspection(projectId, jobId, upload);
      if (!requestIsCurrent()) return null;
      setFileInspectionStates((current) => ({
        ...current,
        [upload.id]: { status: result.parse_status, result },
      }));
      if (ratRequestId !== null && ratInspectionRequestId.current === ratRequestId) {
        if (result.parse_status === "parsed" && result.detected_format === "rat_yaml") {
          setRatConfigurationInspection(result);
        } else {
          setRatConfigurationInspection(null);
        }
        setRatInspectionLoadingId(null);
      }
      if (selectAsLatest
        && inspectionRequestId.current === previewRequestId
        && inspectionSelectionId.current === upload.id) {
        setSelectedConfigurationUploadId(upload.id);
        setInspection(result);
        setInspectionError(null);
        setInspectionErrorUploadId(null);
        saveInspectionSelection({ projectId, jobId, uploadId: upload.id });
        notifyUploadInspected(result);
      }
      return result;
    } catch (error) {
      if (!requestIsCurrent()) return null;
      const message = error instanceof Error ? error.message : "This file could not be inspected.";
      setFileInspectionStates((current) => ({
        ...current,
        [upload.id]: { status: "failed", result: current[upload.id]?.result, error: message },
      }));
      if (selectAsLatest
        && inspectionRequestId.current === previewRequestId
        && inspectionSelectionId.current === upload.id) {
        setInspectionError(message);
        setInspectionErrorUploadId(upload.id);
      }
      if (ratRequestId !== null && ratInspectionRequestId.current === ratRequestId) {
        setRatConfigurationInspection(null);
      }
      return null;
    } finally {
      if (requestIsCurrent()) {
        if (selectAsLatest && inspectionRequestId.current === previewRequestId) setInspectionLoadingId(null);
        if (ratRequestId !== null && ratInspectionRequestId.current === ratRequestId) setRatInspectionLoadingId(null);
      }
    }
  }

  function handleFileSelection(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file || !project || !job || job.projectId !== project.id) return;

    setPendingFile(file);
  }

  async function uploadSelectedFile() {
    if (!pendingFile || !project || !job || job.projectId !== project.id || uploading || uploadInProgress.current) return;
    const file = pendingFile;
    const projectId = project.id;
    const jobId = job.id;
    const isRatUpload = isRatConfigurationFilename(file.name);

    if (uploads.some((upload) => upload.original_filename === file.name)) {
      showUploadNotice(`A file named '${file.name}' already exists in this job. Delete the existing file before uploading a replacement.`, "warning");
      return;
    }

    if (isRatUpload && uploads.some((upload) => isRatConfigurationFilename(upload.original_filename))) {
      showUploadNotice("This job already has a RAT configuration.", "warning");
      return;
    }

    uploadInProgress.current = true;
    setUploading(true);
    setUploadsError(null);

    try {
      const uploaded = await api.uploadFile(projectId, jobId, file);
      if (currentContext.current.projectId !== projectId || currentContext.current.jobId !== jobId) return;
      if (uploaded.project_id !== projectId || uploaded.job_id !== jobId) {
        throw new Error("The API returned upload metadata for a different project or job.");
      }
      if (isRatUpload) {
        ratInspectionRequestId.current += 1;
        setRatConfigurationInspection(null);
        setRatInspectionLoadingId(null);
      }
      setPendingFile(null);
      const updatedUploads = [uploaded, ...uploadsRef.current.filter((item) => item.id !== uploaded.id)];
      uploadsRef.current = updatedUploads;
      setUploads(updatedUploads);
      showUploadNotice(`${uploaded.original_filename} uploaded (${formatFileSize(uploaded.file_size)}). Its contents have not been checked.`, "success");

      try {
        const refreshed = await api.listUploads(projectId, jobId);
        if (currentContext.current.projectId === projectId && currentContext.current.jobId === jobId) {
          uploadsRef.current = refreshed;
          setUploads(refreshed);
        }
      } catch (error) {
        if (currentContext.current.projectId === projectId && currentContext.current.jobId === jobId) {
          setUploadsError(error instanceof Error ? `Upload succeeded, but the file list could not be refreshed: ${error.message}` : "Upload succeeded, but the file list could not be refreshed.");
        }
      }
    } catch (error) {
      if (currentContext.current.projectId === projectId && currentContext.current.jobId === jobId) {
        showUploadNotice(error instanceof Error ? error.message : "The file could not be uploaded.", "error");
      }
    } finally {
      uploadInProgress.current = false;
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
      const remainingUploads = uploadsRef.current.filter((upload) => upload.id !== target.id);
      uploadsRef.current = remainingUploads;
      setUploads(remainingUploads);
      fileInspectionRequestIds.current.set(target.id, (fileInspectionRequestIds.current.get(target.id) ?? 0) + 1);
      setFileInspectionStates((current) => {
        const next = { ...current };
        delete next[target.id];
        return next;
      });
      clearSavedInspection(project.id, job.id, target.id);
      notifyUploadDeleted({ projectId: project.id, jobId: job.id, uploadId: target.id });
      if (isRatConfigurationFilename(target.original_filename)) {
        ratInspectionRequestId.current += 1;
        setRatConfigurationInspection(null);
        setRatInspectionLoadingId(null);
      }
      if (selectedConfigurationUploadId === target.id) {
        const fallback = remainingUploads.find((upload) => {
          const state = fileInspectionStates[upload.id];
          return state?.result && state.status !== "failed" && state.status !== "loading";
        });
        const fallbackResult = fallback ? fileInspectionStates[fallback.id]?.result ?? null : null;
        setSelectedConfigurationUploadId(fallbackResult ? fallback!.id : null);
        setInspection(fallbackResult);
        setInspectionError(null);
        setInspectionErrorUploadId(null);
        if (fallbackResult) {
          saveInspectionSelection({ projectId: project.id, jobId: job.id, uploadId: fallbackResult.upload.id });
          notifyUploadInspected(fallbackResult);
        }
      }
      if (inspectionSelectionId.current === target.id) {
        inspectionRequestId.current += 1;
        inspectionSelectionId.current = null;
        setInspectionLoadingId(null);
        setInspectionError(null);
        setInspectionErrorUploadId(null);
      }
      if (inspectionErrorUploadId === target.id) {
        setInspectionError(null);
        setInspectionErrorUploadId(null);
      }
      showUploadNotice(isRatConfigurationFilename(target.original_filename)
        ? "RAT configuration deleted. Upload and inspect a RAT configuration to restore the configuration overview."
        : `${target.original_filename} deleted.`, "success");
      setPendingDelete(null);
      try {
        const refreshed = await api.listUploads(project.id, job.id);
        if (currentContext.current.projectId === project.id && currentContext.current.jobId === job.id) {
          uploadsRef.current = refreshed;
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

  const currentInspection = inspection?.upload.id === selectedConfigurationUploadId && inspection.upload.project_id === project.id && inspection.upload.job_id === job.id ? inspection : null;
  const ratConfigurationUpload = uploads.find((upload) => isRatConfigurationFilename(upload.original_filename)) ?? null;
  const ratConfigurationReady = Boolean(ratConfigurationUpload
    && ratConfigurationInspection?.upload.id === ratConfigurationUpload.id
    && ratConfigurationInspection.upload.project_id === project.id
    && ratConfigurationInspection.upload.job_id === job.id
    && ratConfigurationInspection.parse_status === "parsed"
    && ratConfigurationInspection.detected_format === "rat_yaml"
    && ratConfigurationInspection.representation?.kind === "yaml_tree");
  const overviewGroups = configurationOverview(ratConfigurationInspection, ratConfigurationUpload?.id ?? null, project.id, job.id);
  const parsedUploadCount = uploads.filter((upload) => fileInspectionStates[upload.id]?.status === "parsed").length;
  const uninspectedUploadCount = uploads.filter((upload) => !fileInspectionStates[upload.id]).length;
  const loadingUploadCount = uploads.filter((upload) => fileInspectionStates[upload.id]?.status === "loading").length;
  const otherInspectionCount = uploads.filter((upload) => {
    const status = fileInspectionStates[upload.id]?.status;
    return status === "malformed" || status === "unsupported" || status === "failed";
  }).length;
  const validationSummaryStatus = uploads.length === 0
    ? "No files uploaded"
    : loadingUploadCount > 0
      ? "Inspection in progress"
      : uninspectedUploadCount > 0
        ? "Inspection incomplete"
        : otherInspectionCount > 0
          ? "Inspection results need review"
          : "All uploaded files inspected";

  return (
    <div className="min-h-[calc(100vh-5rem)] bg-[#f5f8fc] p-3 sm:p-5 xl:h-[calc(100dvh-6rem)] xl:min-h-0 xl:overflow-hidden xl:p-4">
      {uploadNotice && (
        <div
          role={uploadNotice.tone === "error" ? "alert" : "status"}
          aria-live={uploadNotice.tone === "error" ? "assertive" : "polite"}
          className={`fixed bottom-5 right-5 z-[60] max-w-sm rounded-lg border px-4 py-3 text-sm font-medium shadow-lg ${uploadNotice.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : uploadNotice.tone === "error" ? "border-rose-200 bg-rose-50 text-rose-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}
        >
          {uploadNotice.message}
        </div>
      )}
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
              Deleting <strong className="text-slate-800">{pendingDelete.original_filename}</strong> permanently removes this upload from the job and clears its associated inspection results and displayed configuration data.
              {isRatConfigurationFilename(pendingDelete.original_filename) && " The RAT configuration overview and its associated state in Tab 3 will also be cleared."}
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

          <section className="min-w-0 space-y-3 xl:grid xl:h-full xl:min-h-0 xl:grid-rows-[auto_minmax(0,1fr)] xl:gap-3 xl:space-y-0">
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

            <div className="grid gap-3 xl:row-start-2 xl:min-h-0 xl:items-stretch xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-rows-[auto_minmax(0,1fr)]">
            <section className={cardClass + ` min-w-0 xl:col-start-1 xl:row-start-1 ${ratConfigurationReady ? "xl:col-span-1" : "xl:col-span-2"}`} aria-labelledby="config-heading">
              <div className="border-b border-slate-100 pb-1.5">
                <div>
                  <h2 id="config-heading" className="text-sm font-semibold text-slate-900">A. Upload Configuration / Parameter File</h2>
                </div>
              </div>

              <div>
              <div className="grid gap-2 sm:grid-cols-2 sm:gap-3">
                <div className="flex min-w-0 flex-col justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 p-2">
                  <input ref={fileInput} type="file" accept=".yaml,.yml,.txt" disabled={uploading || uploadsLoading} className="sr-only" aria-label="Choose a configuration or parameter file" onChange={handleFileSelection} />
                  <button type="button" disabled={uploading || uploadsLoading} onClick={() => fileInput.current?.click()} className={secondaryButton + " w-full px-2.5 py-1.5 text-xs disabled:cursor-wait disabled:opacity-60"}>{uploadsLoading ? "Loading uploads..." : "Select Configuration File"}</button>
                  <p className="mt-1 text-center text-[10px] leading-3.5 text-slate-500">Choose a supported file from your device.</p>
                </div>

                <div className="flex min-w-0 flex-col justify-between gap-1.5 rounded-lg border border-slate-200 p-2">
                  {pendingFile ? (
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500">Selected file</p>
                        <p className="mt-1 break-all text-xs font-semibold text-slate-800">{pendingFile.name}</p>
                        <p className="mt-0.5 text-[10px] text-slate-500">{formatFileSize(pendingFile.size)}</p>
                      </div>
                      <button type="button" disabled={uploading} onClick={() => setPendingFile(null)} aria-label={`Remove ${pendingFile.name} from the upload selection`} className="grid size-7 shrink-0 place-items-center rounded-md text-lg leading-none text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 disabled:opacity-50"><span aria-hidden="true">&times;</span></button>
                    </div>
                  ) : (
                    <p role="status" className="flex min-h-9 items-center justify-center text-center text-xs text-slate-500">Select a file to preview it here.</p>
                  )}
                  <button type="button" disabled={!pendingFile || uploading || uploadsLoading} onClick={() => void uploadSelectedFile()} className={primaryButton + " w-full px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"}>{uploading ? "Uploading..." : "Upload File"}</button>
                </div>
              </div>
              {ratInspectionLoadingId && <p role="status" className="mt-2 text-xs text-slate-600">Inspecting {ratConfigurationUpload?.original_filename ?? "RAT configuration"}…</p>}
              </div>
            </section>

              <section className={cardClass + " min-w-0 xl:col-start-1 xl:row-start-2 xl:flex xl:min-h-0 xl:flex-col"} aria-labelledby="uploads-heading">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">C. Uploaded files</p>
                  <h2 id="uploads-heading" className="mt-0.5 text-base font-semibold text-slate-900">Job files</h2>
                </div>
              </div>
              <div className="mt-1.5 min-w-0 rounded-lg border border-slate-200 xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
                <div className="min-w-0 p-2">
                  <h3 className="text-xs font-semibold text-slate-800">Uploaded files for this job</h3>
                  <p className="mt-0.5 text-[10px] text-slate-500">Upload metadata only; file contents and scientific validity are not checked.</p>
                  {uploadsLoading && <p className="mt-2 text-xs text-slate-500">Loading uploaded files…</p>}
                  {uploadsError && <p role="alert" className="mt-2 text-xs text-rose-700">{uploadsError}</p>}
                  {!uploadsLoading && !uploadsError && uploads.length === 0 && <p className="mt-2 text-xs text-slate-500">No files uploaded for this job.</p>}
                  {uploads.length > 0 && <div className="mt-1 min-w-0"><table className="w-full min-w-0 table-fixed text-left text-[10px]"><thead className="text-slate-500"><tr><th className="w-[28%] break-words px-1 py-1 font-medium">Filename</th><th className="w-[12%] px-1 py-1 font-medium">Size</th><th className="w-[20%] break-words px-1 py-1 font-medium">Uploaded</th><th className="w-[17%] break-words px-1 py-1 font-medium">Inspection</th><th className="w-[23%] break-words px-1 py-1 font-medium">Actions</th></tr></thead><tbody className="divide-y divide-slate-100">{uploads.map((upload) => <tr key={upload.id}><td className="break-all px-1 py-1.5 font-medium text-slate-700" title={upload.original_filename}>{upload.original_filename}</td><td className="break-words px-1 py-1.5 text-slate-600">{formatFileSize(upload.file_size)}</td><td className="break-words px-1 py-1.5 text-slate-600">{formatUploadDate(upload.uploaded_at)}</td><td className="break-words px-1 py-1.5 text-slate-600">{inspectionStateLabel(fileInspectionStates[upload.id])}</td><td className="px-1 py-1.5"><div className="flex flex-wrap gap-1"><button type="button" disabled={inspectionLoadingId !== null || deletingUploadId !== null || uploading} onClick={() => void inspectUploadedFile(upload)} className="rounded-md px-1.5 py-1 text-[10px] font-semibold text-blue-700 hover:bg-blue-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 disabled:cursor-wait disabled:opacity-50">{inspectionLoadingId === upload.id ? "Inspecting..." : "Inspect"}</button><button type="button" disabled={deletingUploadId !== null || uploading} onClick={() => { setDeleteError(null); setPendingDelete(upload); }} className="rounded-md px-1.5 py-1 text-[10px] font-semibold text-rose-700 hover:bg-rose-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-rose-500 disabled:cursor-not-allowed disabled:opacity-50">Delete</button></div></td></tr>)}</tbody></table></div>}
                </div>
              </div>
            </section>

            {ratConfigurationReady && ratConfigurationInspection && (
              <section className={cardClass + " min-w-0 xl:col-start-2 xl:row-start-1"} aria-labelledby="overview-heading">
                <p id="overview-heading" className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">B. Configuration overview</p>
                {overviewGroups.length > 0 ? (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {overviewGroups.map((group) => (
                      <section key={group.title} className="min-w-0 rounded-lg border border-slate-200 bg-slate-50/60 p-2">
                        <h3 className="text-xs font-semibold text-slate-800">{group.title}</h3>
                        <dl className="mt-1 space-y-0.5">
                          {group.fields.map((field) => (
                            <div key={field.key} className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] gap-x-1.5 border-b border-slate-200/70 py-0.5 last:border-0">
                              <dt className="text-[11px] font-medium leading-4 text-slate-500">{field.label}</dt>
                              <dd className="min-w-0 break-words text-xs leading-4 text-slate-800">{field.value}</dd>
                            </div>
                          ))}
                        </dl>
                      </section>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-600">No basin identity or simulation-period values were found in this configuration.</p>
                )}
              </section>
            )}

            <section className={cardClass + " min-w-0 xl:col-start-2 xl:row-start-2 xl:flex xl:min-h-0 xl:flex-col"} aria-labelledby="validation-heading">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">D. VALIDATION SUMMARY</p>
                  <h2 id="validation-heading" className="mt-0.5 text-base font-semibold text-slate-900">{validationSummaryStatus}</h2>
                </div>
              </div>
              {uploadsLoading ? <p role="status" className="mt-2 text-xs text-slate-500">Loading inspection progress…</p> : uploads.length === 0 ? (
                <p className="mt-2 text-xs text-slate-600">No uploaded files are available to inspect.</p>
              ) : (
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg bg-slate-50 p-2 text-xs">
                  <div className="flex justify-between gap-2"><dt className="text-slate-500">Uploaded</dt><dd className="font-semibold text-slate-800">{uploads.length}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-slate-500">Parsed</dt><dd className="font-semibold text-slate-800">{parsedUploadCount}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-slate-500">Not inspected</dt><dd className="font-semibold text-slate-800">{uninspectedUploadCount}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-slate-500">Other results/errors</dt><dd className="font-semibold text-slate-800">{otherInspectionCount}</dd></div>
                  {loadingUploadCount > 0 && <div className="col-span-2 text-slate-600">Currently inspecting: {loadingUploadCount}</div>}
                </dl>
              )}
            </section>

            </div>

          </section>

          <aside className="min-w-0 space-y-2 xl:flex xl:h-full xl:min-h-0 xl:flex-col xl:space-y-0 xl:overflow-hidden">
            <div className="min-h-0 space-y-2 xl:flex xl:flex-1 xl:flex-col xl:gap-2 xl:overflow-hidden xl:space-y-0">
            <section className={cardClass + (currentInspection ? " flex min-h-0 flex-1 flex-col" : " shrink-0")} aria-labelledby="preview-heading">
              {inspectionError && <div role="alert" className="mb-2 rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800"><p className="font-semibold">Inspection failed for {uploads.find((upload) => upload.id === inspectionErrorUploadId)?.original_filename ?? "the selected upload"}.</p><p className="mt-0.5">{inspectionError}</p>{currentInspection && <p className="mt-1 text-rose-700">The last successful preview remains displayed.</p>}</div>}
              {currentInspection ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <h2 id="preview-heading" className="text-sm font-semibold text-blue-700">File inspection</h2>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">{currentInspection.parse_status}</span>
                  </div>
                  <p className="mt-1 break-words text-xs font-medium text-slate-800">{currentInspection.upload.original_filename} - {currentInspection.detected_format.replaceAll("_", " ")}</p>
                  <div className="mt-1 grid grid-cols-1 gap-1 text-[10px] text-slate-600">
                    <span>RAT compatibility: {currentInspection.rat_compatibility}</span>
                    <span>Dependency availability: {currentInspection.dependency_availability}</span>
                    <span>Scientific validity: {currentInspection.scientific_validity}</span>
                  </div>
                  {currentInspection.parse_errors.length > 0 && <ul className="mt-2 space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-2">{currentInspection.parse_errors.map((error, index) => <li key={`${error.code}-${index}`} className="text-xs text-amber-900">{error.message}</li>)}</ul>}
                  <div className="mt-2 flex min-h-0 flex-1 flex-col border-t border-slate-100 pt-2"><InspectionRepresentationView inspection={currentInspection} /></div>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <h2 id="preview-heading" className="text-sm font-semibold text-blue-700">Configuration preview</h2>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">Example only</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-4 text-slate-500">Not loaded from the selected job or GangaServer.</p>
                  {inspectionLoadingId ? <p role="status" className="mt-2 text-xs text-slate-600">Inspecting selected upload...</p> : null}
                  <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-2.5 text-[10px] leading-[14px] text-slate-100"><code>{exampleConfiguration}</code></pre>
                </>
              )}
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
