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
  file_size: number;
  uploaded_at: string;
}

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
  | { kind: "unit_hydrograph_rows"; rows: Array<{ line_number: number; index_token: string; value_token: string; index: number; value: number }> };

export interface UploadInspection {
  upload: UploadMetadata;
  detected_format: "rat_yaml" | "metsim_yaml" | "vic_global_text" | "routing_parameter_text" | "unit_hydrograph_text" | "unknown";
  parse_status: "parsed" | "malformed" | "unsupported";
  parse_errors: InspectionParseError[];
  rat_compatibility: "not_checked";
  dependency_availability: "not_checked";
  scientific_validity: "not_checked";
  representation: UploadInspectionRepresentation | null;
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
  listJobs: (projectId: string) => request<ApiJob[]>(`/api/projects/${encodeURIComponent(projectId)}/jobs`),
  createJob: (projectId: string, payload: RecordPayload) => request<ApiJob>(`/api/projects/${encodeURIComponent(projectId)}/jobs`, {
    method: "POST",
    body: JSON.stringify(payload),
  }),
  listUploads: (projectId: string, jobId: string) => request<UploadMetadata[]>(
    `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/uploads`,
  ),
  inspectUpload: (projectId: string, jobId: string, uploadId: string) => request<UploadInspection>(
    `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/uploads/${encodeURIComponent(uploadId)}/inspection`,
  ),
  deleteUpload: (projectId: string, jobId: string, uploadId: string) => request<void>(
    `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/uploads/${encodeURIComponent(uploadId)}`,
    { method: "DELETE" },
  ),
  uploadFile: (projectId: string, jobId: string, file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return request<UploadMetadata>(
      `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/uploads`,
      { method: "POST", body: formData },
    );
  },
};
