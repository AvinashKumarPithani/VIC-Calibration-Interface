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
