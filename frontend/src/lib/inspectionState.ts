const selectionStoragePrefix = "vic-calibration:tab3-selection:";
const legacyInputSelectionKey = "vic-calibration:inputs-inspected-upload";

function selectionStorageKey(projectId: string, jobId: string): string {
  return `${selectionStoragePrefix}${encodeURIComponent(projectId)}:${encodeURIComponent(jobId)}`;
}

export function readSavedInspectionUploadId(projectId: string, jobId: string): string | null {
  const key = selectionStorageKey(projectId, jobId);
  try {
    const stored = sessionStorage.getItem(key);
    if (!stored) return null;
    const value: unknown = JSON.parse(stored);
    if (typeof value === "object" && value !== null
      && "projectId" in value && value.projectId === projectId
      && "jobId" in value && value.jobId === jobId
      && "uploadId" in value && typeof value.uploadId === "string" && value.uploadId.length > 0) {
      return value.uploadId;
    }
    sessionStorage.removeItem(key);
  } catch {
    // Storage may be disabled or inaccessible; selection restoration is optional.
  }
  return null;
}

export function saveInspectionUploadId(projectId: string, jobId: string, uploadId: string): void {
  try {
    sessionStorage.setItem(selectionStorageKey(projectId, jobId), JSON.stringify({ projectId, jobId, uploadId }));
  } catch {
    // Keep inspection usable even if browser storage is unavailable.
  }
}

export function clearSavedInspectionUploadId(projectId: string, jobId: string, uploadId?: string): void {
  const key = selectionStorageKey(projectId, jobId);
  try {
    const savedUploadId = readSavedInspectionUploadId(projectId, jobId);
    if (!uploadId || savedUploadId === uploadId) sessionStorage.removeItem(key);
  } catch {
    // Ignore inaccessible storage.
  }
}

export function clearSavedInspectionState(projectId: string, jobId?: string): void {
  const projectPrefix = `${selectionStoragePrefix}${encodeURIComponent(projectId)}:`;
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = sessionStorage.key(index);
      if (!key || (jobId ? key !== selectionStorageKey(projectId, jobId) : !key.startsWith(projectPrefix))) continue;
      sessionStorage.removeItem(key);
    }
    const legacy = sessionStorage.getItem(legacyInputSelectionKey);
    if (!legacy) return;
    const value: unknown = JSON.parse(legacy);
    if (typeof value === "object" && value !== null
      && "projectId" in value && value.projectId === projectId
      && (jobId === undefined || ("jobId" in value && value.jobId === jobId))) {
      sessionStorage.removeItem(legacyInputSelectionKey);
    }
  } catch {
    // Storage may be disabled or inaccessible.
  }
}
