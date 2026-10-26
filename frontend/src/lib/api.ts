export interface ApiProject {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  modified_at: string;
}

export interface ApiJob {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  created_at: string;
  modified_at: string;
}

export interface UploadMetadata {
  id: string;
  project_id: string;
  job_id: string;
  original_filename: string;
  upload_category: UploadCategory;
  file_size: number;
  uploaded_at: string;
  source_upload_id: string | null;
}

export interface NetCDFValues {
  variable: string; dimensions: string[]; shape: number[]; selectors: Array<number | null>;
  indices: number[][]; values: unknown[]; source_sha256: string; has_more: boolean;
  varying_dimensions: string[]; window_starts: number[]; window_shape: number[];
}
export interface NetCDFCellEdit { variable: string; indices: number[]; value: unknown }

export type UploadCategory = "configuration_input" | "netcdf_parameter_dataset" | "legacy_unclassified";
export type NewUploadCategory = Exclude<UploadCategory, "legacy_unclassified">;

export interface RecordPayload {
  name: string;
  description: string;
}

export interface InspectionParseError {
  code: string;
  message: string;
  line: number | null;
  column: number | null;
}

export interface InspectedYamlNode {
  kind: "mapping" | "sequence" | "scalar" | "null" | "redacted";
  scalar_type: string | null;
  value: unknown;
  entries: Array<{ key: unknown; value: InspectedYamlNode }>;
  items: InspectedYamlNode[];
}

export type UploadInspectionRepresentation =
  | { kind: "yaml_tree"; root: InspectedYamlNode }
  | { kind: "vic_parameter_lines"; lines: Array<{ line_number: number; kind: "blank" | "comment" | "entry"; raw: string; option: string | null; values: string[]; value_text: string | null }> }
  | { kind: "routing_positional_records"; records: Array<{ heading: string | null; heading_raw: string | null; heading_line_number: number | null; lines: Array<{ line_number: number; raw: string }> }> }
  | { kind: "unit_hydrograph_rows"; rows: Array<{ line_number: number; index_token: string; value_token: string; index: number; value: number }> }
  | {
      kind: "netcdf_dataset";
      dimensions: Array<{ name: string; size: number }>;
      variables: Array<{
        name: string;
        dimensions: string[];
        shape: number[];
        data_type: string;
        classification: "numeric" | "categorical" | "other";
        units: string | null;
        attributes: Record<string, unknown>;
        numeric_summary: {
          finite_count: number;
          missing_count: number;
          minimum: number | null;
          maximum: number | null;
          median: number | null;
        } | null;
        summary_status: "complete" | "limit_reached" | "not_numeric";
        is_coordinate: boolean;
      }>;
      variable_count: number;
      summary_limits: string;
      attributes: Record<string, unknown>;
    };

export type EditableParameterFormat = "rat_yaml" | "metsim_yaml" | "vic_global_text" | "routing_parameter_text" | "unit_hydrograph_text";

export interface EditableParameterField {
  field_id: string;
  label: string;
  data_type: "string" | "integer" | "number" | "boolean";
  current_value: unknown;
  required: boolean;
  minimum: number | null;
  maximum: number | null;
  allowed_values: unknown[];
}

export interface ParameterDraftChange {
  field_id: string;
  value: unknown;
}

export interface ParameterDraft {
  id: string;
  project_id: string;
  job_id: string;
  source_upload_id: string;
  source_format: EditableParameterFormat;
  revision: number;
  changes: ParameterDraftChange[];
  created_at: string;
  updated_at: string;
}

export interface ParameterDraftSave {
  expected_revision: number | null;
  source_format: EditableParameterFormat;
  changes: ParameterDraftChange[];
}

export interface UploadInspection {
  upload: UploadMetadata;
  detected_format: "rat_yaml" | "metsim_yaml" | "vic_global_text" | "routing_parameter_text" | "unit_hydrograph_text" | "vic_netcdf" | "unknown";
  parse_status: "parsed" | "malformed" | "unsupported";
  parse_errors: InspectionParseError[];
  rat_compatibility: "not_checked";
  dependency_availability: "not_checked";
  scientific_validity: "not_checked";
  representation: UploadInspectionRepresentation | null;
  editable_fields: EditableParameterField[];
}

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";
const baseUrl = configuredBaseUrl.replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new Error(`Could not reach the API at ${baseUrl}. Check that the backend is running.`);
  }

  if (!response.ok) {
    let message = `The API request failed (${response.status}).`;
    try {
      const body = await response.json() as { detail?: unknown };
      if (typeof body.detail === "string") {
        message = body.detail;
      } else if (Array.isArray(body.detail)) {
        const firstMessage = body.detail.find(
          (item): item is { msg: string } => typeof item === "object" && item !== null && "msg" in item && typeof item.msg === "string",
        )?.msg;
        if (firstMessage) message = firstMessage;
      }
    } catch {
      // Keep the status-based message when the response has no JSON body.
    }
    throw new Error(message);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  listProjects: () => request<ApiProject[]>("/api/projects"),
  createProject: (payload: RecordPayload) => request<ApiProject>("/api/projects", {
    method: "POST",
    body: JSON.stringify(payload),
  }),
  updateProject: (projectId: string, payload: RecordPayload) => request<ApiProject>(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  }),
  deleteProject: (projectId: string) => request<void>(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  }),
  listJobs: (projectId: string) => request<ApiJob[]>(`/api/projects/${encodeURIComponent(projectId)}/jobs`),
  createJob: (projectId: string, payload: RecordPayload) => request<ApiJob>(`/api/projects/${encodeURIComponent(projectId)}/jobs`, {
    method: "POST",
    body: JSON.stringify(payload),
  }),
  deleteJob: (projectId: string, jobId: string) => request<void>(
    `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}`,
    { method: "DELETE" },
  ),
  listUploads: (projectId: string, jobId: string, category: UploadCategory) => request<UploadMetadata[]>(
    `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/uploads?category=${encodeURIComponent(category)}`,
  ),
  inspectUpload: (projectId: string, jobId: string, uploadId: string, category: UploadCategory) => request<UploadInspection>(
    `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/uploads/${encodeURIComponent(uploadId)}/inspection?category=${encodeURIComponent(category)}`,
  ),
  deleteUpload: (projectId: string, jobId: string, uploadId: string, category: UploadCategory) => request<void>(
    `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/uploads/${encodeURIComponent(uploadId)}?category=${encodeURIComponent(category)}`,
    { method: "DELETE" },
  ),
  getParameterDraft: (projectId: string, jobId: string, uploadId: string) => request<ParameterDraft | null>(
    `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/uploads/${encodeURIComponent(uploadId)}/draft`,
  ),
  saveParameterDraft: (projectId: string, jobId: string, uploadId: string, payload: ParameterDraftSave) => request<ParameterDraft>(
    `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/uploads/${encodeURIComponent(uploadId)}/draft`,
    { method: "PUT", body: JSON.stringify(payload) },
  ),
  discardParameterDraft: (projectId: string, jobId: string, uploadId: string) => request<void>(
    `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/uploads/${encodeURIComponent(uploadId)}/draft`,
    { method: "DELETE" },
  ),
  uploadFile: (projectId: string, jobId: string, file: File, category: NewUploadCategory = "configuration_input") => {
    const formData = new FormData();
    formData.append("file", file);
    return request<UploadMetadata>(
      `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/${category === "netcdf_parameter_dataset" ? "netcdf-uploads" : "uploads"}`,
      { method: "POST", body: formData },
    );
  },
  netcdfValues: (projectId: string, jobId: string, uploadId: string, variable: string, selectors: Array<number | null>, start = 0, windowStarts: number[] = [], windowLimits: number[] = []) => request<NetCDFValues>(
    `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/uploads/${encodeURIComponent(uploadId)}/netcdf-values`,
    { method: "POST", body: JSON.stringify({ variable, selectors, start, limit: 1000, window_starts: windowStarts, window_limits: windowLimits }) },
  ),
  saveNetcdfEdits: (projectId: string, jobId: string, uploadId: string, source_sha256: string, edits: NetCDFCellEdit[]) => request<UploadMetadata>(
    `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/uploads/${encodeURIComponent(uploadId)}/netcdf-edits`,
    { method: "POST", body: JSON.stringify({ source_sha256, edits }) },
  ),
  downloadNetcdf: async (projectId: string, jobId: string, uploadId: string) => {
    const response = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/uploads/${encodeURIComponent(uploadId)}/download`);
    if (!response.ok) throw new Error("The verified NetCDF output could not be downloaded.");
    return response.blob();
  },
};
