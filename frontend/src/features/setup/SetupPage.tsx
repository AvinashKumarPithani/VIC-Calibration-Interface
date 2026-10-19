import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { CalibrationJob, JobDraft, Project, ProjectDraft } from "./types";

interface SetupPageProps {
  projects: Project[];
  jobs: CalibrationJob[];
  selectedProjectId: string | null;
  selectedJobId: string | null;
  onSelectProject: (projectId: string) => void;
  onCreateProject: (draft: ProjectDraft) => Promise<Project>;
  onUpdateProject: (projectId: string, draft: ProjectDraft) => Promise<void>;
  onCreateJob: (draft: JobDraft) => Promise<CalibrationJob>;
  onDuplicateJob: (jobId: string) => Promise<CalibrationJob>;
  onSelectJob: (jobId: string) => void;
  projectsLoading: boolean;
  projectsError: string | null;
  jobsLoading: boolean;
  jobsError: string | null;
}

type DialogState = "new-project" | "edit-project" | "new-job" | null;

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" }).format(
    new Date(value),
  );
}

function Icon({ children }: { children: ReactNode }) {
  return <span aria-hidden="true" className="inline-grid size-5 shrink-0 place-items-center text-lg leading-none">{children}</span>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-slate-950/45 p-4"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section role="dialog" aria-modal="true" aria-labelledby="dialog-title" className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
        <div className="mb-5 flex items-start justify-between gap-4">
          <h2 id="dialog-title" className="text-xl font-semibold text-slate-900">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close dialog" className="rounded-md px-2 text-xl text-slate-500 hover:bg-slate-100">×</button>
        </div>
        {children}
      </section>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <label className="block text-sm font-medium text-slate-800">
      {label}{required && <span className="ml-1 text-rose-600">*</span>}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

const inputClass = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-100";
const primaryButton = "inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButton = "inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500";

export default function SetupPage({
  projects, jobs, selectedProjectId, selectedJobId, onSelectProject, onCreateProject,
  onUpdateProject, onCreateJob, onDuplicateJob, onSelectJob, projectsLoading, projectsError, jobsLoading, jobsError,
}: SetupPageProps) {
  const navigate = useNavigate();
  const [projectSearch, setProjectSearch] = useState("");
  const [jobSearch, setJobSearch] = useState("");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [resultJob, setResultJob] = useState<CalibrationJob | null>(null);
  const [feedback, setFeedback] = useState("");
  const [actionError, setActionError] = useState("");
  const [saving, setSaving] = useState(false);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const projectJobs = jobs.filter((job) => job.projectId === selectedProjectId);
  const currentJob = jobs.find((job) => job.id === selectedJobId && job.projectId === selectedProjectId) ?? null;
  const visibleProjects = useMemo(
    () => projects.filter((project) => project.name.toLowerCase().includes(projectSearch.trim().toLowerCase())),
    [projects, projectSearch],
  );
  const visibleJobs = useMemo(() => {
    const query = jobSearch.trim().toLowerCase();
    return projectJobs.filter((job) => `${job.name} ${job.id} ${job.status}`.toLowerCase().includes(query));
  }, [jobSearch, projectJobs]);

  async function handleProjectSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const draft = { name: String(formData.get("name")).trim(), description: String(formData.get("description")).trim() };
    if (!draft.name) return;
    setSaving(true);
    setActionError("");
    try {
      if (dialog === "edit-project" && selectedProject) {
        await onUpdateProject(selectedProject.id, draft);
        setFeedback("Project details updated.");
      } else {
        await onCreateProject(draft);
        setFeedback("Project created and selected.");
      }
      setDialog(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Project could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function handleJobSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const draft: JobDraft = {
      name: String(formData.get("name")).trim(),
      description: String(formData.get("description")).trim(),
      copyFromJobId: String(formData.get("copyFromJobId") ?? ""),
    };
    if (!draft.name) return;
    setSaving(true);
    setActionError("");
    try {
      const job = await onCreateJob(draft);
      setDialog(null);
      setFeedback(`${job.name} created. Opening Inputs.`);
      navigate("/inputs");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Job could not be created.");
    } finally {
      setSaving(false);
    }
  }

  function openJob(job: CalibrationJob) {
    onSelectJob(job.id);
    setFeedback(`${job.name} is now the current job.`);
    navigate("/inputs");
  }

  async function duplicateJob(job: CalibrationJob) {
    setActionError("");
    try {
      const duplicate = await onDuplicateJob(job.id);
      setFeedback(`${duplicate.name} created as a new job. No results were copied.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Job could not be duplicated.");
    }
  }

  return (
    <div className="min-h-[calc(100vh-5rem)] bg-[#f5f8fc] p-3 sm:p-5 xl:h-[calc(100dvh-6rem)] xl:min-h-0 xl:overflow-hidden xl:p-4">
      <div className="mx-auto grid max-w-[1680px] gap-3 xl:h-full xl:min-h-0 xl:grid-cols-[250px_minmax(0,1fr)_290px]">
        <aside className="flex min-h-[420px] flex-col rounded-xl border border-slate-200 bg-white p-3 shadow-sm xl:h-full xl:min-h-0">
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-semibold text-slate-900"><Icon>▣</Icon>Projects</h2>
            <button type="button" onClick={() => setDialog("new-project")} className={`${secondaryButton} px-2.5 text-blue-700`}>
              <span aria-hidden="true" className="text-lg leading-none">+</span><span className="hidden sm:inline xl:inline">New Project</span><span className="sm:hidden">New</span>
            </button>
          </div>
          <label className="relative mt-4 block">
            <span className="sr-only">Search projects</span>
            <span aria-hidden="true" className="absolute left-3 top-2.5 text-slate-400">⌕</span>
            <input value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} placeholder="Search projects…" className={`${inputClass} pl-9`} />
          </label>

          <div className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto" aria-label="Projects">
            {visibleProjects.map((project) => {
              const isSelected = project.id === selectedProjectId;
              const count = project.id === selectedProjectId ? projectJobs.length : null;
              return (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => { onSelectProject(project.id); setJobSearch(""); setFeedback(""); }}
                  aria-current={isSelected ? "true" : undefined}
                  className={`w-full rounded-lg border-l-[3px] p-3 text-left transition ${isSelected ? "border-blue-600 bg-blue-50 text-blue-950" : "border-transparent hover:bg-slate-50"}`}
                >
                  <span className="flex items-start gap-2.5"><Icon>{isSelected ? "▤" : "▧"}</Icon><span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{project.name}</span>
                    <span className="mt-1 block text-xs text-slate-500">{count === null ? "Select to load jobs" : `${count} ${count === 1 ? "job" : "jobs"}`} · Updated {formatDate(project.modifiedAt)}</span>
                  </span></span>
                </button>
              );
            })}
            {projectsLoading && <p className="px-3 py-4 text-sm text-slate-500">Loading projects…</p>}
            {projectsError && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{projectsError}</p>}
            {!projectsLoading && !projectsError && visibleProjects.length === 0 && (
              <div className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center">
                <p className="text-sm font-medium text-slate-700">No projects found</p>
                <p className="mt-1 text-xs text-slate-500">Try another search or create a project.</p>
              </div>
            )}
          </div>
          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs leading-5 text-slate-600">
            <p className="font-semibold text-slate-800">Prototype workspace</p>
            <p>Projects and jobs are saved by the local API.</p>
          </div>
        </aside>

        <main className="min-w-0 space-y-2.5 xl:flex xl:h-full xl:min-h-0 xl:flex-col">
          <section className="flex flex-col gap-2 px-1 pb-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Project and job management</p>
              <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">1. Setup</h1>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">Create or select a project, then manage calibration jobs for the RAT + VIC workflow.</p>
            </div>
          </section>

          {actionError && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{actionError}</div>}{feedback && <div role="status" className="flex items-start justify-between gap-3 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900"><span>{feedback}</span><button type="button" onClick={() => setFeedback("")} aria-label="Dismiss message" className="font-semibold">×</button></div>}

          {selectedProject ? (
            <>

              <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                <div className="mb-2 flex items-center justify-between gap-2 border-b border-slate-100 pb-1.5">
                  <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900"><Icon>▱</Icon>A. Project Information</h2>
                  <button type="button" onClick={() => setDialog("edit-project")} className={`${secondaryButton} text-blue-700`}><Icon>✎</Icon><span>Edit Project</span></button>
                </div>
                <div className="grid gap-2">
                  <div className="space-y-1.5">
                    <div><h3 className="text-xs font-semibold text-slate-600">Project Name</h3><p className="mt-0.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-900">{selectedProject.name}</p></div>
                    <div><h3 className="text-xs font-semibold text-slate-600">Description</h3><p className="mt-0.5 min-h-0 whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs leading-4 text-slate-700">{selectedProject.description || <span className="italic text-slate-400">No description provided.</span>}</p></div>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-2 gap-y-2 rounded-lg bg-slate-50 p-2 text-xs">
                    <div><dt className="text-xs font-medium text-slate-500">Created On</dt><dd className="mt-0.5 text-slate-800">{formatDate(selectedProject.createdAt)}</dd></div>
                    <div><dt className="text-xs font-medium text-slate-500">Last Modified</dt><dd className="mt-0.5 text-slate-800">{formatDate(selectedProject.modifiedAt)}</dd></div>
                    <div><dt className="text-xs font-medium text-slate-500">Total Jobs</dt><dd className="mt-1 font-semibold text-slate-900">{projectJobs.length}</dd></div>
                  </dl>
                </div>
              </section>

              <section className="flex min-h-[300px] flex-col rounded-xl border border-slate-200 bg-white p-2.5 shadow-sm xl:min-h-0 xl:flex-1">
                <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900"><Icon>◷</Icon>B. Jobs in This Project</h2>
                  <button type="button" onClick={() => setDialog("new-job")} className={primaryButton}><span aria-hidden="true" className="text-lg leading-none">+</span>Create New Job</button>
                </div>
                <label className="relative mb-3 block">
                  <span className="sr-only">Search jobs</span><span aria-hidden="true" className="absolute left-3 top-2.5 text-slate-400">⌕</span>
                  <input value={jobSearch} onChange={(event) => setJobSearch(event.target.value)} placeholder="Search jobs…" className={`${inputClass} pl-9`} />
                </label>
                <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-slate-200">
                  <table className="w-full min-w-[680px] border-collapse text-left text-[11px]">
                    <thead className="bg-slate-50 text-xs font-semibold text-slate-700"><tr>
                      <th className="px-2 py-1.5">Job ID</th><th className="px-2 py-1.5">Job Name</th><th className="px-2 py-1.5">Created On</th><th className="px-2 py-1.5">Last Modified</th><th className="px-2 py-1.5">Status</th><th className="px-2 py-1.5">Best NSE</th><th className="px-2 py-1.5">Actions</th>
                    </tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {jobsLoading && <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">Loading jobs…</td></tr>}
                      {jobsError && <tr><td colSpan={7} role="alert" className="px-4 py-8 text-center text-rose-700">{jobsError}</td></tr>}
                      {!jobsLoading && !jobsError && visibleJobs.map((job) => (
                        <tr key={job.id} className={job.id === selectedJobId ? "bg-sky-50/60" : "bg-white hover:bg-slate-50/70"}>
                          <td className="whitespace-nowrap px-2 py-1.5 font-medium text-slate-600">{job.id}</td>
                          <td className="whitespace-nowrap px-2 py-1.5"><span className="font-semibold text-slate-900">{job.name}</span>{job.id === selectedJobId && <span className="ml-2 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-800">Current</span>}</td>
                          <td className="whitespace-nowrap px-2 py-1.5 text-slate-600">{formatDate(job.createdAt)}</td>
                          <td className="whitespace-nowrap px-2 py-1.5 text-slate-600">{formatDate(job.modifiedAt)}</td>
                          <td className="whitespace-nowrap px-2 py-1.5"><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${job.status === "Completed" ? "bg-emerald-50 text-emerald-800" : job.status === "Ready" ? "bg-blue-50 text-blue-800" : "bg-slate-100 text-slate-700"}`}>{job.status}</span></td>
                          <td className="whitespace-nowrap px-2 py-1.5 text-slate-700">{job.result?.bestNse !== undefined ? <span title="Illustrative mock result">{job.result.bestNse.toFixed(2)} <span className="text-[10px] text-slate-400">mock</span></span> : <span className="text-slate-400">—</span>}</td>
                          <td className="whitespace-nowrap px-2 py-1"><div className="flex items-center gap-1">
                            <button type="button" onClick={() => openJob(job)} className="rounded-md px-1.5 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-50" title="Open job">Open</button>
                            <button type="button" onClick={() => setResultJob(job)} className="rounded-md px-1.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100" title="View available mock results">Results</button>
                            <button type="button" onClick={() => duplicateJob(job)} className="rounded-md px-1.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100" title="Duplicate job">Copy</button>
                          </div></td>
                        </tr>
                      ))}
                      {!jobsLoading && !jobsError && visibleJobs.length === 0 && <tr><td colSpan={7} className="px-4 py-10 text-center"><p className="font-medium text-slate-700">{projectJobs.length === 0 ? "No jobs in this project yet" : "No jobs match your search"}</p><p className="mt-1 text-sm text-slate-500">{projectJobs.length === 0 ? "Create a calibration job to get started." : "Try a different job name, ID, or status."}</p></td></tr>}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          ) : (
            <section className="grid min-h-80 place-items-center rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
              <div><p className="text-lg font-semibold text-slate-900">{projects.length === 0 ? "Create your first project" : "No project selected"}</p><p className="mt-2 max-w-md text-sm leading-6 text-slate-600">{projects.length === 0 ? "Projects organize your calibration jobs and their experiment history." : "Choose a project from the list or create a new one to manage its jobs."}</p><button type="button" onClick={() => setDialog("new-project")} className={`${primaryButton} mt-5`}>+ New Project</button></div>
            </section>
          )}
        </main>

        <aside className="flex flex-col gap-2 xl:h-full xl:min-h-0">
          <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-blue-700"><Icon>☷</Icon>Selected Workflow</h2>
            <div className="mt-2 rounded-lg border border-blue-300 bg-blue-50/70 p-3">
              <p className="flex items-center gap-2 text-sm font-semibold text-blue-900"><span aria-hidden="true" className="text-base">◉</span>RAT + VIC Calibration</p>
              <p className="mt-1 pl-6 text-xs leading-4 text-blue-900">Calibrate VIC through the existing Reservoir Assessment Tool (RAT) workflow.</p>
              <span className="mt-2 inline-flex rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-800">Only supported prototype workflow</span>
            </div>
          </section>
          <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-blue-700"><Icon>ⓘ</Icon>About Projects and Jobs</h2>
            <div className="mt-2 space-y-2 rounded-lg bg-blue-50/70 p-2.5 text-xs leading-4 text-slate-700">
              <div><h3 className="text-xs font-semibold text-slate-900">Project</h3><ul className="mt-0.5 list-disc space-y-0.5 pl-4"><li>A workspace for a basin or study.</li><li>Can contain multiple calibration jobs.</li></ul></div>
              <div><h3 className="text-xs font-semibold text-slate-900">Job</h3><ul className="mt-0.5 list-disc space-y-0.5 pl-4"><li>A specific calibration experiment with its own settings.</li><li>Can have multiple runs and results when available.</li><li>Copying a job starts a separate history.</li></ul></div>
            </div>
            <h3 className="mt-3 text-sm font-semibold text-slate-900">Next steps</h3>
            <ol className="mt-2 space-y-1 text-xs leading-4 text-slate-700">
              <li className="flex items-center gap-2"><span className="grid size-5 place-items-center rounded-full bg-blue-600 text-xs font-bold text-white">1</span>Select or create a project.</li>
              <li className="flex items-center gap-2"><span className="grid size-5 place-items-center rounded-full border border-slate-300 text-xs">2</span>Create a calibration job.</li>
              <li className="flex items-center gap-2"><span className="grid size-5 place-items-center rounded-full border border-slate-300 text-xs">3</span>Continue to Inputs.</li>
            </ol>
          </section>
          <section className="mt-auto rounded-xl border border-blue-200 bg-white p-3 shadow-sm">
            <button type="button" onClick={() => navigate("/inputs")} disabled={!currentJob} className={primaryButton + " w-full disabled:cursor-not-allowed disabled:opacity-50"}>
              Continue to Inputs &amp; Config. <span aria-hidden="true">&rarr;</span>
            </button>
          </section>
        </aside>
      </div>

      {dialog === "new-project" && <Modal title="Create a Project" onClose={() => setDialog(null)}>
        <form onSubmit={handleProjectSubmit} className="space-y-4">
          {actionError && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{actionError}</p>}
          <Field label="Project Name" required><input name="name" autoFocus required maxLength={100} placeholder="e.g., Krishna_Basin_Calibration" className={inputClass} /></Field>
          <Field label="Description (optional)"><textarea name="description" rows={3} maxLength={500} placeholder="What is this project for?" className={`${inputClass} resize-y`} /></Field>
          <div className="flex justify-end gap-2 border-t border-slate-100 pt-4"><button type="button" onClick={() => setDialog(null)} className={secondaryButton}>Cancel</button><button type="submit" disabled={saving} className={primaryButton}>{saving ? "Saving…" : "Create Project"}</button></div>
        </form>
      </Modal>}

      {dialog === "edit-project" && selectedProject && <Modal title="Edit Project" onClose={() => setDialog(null)}>
        <form key={selectedProject.id} onSubmit={handleProjectSubmit} className="space-y-4">
          {actionError && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{actionError}</p>}
          <Field label="Project Name" required><input name="name" autoFocus required maxLength={100} defaultValue={selectedProject.name} className={inputClass} /></Field>
          <Field label="Description (optional)"><textarea name="description" rows={3} maxLength={500} defaultValue={selectedProject.description} className={`${inputClass} resize-y`} /></Field>
          <div className="flex justify-end gap-2 border-t border-slate-100 pt-4"><button type="button" onClick={() => setDialog(null)} className={secondaryButton}>Cancel</button><button type="submit" disabled={saving} className={primaryButton}>{saving ? "Saving…" : "Save Changes"}</button></div>
        </form>
      </Modal>}

      {dialog === "new-job" && <Modal title="Create a New Calibration Job" onClose={() => setDialog(null)}>
        <form onSubmit={handleJobSubmit} className="space-y-4">
          {actionError && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{actionError}</p>}
          <p className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">Project: <strong>{selectedProject?.name}</strong></p>
          <Field label="Job Name" required><input name="name" autoFocus required maxLength={100} placeholder="e.g., Baseline_Calibration" className={inputClass} /></Field>
          <Field label="Description (optional)"><textarea name="description" rows={3} maxLength={500} placeholder="Add a note about this experiment" className={`${inputClass} resize-y`} /></Field>
          <Field label="Copy from Existing Job (optional)"><select name="copyFromJobId" defaultValue="" className={inputClass}><option value="">None (start from scratch)</option>{projectJobs.map((job) => <option key={job.id} value={job.id}>{job.name} ({job.id})</option>)}</select></Field>
          <Field label="Workflow"><input readOnly value="RAT (Reservoir Assessment Tool) + VIC Calibration" className={`${inputClass} bg-slate-50 text-slate-600`} /></Field>
          <p className="text-xs leading-5 text-slate-500">The new job gets its own ID and no copied results. Calibration settings are not stored by this backend yet.</p>
          <div className="flex justify-end gap-2 border-t border-slate-100 pt-4"><button type="button" onClick={() => setDialog(null)} className={secondaryButton}>Cancel</button><button type="submit" disabled={saving} className={primaryButton}>{saving ? "Creating…" : "Create Job"} <span aria-hidden="true">→</span></button></div>
        </form>
      </Modal>}

      {resultJob && <Modal title={`Results: ${resultJob.name}`} onClose={() => setResultJob(null)}>
        {resultJob.result ? <div className="space-y-4"><p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">Illustrative mock result — this is sample interface data, not a scientific model result.</p><dl className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-4 text-sm"><div><dt className="text-slate-500">Job ID</dt><dd className="mt-1 font-medium text-slate-900">{resultJob.id}</dd></div><div><dt className="text-slate-500">Status</dt><dd className="mt-1 font-medium text-slate-900">{resultJob.status}</dd></div><div><dt className="text-slate-500">Best NSE (mock)</dt><dd className="mt-1 font-semibold text-slate-900">{resultJob.result.bestNse?.toFixed(2) ?? "Unavailable"}</dd></div></dl></div> : <div className="rounded-lg border border-dashed border-slate-300 px-5 py-8 text-center"><p className="font-medium text-slate-800">No results available</p><p className="mt-1 text-sm text-slate-500">This job has no result data in the current prototype.</p></div>}
        <div className="mt-5 flex justify-end"><button type="button" onClick={() => setResultJob(null)} className={secondaryButton}>Close</button></div>
      </Modal>}
    </div>
  );
}
