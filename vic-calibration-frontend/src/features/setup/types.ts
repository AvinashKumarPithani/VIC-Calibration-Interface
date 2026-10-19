export type Workflow = "RAT + VIC Calibration";
export type JobStatus = "Completed" | "Ready" | "Not started";

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  modifiedAt: string;
}

export interface CalibrationJob {
  id: string;
  projectId: string;
  name: string;
  description: string;
  createdAt: string;
  modifiedAt: string;
  status: JobStatus;
  workflow: Workflow;
  settings: { workflow: Workflow };
  result?: { bestNse?: number; label: "Illustrative mock result" };
  copiedFromJobId?: string;
}

export interface ProjectDraft {
  name: string;
  description: string;
}

export interface JobDraft extends ProjectDraft {
  copyFromJobId: string;
}
