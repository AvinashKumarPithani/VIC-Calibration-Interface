import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { CalibrationJob, Project } from "../setup/types";
import { api, type InspectedYamlNode, type ParameterDraft, type ParameterDraftChange, type UploadInspection, type UploadMetadata } from "../../lib/api";
import { clearSavedInspectionUploadId, readSavedInspectionUploadId, saveInspectionUploadId } from "../../lib/inspectionState";
import { notifyUploadDeleted, notifyUploadInspectionFailed, notifyUploadInspected, UPLOAD_DELETED_EVENT, UPLOAD_INSPECTED_EVENT, type DeletedUploadContext } from "../../lib/uploadEvents";
import InspectionViewer from "./components/InspectionViewer";
import ParameterEditPanel from "./components/ParameterEditPanel";
import NetCDFValueEditor from "./components/NetCDFValueEditor";

interface CalibrationPageProps {
  project: Project | null;
  job: CalibrationJob | null;
  isActive: boolean;
}

function fileType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toUpperCase() : "File";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function countYamlNodes(node: InspectedYamlNode): number {
  if (node.kind === "mapping") return node.entries.reduce((sum, entry) => sum + countYamlNodes(entry.value), 0);
  if (node.kind === "sequence") return node.items.reduce((sum, item) => sum + countYamlNodes(item), 0);
  return node.kind === "scalar" || node.kind === "null" || node.kind === "redacted" ? 1 : 0;
}

function recordSummary(inspection: UploadInspection): string | null {
  const representation = inspection.representation;
  if (!representation) return null;
  switch (representation.kind) {
    case "yaml_tree": return `${countYamlNodes(representation.root)} values`;
    case "vic_parameter_lines": return `${representation.lines.filter((line) => line.kind === "entry").length} entries`;
    case "routing_positional_records": return `${representation.records.length} records`;
    case "unit_hydrograph_rows": return `${representation.rows.length} rows`;
    case "netcdf_dataset": return `${representation.variable_count} variables`;
  }
}

const card = "rounded-xl border border-slate-200 bg-white shadow-sm";

function preferredUpload(uploads: UploadMetadata[]): UploadMetadata | null {
  return uploads.find((upload) => upload.original_filename.toLowerCase() === "vic_soil_param.nc")
    ?? uploads.find((upload) => upload.original_filename.toLowerCase() === "vic_domain.nc")
    ?? null;
}

export default function CalibrationPage({ project, job, isActive }: CalibrationPageProps) {
  const [uploads, setUploads] = useState<UploadMetadata[]>([]);
  const uploadsRef = useRef<UploadMetadata[]>(uploads);
  uploadsRef.current = uploads;
  const [uploadsLoading, setUploadsLoading] = useState(false);
  const [uploadsError, setUploadsError] = useState<string | null>(null);
  const [netcdfFile, setNetcdfFile] = useState<File | null>(null);
  const [netcdfUploadLoading, setNetcdfUploadLoading] = useState(false);
  const [netcdfUploadError, setNetcdfUploadError] = useState<string | null>(null);
  const [netcdfUploadNotice, setNetcdfUploadNotice] = useState<string | null>(null);
  const [netcdfDeleteError, setNetcdfDeleteError] = useState<string | null>(null);
  const [netcdfDeleteNotice, setNetcdfDeleteNotice] = useState<string | null>(null);
  const [deletingUploadId, setDeletingUploadId] = useState<string | null>(null);
  const netcdfInputRef = useRef<HTMLInputElement>(null);
  const [selectedUploadId, setSelectedUploadId] = useState<string | null>(null);
  const [netcdfVariableSelection, setNetcdfVariableSelection] = useState<{ uploadId: string; name: string } | null>(null);
  const [inspection, setInspection] = useState<UploadInspection | null>(null);
  const [inspectionLoading, setInspectionLoading] = useState(false);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [parameterDraft, setParameterDraft] = useState<ParameterDraft | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftSaveError, setDraftSaveError] = useState<string | null>(null);
  const [draftSaving, setDraftSaving] = useState(false);
  const [editingParameters, setEditingParameters] = useState(false);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const draftRequestId = useRef(0);
  const requestId = useRef(0);
  const uploadsRequestId = useRef(0);
  const selectedUploadRef = useRef<string | null>(null);
  const contextRef = useRef({ projectId: project?.id, jobId: job?.id });
  const wasActive = useRef(isActive);
  const contextLoadForCurrentRender = useRef(false);
  contextRef.current = { projectId: project?.id, jobId: job?.id };

  async function loadUploads(projectId: string, jobId: string, options: { keepSelectionEmpty?: boolean } = {}) {
    const currentRequest = ++uploadsRequestId.current;
    setUploadsLoading(true);
    setUploadsError(null);
    try {
      const records = await api.listUploads(projectId, jobId, "netcdf_parameter_dataset");
      if (uploadsRequestId.current === currentRequest
        && contextRef.current.projectId === projectId
        && contextRef.current.jobId === jobId) {
        setUploads(records);
        uploadsRef.current = records;
        const currentId = selectedUploadRef.current;
        const savedId = readSavedInspectionUploadId(projectId, jobId);
        const validCurrentId = currentId && records.some((upload) => upload.id === currentId) ? currentId : null;
        const validSavedId = savedId && records.some((upload) => upload.id === savedId) ? savedId : null;
        const nextUpload = records.find((upload) => upload.id === (validCurrentId ?? validSavedId))
          ?? (options.keepSelectionEmpty ? null : preferredUpload(records));
        const nextId = nextUpload?.id ?? null;

        if (nextId !== currentId) {
          requestId.current += 1;
          selectedUploadRef.current = nextId;
          setInspection(null);
          setInspectionLoading(false);
          setInspectionError(null);
          setParameterDraft(null);
          setEditingParameters(false);
          setDraftError(null);
          setSelectedUploadId(nextId);
        }
        if (nextId) {
          selectedUploadRef.current = nextId;
          if (selectedUploadId !== nextId) setSelectedUploadId(nextId);
        } else {
          selectedUploadRef.current = null;
          setSelectedUploadId(null);
          setInspection(null);
          setInspectionLoading(false);
          setInspectionError(null);
          clearSavedInspectionUploadId(projectId, jobId);
        }
      }
    } catch (error) {
      if (uploadsRequestId.current === currentRequest
        && contextRef.current.projectId === projectId
        && contextRef.current.jobId === jobId) {
        setUploadsError(error instanceof Error ? error.message : "Uploaded files could not be loaded.");
      }
    } finally {
      if (uploadsRequestId.current === currentRequest) setUploadsLoading(false);
    }
  }

  useEffect(() => {
    requestId.current += 1;
    uploadsRequestId.current += 1;
    selectedUploadRef.current = null;
    setUploads([]);
    setUploadsError(null);
    setNetcdfFile(null);
    setNetcdfUploadError(null);
    setNetcdfUploadNotice(null);
    setNetcdfDeleteError(null);
    setNetcdfDeleteNotice(null);
    setSelectedUploadId(null);
    setNetcdfVariableSelection(null);
    setInspection(null);
    setInspectionLoading(false);
    setInspectionError(null);
    setParameterDraft(null);
    setDraftError(null);
    setDraftSaveError(null);
    setEditingParameters(false);
    setDraftNotice(null);

    if (!project || !job || job.projectId !== project.id) {
      setUploadsLoading(false);
      setUploadsError(null);
      return;
    }

    if (!isActive) {
      setUploadsLoading(false);
      return;
    }

    const projectId = project.id;
    const jobId = job.id;
    contextLoadForCurrentRender.current = true;
    void loadUploads(projectId, jobId);

    return () => { uploadsRequestId.current += 1; };
  }, [project?.id, job?.id]);

  useEffect(() => {
    const becameActive = isActive && !wasActive.current;
    wasActive.current = isActive;
    const contextAlreadyLoaded = contextLoadForCurrentRender.current;
    contextLoadForCurrentRender.current = false;
    if (becameActive && !contextAlreadyLoaded && project && job && job.projectId === project.id) {
      void loadUploads(project.id, job.id);
    }
  }, [isActive]);

  useEffect(() => {
    function handleUploadDeleted(event: Event) {
      const detail = (event as CustomEvent<DeletedUploadContext>).detail;
      if (!detail || contextRef.current.projectId !== detail.projectId || contextRef.current.jobId !== detail.jobId) return;
      setUploads((current) => {
        const next = current.filter((upload) => upload.id !== detail.uploadId);
        uploadsRef.current = next;
        return next;
      });
      if (selectedUploadRef.current !== detail.uploadId) return;
      requestId.current += 1;
      selectedUploadRef.current = null;
      setSelectedUploadId(null);
      setInspection(null);
      setInspectionLoading(false);
      setInspectionError(null);
      setParameterDraft(null);
      setEditingParameters(false);
      setDraftError(null);
      setDraftSaveError(null);
      setDraftNotice(null);
      draftRequestId.current += 1;
      clearSavedInspectionUploadId(detail.projectId, detail.jobId, detail.uploadId);
    }
    window.addEventListener(UPLOAD_DELETED_EVENT, handleUploadDeleted);
    function handleUploadInspected(event: Event) {
      const result = (event as CustomEvent<UploadInspection>).detail;
      if (!result
        || contextRef.current.projectId !== result.upload.project_id
        || contextRef.current.jobId !== result.upload.job_id
        || !uploadsRef.current.some((upload) => upload.id === result.upload.id)) return;
      requestId.current += 1;
      draftRequestId.current += 1;
      selectedUploadRef.current = result.upload.id;
      setSelectedUploadId(result.upload.id);
      setInspection(result);
      setInspectionLoading(false);
      setInspectionError(null);
      setParameterDraft(null);
      setDraftError(null);
      setDraftSaveError(null);
      setEditingParameters(false);
      setDraftNotice(null);
      saveInspectionUploadId(result.upload.project_id, result.upload.job_id, result.upload.id);
    }
    window.addEventListener(UPLOAD_INSPECTED_EVENT, handleUploadInspected);
    return () => {
      window.removeEventListener(UPLOAD_DELETED_EVENT, handleUploadDeleted);
      window.removeEventListener(UPLOAD_INSPECTED_EVENT, handleUploadInspected);
    };
  }, []);

  useEffect(() => {
    if (!isActive || !selectedUploadId || inspection || inspectionLoading || uploadsLoading || inspectionError) return;
    const selected = uploads.find((upload) => upload.id === selectedUploadId);
    if (selected) void selectUpload(selected);
    else {
      selectedUploadRef.current = null;
      setSelectedUploadId(null);
    }
  }, [isActive, selectedUploadId, inspection, inspectionLoading, uploadsLoading, inspectionError, uploads]);

  useEffect(() => {
    const projectId = project?.id;
    const jobId = job?.id;
    const uploadId = selectedUploadId;
    if (!projectId || !jobId || !uploadId || job?.projectId !== projectId || inspection?.upload.id !== uploadId) {
      setParameterDraft(null);
      setDraftLoading(false);
      return;
    }
    const currentRequest = ++draftRequestId.current;
    setDraftLoading(true);
    setDraftError(null);
    void api.getParameterDraft(projectId, jobId, uploadId).then((saved) => {
      if (draftRequestId.current === currentRequest
        && contextRef.current.projectId === projectId
        && contextRef.current.jobId === jobId
        && selectedUploadRef.current === uploadId) {
        setParameterDraft(saved);
      }
    }).catch((error: unknown) => {
      if (draftRequestId.current === currentRequest) {
        setDraftError(error instanceof Error ? error.message : "Saved parameter draft could not be loaded.");
      }
    }).finally(() => {
      if (draftRequestId.current === currentRequest) setDraftLoading(false);
    });
    return () => { draftRequestId.current += 1; };
  }, [project?.id, job?.id, selectedUploadId, inspection?.upload.id]);

  async function saveDraft(changes: ParameterDraftChange[], expectedRevision: number | null) {
    if (!project || !job || job.projectId !== project.id || !selectedUploadId || !inspection) return;
    if (inspection.detected_format === "unknown" || inspection.detected_format === "vic_netcdf") {
      setDraftSaveError("This inspection does not have a supported editable file type.");
      return;
    }
    const projectId = project.id;
    const jobId = job.id;
    const uploadId = selectedUploadId;
    setDraftSaving(true);
    setDraftSaveError(null);
    try {
      const saved = await api.saveParameterDraft(projectId, jobId, uploadId, {
        expected_revision: expectedRevision,
        source_format: inspection.detected_format,
        changes,
      });
      if (contextRef.current.projectId === projectId
        && contextRef.current.jobId === jobId
        && selectedUploadRef.current === uploadId) {
        setParameterDraft(saved);
        setEditingParameters(false);
        setDraftNotice("Parameter draft saved. The uploaded source file is unchanged.");
      }
    } catch (error) {
      if (contextRef.current.projectId === projectId
        && contextRef.current.jobId === jobId
        && selectedUploadRef.current === uploadId) {
        setDraftSaveError(error instanceof Error ? error.message : "Parameter draft could not be saved.");
      }
    } finally {
      setDraftSaving(false);
    }
  }

  async function discardDraft() {
    if (!project || !job || !selectedUploadId || !parameterDraft) return;
    if (!window.confirm(`Discard the saved parameter draft for ${selectedUpload?.original_filename ?? "this file"}?`)) return;
    const projectId = project.id;
    const jobId = job.id;
    const uploadId = selectedUploadId;
    try {
      await api.discardParameterDraft(projectId, jobId, uploadId);
      if (contextRef.current.projectId === projectId && contextRef.current.jobId === jobId && selectedUploadRef.current === uploadId) {
        setParameterDraft(null);
        setDraftNotice("Saved parameter draft discarded.");
      }
    } catch (error) {
      if (contextRef.current.projectId === projectId
        && contextRef.current.jobId === jobId
        && selectedUploadRef.current === uploadId) {
        setDraftError(error instanceof Error ? error.message : "Saved parameter draft could not be discarded.");
      }
    }
  }

  async function selectUpload(upload: UploadMetadata) {
    if (!project || !job || job.projectId !== project.id) return;
    if (selectedUploadId === upload.id && inspection?.upload.id === upload.id) return;
    const projectId = project.id;
    const jobId = job.id;
    const currentRequest = ++requestId.current;
    draftRequestId.current += 1;
    selectedUploadRef.current = upload.id;
    if (selectedUploadId !== upload.id) setNetcdfVariableSelection(null);
    setSelectedUploadId(upload.id);
    setInspection(null);
    setInspectionError(null);
    setParameterDraft(null);
    setDraftError(null);
    setDraftSaveError(null);
    setEditingParameters(false);
    setDraftNotice(null);
    setInspectionLoading(true);

    try {
      const result = await api.inspectUpload(projectId, jobId, upload.id, "netcdf_parameter_dataset");
      if (result.upload.id !== upload.id || result.upload.project_id !== projectId || result.upload.job_id !== jobId) {
        throw new Error("The API returned inspection data for a different uploaded file.");
      }
      if (requestId.current === currentRequest
        && selectedUploadRef.current === upload.id
        && contextRef.current.projectId === projectId
        && contextRef.current.jobId === jobId) {
        setInspection(result);
        saveInspectionUploadId(projectId, jobId, upload.id);
        notifyUploadInspected(result);
      }
    } catch (error) {
      if (requestId.current === currentRequest
        && selectedUploadRef.current === upload.id
        && contextRef.current.projectId === projectId
        && contextRef.current.jobId === jobId) {
        const message = error instanceof Error ? error.message : "This file could not be inspected.";
        setInspectionError(message);
        notifyUploadInspectionFailed({ projectId, jobId, uploadId: upload.id, message });
      }
    } finally {
      if (requestId.current === currentRequest) setInspectionLoading(false);
    }
  }

  async function uploadNetcdfFile() {
    if (!project || !job || job.projectId !== project.id || !netcdfFile) return;
    if (!netcdfFile.name.toLowerCase().endsWith(".nc")) {
      setNetcdfUploadError("Select a .nc NetCDF file.");
      return;
    }
    if (netcdfFile.size > 256 * 1024 * 1024) {
      setNetcdfUploadError("The NetCDF file exceeds the 256 MiB limit.");
      return;
    }
    const projectId = project.id;
    const jobId = job.id;
    setNetcdfUploadLoading(true);
    setNetcdfUploadError(null);
    setNetcdfUploadNotice(null);
    setNetcdfDeleteError(null);
    setNetcdfDeleteNotice(null);
    try {
      const uploaded = await api.uploadFile(projectId, jobId, netcdfFile, "netcdf_parameter_dataset");
      if (contextRef.current.projectId !== projectId || contextRef.current.jobId !== jobId) return;
      setNetcdfUploadNotice(`${uploaded.original_filename} uploaded successfully.`);
      setNetcdfFile(null);
      if (netcdfInputRef.current) netcdfInputRef.current.value = "";
      await loadUploads(projectId, jobId);
      await selectUpload(uploaded);
    } catch (error) {
      if (contextRef.current.projectId === projectId && contextRef.current.jobId === jobId) {
        setNetcdfUploadError(error instanceof Error ? error.message : "The NetCDF file could not be uploaded.");
      }
    } finally {
      setNetcdfUploadLoading(false);
    }
  }

  async function deleteNetcdfUpload(upload: UploadMetadata) {
    if (!project || !job || job.projectId !== project.id || deletingUploadId) return;
    const filename = upload.original_filename;
    const confirmed = window.confirm(
      `Delete ${filename}? This removes the uploaded file and its associated inspection result and saved draft from this job. This action cannot be undone.`,
    );
    if (!confirmed) return;

    const projectId = project.id;
    const jobId = job.id;
    setDeletingUploadId(upload.id);
    setNetcdfDeleteError(null);
    setNetcdfDeleteNotice(null);
    try {
      await api.deleteUpload(projectId, jobId, upload.id, "netcdf_parameter_dataset");
      if (contextRef.current.projectId !== projectId || contextRef.current.jobId !== jobId) return;
      notifyUploadDeleted({ projectId, jobId, uploadId: upload.id });
      await loadUploads(projectId, jobId, { keepSelectionEmpty: true });
      if (contextRef.current.projectId === projectId && contextRef.current.jobId === jobId) {
        setNetcdfDeleteNotice(`${filename} was deleted.`);
      }
    } catch (error) {
      if (contextRef.current.projectId === projectId && contextRef.current.jobId === jobId) {
        setNetcdfDeleteError(error instanceof Error ? error.message : `${filename} could not be deleted.`);
      }
    } finally {
      setDeletingUploadId(null);
    }
  }

  const selectedUpload = uploads.find((upload) => upload.id === selectedUploadId) ?? null;
  const summary = inspection ? recordSummary(inspection) : null;
  const inspectedNetCDF = inspection?.representation?.kind === "netcdf_dataset" ? inspection.representation : null;
  const netcdfEditorVariableName = selectedUploadId && netcdfVariableSelection?.uploadId === selectedUploadId
    ? netcdfVariableSelection.name
    : inspectedNetCDF?.variables.find((variable) => !variable.is_coordinate)?.name ?? null;

  if (!project || !job || job.projectId !== project.id) {
    return (
      <section className="min-h-[calc(100vh-5rem)] bg-[#f5f8fc] px-5 py-10 sm:px-8">
        <div className="mx-auto max-w-4xl">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Step 03 / RAT + VIC calibration</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">3. Parameters &amp; Calibration</h1>
          <div className={`${card} mt-6 border-dashed p-6 text-center`}>
            <h2 className="text-lg font-semibold text-slate-900">Select a project and job first</h2>
            <p className="mt-2 text-sm text-slate-600">Choose the project and job in Setup before exploring uploaded parameters.</p>
            <Link to="/setup" className="mt-4 inline-flex rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">Go to Setup</Link>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="min-h-[calc(100vh-5rem)] bg-[#f5f8fc] p-3 sm:p-5 xl:h-[calc(100dvh-6rem)] xl:min-h-0 xl:overflow-hidden xl:p-4">
      <div className="mx-auto flex max-w-[1680px] flex-col gap-3 xl:h-full xl:min-h-0">
        <header className="flex flex-col gap-2 px-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Step 03 / RAT + VIC calibration</p>
            <h1 className="mt-1 text-xl font-bold tracking-tight text-slate-950 sm:text-2xl">3. Parameters &amp; Calibration</h1>
            <p className="mt-1 text-sm text-slate-600">Explore parameter groups returned by inspection of this job's uploaded files.</p>
          </div>
          <div className="text-sm text-slate-600 sm:text-right"><p><span className="font-medium text-slate-500">Project</span> {project.name}</p><p><span className="font-medium text-slate-500">Job</span> {job.name}</p></div>
        </header>

        <div className="grid min-h-0 gap-3 xl:flex-1 xl:grid-cols-[minmax(250px,320px)_minmax(0,1fr)]">
          <aside className={`${card} flex min-h-[300px] flex-col p-3 xl:min-h-0`} aria-label="NetCDF files uploaded to the current job">
            <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-3">
              <div><h2 className="text-sm font-semibold text-slate-900">NetCDF files</h2><p className="mt-0.5 text-xs text-slate-500">{uploads.length} uploaded</p></div>
              <button type="button" onClick={() => { const currentProject = project; const currentJob = job; if (currentProject && currentJob && currentJob.projectId === currentProject.id) void loadUploads(currentProject.id, currentJob.id); }} disabled={uploadsLoading} className="rounded-md px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50">{uploadsLoading ? "Loading..." : "Refresh"}</button>
            </div>
            <div className="mt-3 rounded-lg border border-sky-100 bg-sky-50/60 p-3">
              <h3 className="text-xs font-semibold text-slate-900">Upload VIC NetCDF dataset</h3>
              <p className="mt-1 text-[11px] leading-4 text-slate-600">Choose a NetCDF .nc file (maximum 256 MiB).</p>
              <input
                ref={netcdfInputRef}
                type="file"
                accept=".nc"
                aria-label="Select a VIC NetCDF dataset"
                disabled={netcdfUploadLoading || uploadsLoading}
                onChange={(event) => {
                  setNetcdfUploadError(null);
                  setNetcdfUploadNotice(null);
                  setNetcdfFile(event.target.files?.[0] ?? null);
                }}
                className="mt-2 block w-full text-xs text-slate-700 file:mr-2 file:rounded-md file:border-0 file:bg-white file:px-2.5 file:py-1.5 file:text-xs file:font-semibold file:text-slate-700"
              />
              {netcdfFile && <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-600"><p className="break-all">{netcdfFile.name} · {formatSize(netcdfFile.size)}</p><button type="button" aria-label="Clear selected NetCDF file" disabled={netcdfUploadLoading} onClick={() => { setNetcdfFile(null); if (netcdfInputRef.current) netcdfInputRef.current.value = ""; }} className="shrink-0 rounded px-1 text-slate-600 hover:bg-white">Clear</button></div>}
              {netcdfUploadError && <p role="alert" className="mt-2 text-xs text-rose-700">{netcdfUploadError}</p>}
              {netcdfUploadNotice && <p role="status" className="mt-2 text-xs text-emerald-700">{netcdfUploadNotice}</p>}
              {netcdfDeleteError && <p role="alert" className="mt-2 text-xs text-rose-700">{netcdfDeleteError}</p>}
              {netcdfDeleteNotice && <p role="status" className="mt-2 text-xs text-emerald-700">{netcdfDeleteNotice}</p>}
              <button type="button" onClick={() => void uploadNetcdfFile()} disabled={!netcdfFile || netcdfUploadLoading || uploadsLoading} className="mt-2 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                {netcdfUploadLoading ? "Uploading and inspecting..." : "Upload NetCDF"}
              </button>
            </div>
            {uploadsError && <p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">{uploadsError}</p>}
            <div className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto">
              {uploadsLoading && uploads.length === 0 ? <p role="status" className="p-2 text-sm text-slate-500">Loading job files...</p> : null}
              {!uploadsLoading && !uploadsError && uploads.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-300 p-4 text-center"><p className="text-sm font-medium text-slate-700">No NetCDF datasets uploaded for this job</p><p className="mt-1 text-xs text-slate-500">Upload a supported VIC NetCDF file above to inspect it.</p></div>
              ) : uploads.map((upload) => (
                <div key={upload.id} className={`flex items-start gap-1 rounded-lg border p-1 transition ${selectedUploadId === upload.id ? "border-blue-300 bg-blue-50 ring-1 ring-blue-200" : "border-transparent hover:border-slate-200 hover:bg-slate-50"}`}>
                  <button type="button" aria-pressed={selectedUploadId === upload.id} onClick={() => void selectUpload(upload)} className="min-w-0 flex-1 rounded-md p-1.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500">
                    <span className="flex items-start justify-between gap-2"><span className="min-w-0 break-words text-sm font-semibold text-slate-800">{upload.original_filename}</span><span className="shrink-0 rounded bg-white/80 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">{fileType(upload.original_filename)}</span></span>
                    <span className="mt-1 block text-xs text-slate-500">{formatSize(upload.file_size)} | {formatDate(upload.uploaded_at)}</span>
                    {inspectionLoading && selectedUploadId === upload.id && <span className="mt-1 block text-xs text-blue-700">Inspecting...</span>}
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${upload.original_filename}`}
                    title={`Delete ${upload.original_filename}`}
                    disabled={deletingUploadId !== null}
                    onClick={(event) => { event.stopPropagation(); void deleteNetcdfUpload(upload); }}
                    className="mt-1 shrink-0 rounded-md p-2 text-slate-500 hover:bg-rose-50 hover:text-rose-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 disabled:opacity-40"
                  >
                    {deletingUploadId === upload.id ? <span className="block h-4 w-4 animate-pulse text-xs" aria-hidden="true">…</span> : <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4"><path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M10 11v6m4-6v6M5.5 7l1 13h11l1-13M9 7V4h6v3" /></svg>}
                  </button>
                </div>
              ))}
            </div>
          </aside>

          <main className={`${card} flex min-h-[420px] min-w-0 flex-col p-3 sm:p-4 xl:min-h-0`} aria-live="polite">
            {!selectedUpload ? (
              <div className="grid flex-1 place-items-center rounded-lg border border-dashed border-slate-200 bg-slate-50 p-6 text-center"><div><h2 className="text-base font-semibold text-slate-800">Select a file to inspect</h2><p className="mt-1 max-w-md text-sm text-slate-500">Choose an uploaded file to load its detected structure and read-only parameter groups.</p></div></div>
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3">
                  <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Selected upload</p><h2 className="mt-1 break-words text-base font-semibold text-slate-900">{selectedUpload.original_filename}</h2><p className="mt-1 text-xs text-slate-500">{fileType(selectedUpload.original_filename)} | {formatSize(selectedUpload.file_size)} | Uploaded {formatDate(selectedUpload.uploaded_at)}</p></div>
                  {inspection && <div className="flex flex-wrap items-center justify-end gap-2">
                    <div className="flex flex-wrap gap-1.5 text-[10px]">{[inspection.detected_format.replaceAll("_", " "), inspection.parse_status, summary, parameterDraft ? `Draft v${parameterDraft.revision}` : null].filter((item): item is string => item !== null).map((item) => <span key={item} className="rounded-full bg-slate-100 px-2 py-1 font-medium capitalize text-slate-700">{item}</span>)}</div>
                    {selectedUpload && project && job && <button type="button" onClick={() => void api.downloadNetcdf(project.id, job.id, selectedUpload.id).then((blob) => { const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = selectedUpload.original_filename; anchor.click(); URL.revokeObjectURL(url); }).catch((error: unknown) => setNetcdfDeleteError(error instanceof Error ? error.message : "Download failed."))} className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700">Download .nc</button>}
                    {inspection.parse_status === "parsed" && inspection.representation && inspection.detected_format !== "vic_netcdf" && !editingParameters && <button type="button" onClick={() => { setDraftSaveError(null); setEditingParameters(true); }} className="rounded-md border border-blue-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50">Edit Parameters</button>}
                  </div>}
                </div>
                {inspectionLoading && <p role="status" className="mb-3 rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-800">Loading inspection data...</p>}
                {inspectionError && <div role="alert" className="mb-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"><p className="font-medium">Inspection failed</p><p className="mt-1">{inspectionError}</p><button type="button" onClick={() => void selectUpload(selectedUpload)} className="mt-2 font-semibold underline">Retry</button></div>}
                {inspection && !inspectionLoading && (
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {inspection.detected_format === "vic_netcdf" && inspection.representation?.kind === "netcdf_dataset" && project && job && selectedUploadId && <NetCDFValueEditor key={selectedUploadId} projectId={project.id} jobId={job.id} uploadId={selectedUploadId} dataset={inspection.representation} selectedVariable={netcdfEditorVariableName} onVariableChange={(name) => setNetcdfVariableSelection({ uploadId: selectedUploadId, name })} onSaved={(artifact) => {
                      setUploads((current) => [artifact, ...current]);
                      uploadsRef.current = [artifact, ...uploadsRef.current];
                      setNetcdfUploadNotice(`Verified output ${artifact.original_filename} is ready. Select it in the file list to inspect it.`);
                    }} />}
                    {inspection.parse_status !== "parsed" && <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3"><h3 className="text-sm font-semibold text-amber-900">Inspection: {inspection.parse_status}</h3>{inspection.parse_errors.length === 0 ? <p className="mt-1 text-xs text-amber-800">No additional diagnostics were returned.</p> : <ul className="mt-1 list-inside list-disc space-y-1">{inspection.parse_errors.map((error, index) => <li key={`${error.code}-${index}`} className="text-xs text-amber-900">{error.message}{error.line !== null ? ` (line ${error.line}${error.column !== null ? `, column ${error.column}` : ""})` : ""}</li>)}</ul>}</div>}
                    {inspection.parse_status === "parsed" && inspection.detected_format !== "vic_netcdf" && <div className="mb-3 rounded-lg border border-sky-100 bg-sky-50 px-3 py-2 text-xs text-sky-900">Parsed structure only. RAT compatibility, dependency availability, and scientific validity: not checked.</div>}
                    {draftLoading && <p role="status" className="mb-2 text-xs text-slate-500">Loading saved parameter draft...</p>}
                    {draftError && <p role="alert" className="mb-2 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-800">{draftError}</p>}
                    {draftNotice && <p role="status" className="mb-2 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{draftNotice}</p>}
                    {parameterDraft && parameterDraft.changes.length > 0 && <section className="mb-3 rounded-lg border border-violet-200 bg-violet-50/60 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-violet-950">Saved draft changes</h3><button type="button" onClick={() => void discardDraft()} className="rounded-md px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50">Discard Draft</button></div>
                      <ul className="mt-2 space-y-2">{parameterDraft.changes.map((change) => { const field = inspection.editable_fields.find((item) => item.field_id === change.field_id); return <li key={change.field_id} className="break-words rounded-md bg-white px-3 py-2 text-xs"><span className="font-semibold text-slate-800">{field?.label ?? "Previously approved field"}</span><div className="mt-1 grid gap-1 sm:grid-cols-2"><span className="text-slate-600">Original: <code>{field ? String(field.current_value ?? "null") : "Unavailable"}</code></span><span className="text-violet-800">Proposed: <code>{String(change.value ?? "null")}</code></span></div></li>; })}</ul>
                    </section>}
                    {editingParameters ? <ParameterEditPanel fields={inspection.editable_fields} draft={parameterDraft} saving={draftSaving} saveError={draftSaveError} onCancel={() => { setEditingParameters(false); setDraftSaveError(null); }} onSave={saveDraft} /> : <>
                      <InspectionViewer inspection={inspection} selectedNetCDFVariable={netcdfEditorVariableName} onSelectNetCDFVariable={(name) => { if (selectedUploadId) setNetcdfVariableSelection({ uploadId: selectedUploadId, name }); }} />
                    </>}
                  </div>
                )}
              </>
            )}
          </main>
        </div>
      </div>
    </section>
  );
}
