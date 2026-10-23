import { useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import SetupPage from "./features/setup/SetupPage";
import InputsPage from "./features/inputs/InputsPage";
import CalibrationPage from "./features/calibration/CalibrationPage";
import { api, type ApiJob, type ApiProject } from "./lib/api";
import { clearSavedInspectionState } from "./lib/inspectionState";
import type { CalibrationJob, JobDraft, Project, ProjectDraft } from "./features/setup/types";

const tabs = [
  { label: "Setup", path: "/setup", number: "01" },
  { label: "Inputs", path: "/inputs", number: "02" },
  { label: "Parameters & Calibration", path: "/parameters", number: "03" },
  { label: "Run & Results", path: "/results", number: "04" },
];

function PlaceholderPage({ title, step }: { title: string; step: string }) {
  return (
    <section className="mx-auto max-w-5xl px-6 py-12 sm:px-10 sm:py-16">
      <p className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-primary">
        Step {step} <span className="px-2 text-slate-300">/</span> RAT + VIC calibration
      </p>
      <h1 className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">{title}</h1>
      <div className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <h2 className="text-lg font-semibold text-slate-800">Scaffold placeholder</h2>
        <p className="mt-2 max-w-2xl leading-7 text-slate-600">
          This page is part of the VIC Calibration Interface navigation. Its workflow and detailed
          interface will be added in a later implementation step.
        </p>
      </div>
    </section>
  );
}

function mapProject(record: ApiProject): Project {
  return { id: record.id, name: record.name, description: record.description ?? "", createdAt: record.created_at, modifiedAt: record.modified_at };
}

function mapJob(record: ApiJob): CalibrationJob {
  return { id: record.id, projectId: record.project_id, name: record.name, description: record.description ?? "", createdAt: record.created_at, modifiedAt: record.modified_at, status: "Not started", workflow: "RAT + VIC Calibration", settings: { workflow: "RAT + VIC Calibration" } };
}

const activeSelectionStorageKey = "vic-calibration:active-project-job";

interface SavedProjectJobSelection {
  projectId: string;
  jobId: string;
}

function readProjectJobSelection(): SavedProjectJobSelection | null {
  try {
    const stored = sessionStorage.getItem(activeSelectionStorageKey);
    if (!stored) return null;
    const value: unknown = JSON.parse(stored);
    if (typeof value === "object" && value !== null
      && "projectId" in value && typeof value.projectId === "string"
      && "jobId" in value && typeof value.jobId === "string") {
      return { projectId: value.projectId, jobId: value.jobId };
    }
    sessionStorage.removeItem(activeSelectionStorageKey);
  } catch {
    // Browser storage may be disabled or unavailable.
  }
  return null;
}

function saveProjectJobSelection(selection: SavedProjectJobSelection): void {
  try {
    sessionStorage.setItem(activeSelectionStorageKey, JSON.stringify(selection));
  } catch {
    // Keep project/job selection usable even if browser storage is unavailable.
  }
}

function clearProjectJobSelection(projectId?: string, jobId?: string): void {
  const saved = readProjectJobSelection();
  if (!saved || (projectId && saved.projectId !== projectId) || (jobId && saved.jobId !== jobId)) return;
  try {
    sessionStorage.removeItem(activeSelectionStorageKey);
  } catch {
    // Ignore inaccessible storage.
  }
}

export default function App() {
  const location = useLocation();
  const parametersActive = location.pathname === "/parameters";
  const inputsActive = location.pathname === "/inputs";
  const [projects, setProjects] = useState<Project[]>([]);
  const [jobs, setJobs] = useState<CalibrationJob[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedJob = jobs.find((job) => job.id === selectedJobId && job.projectId === selectedProjectId) ?? null;

  useEffect(() => {
    let active = true;
    api.listProjects().then((rows) => {
      if (!active) return;
      const loaded = rows.map(mapProject);
      setProjects(loaded);
      const saved = readProjectJobSelection();
      const selected = loaded.find((project) => project.id === saved?.projectId) ?? loaded[0] ?? null;
      setSelectedProjectId(selected?.id ?? null);
      if (!selected) clearProjectJobSelection();
    }).catch((error: unknown) => {
      if (active) setProjectsError(error instanceof Error ? error.message : "Projects could not be loaded.");
    }).finally(() => { if (active) setProjectsLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selectedProjectId) { setJobs([]); setSelectedJobId(null); setJobsLoading(false); setJobsError(null); return; }
    let active = true;
    setJobsLoading(true); setJobsError(null); setJobs([]); setSelectedJobId(null);
    api.listJobs(selectedProjectId).then((rows) => {
      if (!active) return;
      const loaded = rows.map(mapJob);
      const saved = readProjectJobSelection();
      const selected = (saved?.projectId === selectedProjectId ? loaded.find((job) => job.id === saved.jobId && job.projectId === selectedProjectId) : undefined)
        ?? loaded[0]
        ?? null;
      setJobs(loaded); setSelectedJobId(selected?.id ?? null);
      if (!selected) clearProjectJobSelection(selectedProjectId);
    }).catch((error: unknown) => {
      if (active) setJobsError(error instanceof Error ? error.message : "Jobs could not be loaded.");
    }).finally(() => { if (active) setJobsLoading(false); });
    return () => { active = false; };
  }, [selectedProjectId]);

  useEffect(() => {
    if (selectedProject && selectedJob && selectedJob.projectId === selectedProject.id) {
      saveProjectJobSelection({ projectId: selectedProject.id, jobId: selectedJob.id });
    }
  }, [selectedProjectId, selectedJobId]);

  async function createProject(draft: ProjectDraft) {
    const project = mapProject(await api.createProject(draft));
    setProjects((current) => [project, ...current]); setSelectedProjectId(project.id); setSelectedJobId(null);
    return project;
  }

  async function updateProject(projectId: string, draft: ProjectDraft) {
    const project = mapProject(await api.updateProject(projectId, draft));
    setProjects((current) => current.map((item) => item.id === projectId ? project : item));
  }

  async function createJob(draft: JobDraft) {
    if (!selectedProjectId) throw new Error("Select a project before creating a job.");
    const source = jobs.find((job) => job.id === draft.copyFromJobId && job.projectId === selectedProjectId);
    const job = mapJob(await api.createJob(selectedProjectId, { name: draft.name, description: draft.description || source?.description || "" }));
    setJobs((current) => [job, ...current]); setSelectedJobId(job.id);
    return job;
  }

  async function duplicateJob(jobId: string) {
    const source = jobs.find((job) => job.id === jobId && job.projectId === selectedProjectId);
    if (!source) throw new Error("The job to duplicate could not be found.");
    const copy = mapJob(await api.createJob(source.projectId, { name: `${source.name} copy`, description: source.description }));
    setJobs((current) => [copy, ...current]); setSelectedJobId(copy.id);
    return copy;
  }

  async function deleteJob(projectId: string, jobId: string) {
    await api.deleteJob(projectId, jobId);
    clearProjectJobSelection(projectId, jobId);
    clearSavedInspectionState(projectId, jobId);
    if (selectedProjectId !== projectId) return;
    const remainingJobs = jobs.filter((job) => job.id !== jobId && job.projectId === projectId);
    setJobs(remainingJobs);
    if (selectedJobId === jobId) setSelectedJobId(remainingJobs[0]?.id ?? null);
  }

  async function deleteProject(projectId: string) {
    await api.deleteProject(projectId);
    clearProjectJobSelection(projectId);
    clearSavedInspectionState(projectId);
    const remainingProjects = projects.filter((project) => project.id !== projectId);
    setProjects(remainingProjects);
    if (selectedProjectId === projectId) {
      setJobs([]);
      setSelectedJobId(null);
      setSelectedProjectId(remainingProjects[0]?.id ?? null);
      if (remainingProjects.length === 0) clearProjectJobSelection();
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-700/70 bg-slate-950 text-white">
        <div className="mx-auto flex max-w-screen-2xl flex-col gap-5 px-5 py-5 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <NavLink to="/setup" className="flex items-center gap-3 self-start rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-300">
            <span aria-hidden="true" className="grid size-11 place-items-center rounded-xl bg-sky-400/15 text-2xl text-sky-300">≈</span>
            <span>
              <span className="block text-lg font-semibold tracking-tight">VIC Calibration Interface</span>
              <span className="mt-0.5 block text-xs text-slate-300">GIS-based calibration · RAT workflow</span>
            </span>
          </NavLink>

          <nav aria-label="Primary navigation" className="flex gap-2 overflow-x-auto pb-1 lg:pb-0">
            {tabs.map((tab) => (
              <NavLink
                key={tab.path}
                to={tab.path}
                className={({ isActive }) =>
                  `flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300 ${
                    isActive
                      ? "bg-sky-400 font-semibold text-slate-950"
                      : "text-slate-200 hover:bg-white/10 hover:text-white"
                  }`
                }
              >
                <span className="text-xs opacity-75">{tab.number}</span>
                {tab.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main>
        <div hidden={parametersActive}>
        <Routes>
          <Route path="/" element={<Navigate to="/setup" replace />} />
          <Route path="/setup" element={
            <SetupPage
              projects={projects}
              jobs={jobs}
              selectedProjectId={selectedProjectId}
              selectedJobId={selectedJobId}
              onSelectProject={setSelectedProjectId}
              onCreateProject={createProject}
              onUpdateProject={updateProject}
              onCreateJob={createJob}
              onDuplicateJob={duplicateJob}
              onDeleteJob={deleteJob}
              onDeleteProject={deleteProject}
              onSelectJob={setSelectedJobId}
              projectsLoading={projectsLoading}
              projectsError={projectsError}
              jobsLoading={jobsLoading}
              jobsError={jobsError}
            />
          } />
          <Route path="/inputs" element={null} />
          <Route path="/parameters" element={null} />
          <Route path="/results" element={<PlaceholderPage title="Run & Results" step="04" />} />
          <Route path="*" element={<Navigate to="/setup" replace />} />
        </Routes>
        </div>
        <div hidden={!parametersActive}>
          <CalibrationPage project={selectedProject} job={selectedJob} isActive={parametersActive} />
        </div>
        <div hidden={!inputsActive}>
          <InputsPage project={selectedProject} job={selectedJob} />
        </div>
      </main>
    </div>
  );
}
