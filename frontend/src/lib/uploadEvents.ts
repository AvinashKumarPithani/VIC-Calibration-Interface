import type { UploadInspection } from "./api";

export const UPLOAD_DELETED_EVENT = "vic-calibration:upload-deleted";
export const UPLOAD_INSPECTED_EVENT = "vic-calibration:upload-inspected";
export const UPLOAD_INSPECTION_FAILED_EVENT = "vic-calibration:upload-inspection-failed";

export interface DeletedUploadContext {
  projectId: string;
  jobId: string;
  uploadId: string;
}

export interface FailedInspectionContext {
  projectId: string;
  jobId: string;
  uploadId: string;
  message: string;
}

export function notifyUploadDeleted(detail: DeletedUploadContext): void {
  window.dispatchEvent(new CustomEvent<DeletedUploadContext>(UPLOAD_DELETED_EVENT, { detail }));
}

export function notifyUploadInspected(inspection: UploadInspection): void {
  window.dispatchEvent(new CustomEvent<UploadInspection>(UPLOAD_INSPECTED_EVENT, { detail: inspection }));
}

export function notifyUploadInspectionFailed(detail: FailedInspectionContext): void {
  window.dispatchEvent(new CustomEvent<FailedInspectionContext>(UPLOAD_INSPECTION_FAILED_EVENT, { detail }));
}
