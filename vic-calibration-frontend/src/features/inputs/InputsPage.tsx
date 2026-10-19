import { Fragment, useRef, useState, type ChangeEvent } from "react";
import { Link } from "react-router-dom";
import type { CalibrationJob, Project } from "../setup/types";
import { configurationSections, exampleConfiguration, exampleDependencies, exampleParsedSettings } from "./mockData";
import type { ValidationFinding } from "./types";

interface InputsPageProps {
  project: Project | null;
  job: CalibrationJob | null;
}

const cardClass = "rounded-xl border border-slate-200 bg-white p-2.5 shadow-sm";
const secondaryButton = "inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500";
const primaryButton = "inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";

export default function InputsPage({ project, job }: InputsPageProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [localFileName, setLocalFileName] = useState<string | null>(null);
  const [showConfiguration, setShowConfiguration] = useState(true);
  const [findings, setFindings] = useState<ValidationFinding[] | null>(null);
  const [expandedDependency, setExpandedDependency] = useState<string | null>(null);

  function handleFileSelection(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setLocalFileName(file.name);
    setFindings(null);
  }

  function validateMockInputs() {
    setFindings([
      {
        severity: "issue",
        message: localFileName
          ? "A local file was selected, but no RAT configuration is linked to this job or available on the server."
          : "No RAT configuration is linked to this job in the current prototype.",
      },
      {
        severity: "warning",
        message: "Example dependencies are not resolved or checked against the RAT environment.",
      },
      {
        severity: "warning",
        message: "Observed discharge data availability is unknown and must be checked before calibration.",
      },
    ]);
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

  const issueCount = findings?.filter((finding) => finding.severity === "issue").length ?? 0;
  const warningCount = findings?.filter((finding) => finding.severity === "warning").length ?? 0;

  return (
    <div className="min-h-[calc(100vh-5rem)] bg-[#f5f8fc] p-3 sm:p-5 xl:h-[calc(100dvh-6rem)] xl:min-h-0 xl:overflow-hidden xl:p-4">
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

          <section className="min-w-0 space-y-3 xl:grid xl:h-full xl:min-h-0 xl:grid-rows-[auto_auto_minmax(0,1fr)] xl:gap-3 xl:space-y-0">
            <header className="px-1 pb-1 xl:row-start-1">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">
                Step 02 / RAT + VIC calibration
                <span className="ml-2 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-sky-800">Prototype data</span>
              </p>
              <h1 className="mt-1 text-xl font-bold tracking-tight text-slate-950">2. Inputs &amp; Configuration</h1>
              <p className="mt-1 max-w-3xl text-sm leading-5 text-slate-600">
                Inspect this job&apos;s RAT configuration, referenced dependencies, and input readiness. No RAT or VIC run is started here.
              </p>
            </header>

            <div className="grid gap-3 xl:row-start-2 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] xl:items-stretch">
            <section className={cardClass + " min-w-0"} aria-labelledby="config-heading">
              <div className="flex flex-col gap-1.5 border-b border-slate-100 pb-1.5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">A. Main RAT configuration</p>
                  <h2 id="config-heading" className="mt-0.5 text-sm font-semibold text-slate-900">rat_config.yaml</h2>
                  <p className="mt-0.5 text-[11px] leading-4 text-slate-600">Expected main configuration filename. No configuration is attached to this mock job.</p>
                </div>
                <span className="w-fit shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">Not loaded</span>
              </div>

              <div className="mt-1.5 grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_230px] sm:items-start">
                <dl className="grid gap-1">
                  <div className="rounded-lg bg-slate-50 px-2 py-1">
                    <dt className="font-medium text-slate-500">Source</dt>
                    <dd className="mt-0.5 text-[10px] leading-3 text-slate-800">{localFileName ? "Selected in this browser only" : "No source selected"}</dd>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-2 py-1">
                    <dt className="font-medium text-slate-500">Server location</dt>
                    <dd className="mt-0.5 text-[10px] leading-3 text-slate-800">Not available in prototype</dd>
                  </div>
                </dl>

                <div className="flex flex-col gap-1">
                  <input ref={fileInput} type="file" accept=".yaml,.yml" className="sr-only" aria-label="Select a local RAT configuration file" onChange={handleFileSelection} />
                  <button type="button" onClick={() => fileInput.current?.click()} className={secondaryButton + " justify-start px-2.5 py-1.5 text-xs"}>Select Configuration</button>
                  <button type="button" onClick={() => setShowConfiguration((shown) => !shown)} className={secondaryButton + " justify-start px-2.5 py-1.5 text-xs"}>
                    {showConfiguration ? "Hide Example Configuration" : "View Example Configuration"}
                  </button>
                  <button type="button" onClick={validateMockInputs} className={secondaryButton + " justify-start px-2.5 py-1.5 text-xs"}>Validate Configuration (mock check)</button>
                </div>
              </div>
              {localFileName && (
                <p role="status" className="mt-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-4 text-sky-900">
                  Selected locally: <strong>{localFileName}</strong>. The file was not uploaded, read, or associated with this job.
                </p>
              )}
            </section>

            <section className={cardClass + " min-w-0"} aria-labelledby="overview-heading">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">B. Configuration overview</p>
                  <h2 id="overview-heading" className="mt-0.5 text-base font-semibold text-slate-900">Illustrative sections</h2>
                </div>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700">No job values checked</span>
              </div>
              <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                {configurationSections.map((section) => (
                  <div key={section.title} className="rounded-lg border border-slate-200 bg-slate-50/60 px-2 py-1.5">
                    <h3 className="text-xs font-semibold text-slate-800">{section.title}</h3>
                    <p className="mt-0.5 text-[11px] leading-4 text-slate-600">{section.description}</p>
                  </div>
                ))}
              </div>
            </section>

            </div>

            <section className={cardClass + " flex min-h-0 flex-col xl:row-start-3"} aria-labelledby="dependencies-heading">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">C. Referenced files and dependencies</p>
                  <h2 id="dependencies-heading" className="mt-0.5 text-base font-semibold text-slate-900">Example dependencies</h2>
                </div>
                <span className="text-[11px] text-slate-500">Statuses are not checked against a RAT environment.</span>
              </div>
              <div className="mt-1.5 min-h-0 flex-1 overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full min-w-[740px] border-collapse text-left text-xs">
                  <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] font-semibold text-slate-700">
                    <tr>
                      <th className="w-[24%] px-2 py-1.5">Dependency / type</th>
                      <th className="w-[14%] px-2 py-1.5">Status</th>
                      <th className="w-[25%] px-2 py-1.5">Source / example reference</th>
                      <th className="w-[12%] px-2 py-1.5">Actions</th>
                      <th className="w-[25%] px-2 py-1.5">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {exampleDependencies.map((dependency, index) => {
                      const isExpanded = expandedDependency === dependency.name;
                      const detailsId = "dependency-details-" + index;
                      return (
                        <Fragment key={dependency.name}>
                          <tr className="bg-white align-top">
                            <td className="px-2 py-1">
                              <span className="block font-semibold text-slate-800">{dependency.category}</span>
                              <span className="mt-0.5 block break-all text-[10px] leading-3 text-slate-600">{dependency.name}</span>
                            </td>
                            <td className="px-2 py-1">
                              <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">{dependency.status}</span>
                            </td>
                            <td className="px-2 py-1 text-[10px] leading-[14px] text-slate-600">{dependency.exampleReference}</td>
                            <td className="px-2 py-1">
                              <button
                                type="button"
                                aria-expanded={isExpanded}
                                aria-controls={detailsId}
                                onClick={() => setExpandedDependency(isExpanded ? null : dependency.name)}
                                className="rounded-md px-2 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
                              >
                                {isExpanded ? "Hide" : "View"}
                              </button>
                            </td>
                            <td className="px-2 py-1 text-[10px] leading-[14px] text-slate-600">{dependency.role}</td>
                          </tr>
                          <tr id={detailsId} hidden={!isExpanded}>
                            <td colSpan={5} className="bg-blue-50/60 px-3 py-2 text-[11px] leading-4 text-slate-700">
                              <strong>{dependency.category}:</strong> {dependency.role} {dependency.exampleReference}
                            </td>
                          </tr>
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </section>

          <aside className="min-w-0 space-y-2 xl:flex xl:h-full xl:min-h-0 xl:flex-col xl:overflow-hidden">
            <div className="min-h-0 space-y-2 overflow-x-hidden xl:flex-1 xl:overflow-y-auto xl:overscroll-contain">
            <section className={cardClass + " shrink-0"} aria-labelledby="preview-heading">
              <div className="flex items-center justify-between gap-2">
                <h2 id="preview-heading" className="text-sm font-semibold text-blue-700">Configuration preview</h2>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">Example only</span>
              </div>
              <p className="mt-1 text-[11px] leading-4 text-slate-500">Not loaded from the selected job or GangaServer.</p>
              {showConfiguration ? (
                <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-2.5 text-[10px] leading-[14px] text-slate-100"><code>{exampleConfiguration}</code></pre>
              ) : (
                <div className="mt-2 grid min-h-24 place-items-center rounded-lg border border-dashed border-slate-300 px-3 text-center text-xs text-slate-500">
                  Example preview hidden. Use View Example Configuration in the main configuration panel.
                </div>
              )}

              <div className="mt-2 border-t border-slate-100 pt-1.5">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-slate-800">Configuration summary</h3>
                  <span className="text-[10px] font-medium text-slate-500">Mock fields</span>
                </div>
                <p className="mt-0.5 text-[10px] leading-4 text-slate-500">Illustrative keys only; no settings have been parsed.</p>
                <dl className="mt-0.5 grid grid-cols-2 gap-x-2 text-[10px] leading-3.5">
                  {exampleParsedSettings.map((setting) => (
                    <div key={setting.label} className="flex min-w-0 justify-between gap-2 border-b border-slate-100 py-0.5">
                      <dt className="truncate text-slate-500">{setting.label}</dt>
                      <dd className="shrink-0 font-medium text-slate-700">{setting.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </section>

            <section className={cardClass + " shrink-0"} aria-labelledby="validation-heading">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">D. Validation summary</p>
                  <h2 id="validation-heading" className="mt-0.5 text-base font-semibold text-slate-900">{findings ? "Issues found" : "Not validated"}</h2>
                </div>
                <span className="rounded-full bg-amber-50 px-2 py-1 text-[10px] font-semibold text-amber-800">Prototype checks</span>
              </div>
              {findings ? (
                <>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg bg-rose-50 p-2 text-rose-900"><span className="block text-[10px]">Issues</span><strong>{issueCount}</strong></div>
                    <div className="rounded-lg bg-amber-50 p-2 text-amber-900"><span className="block text-[10px]">Warnings</span><strong>{warningCount}</strong></div>
                  </div>
                  <ul className="mt-2 space-y-1.5">
                    {findings.map((finding) => (
                      <li key={finding.message} className="flex gap-2 text-xs leading-4 text-slate-700">
                        <span aria-hidden="true" className={finding.severity === "issue" ? "text-rose-600" : "text-amber-600"}>
                          {finding.severity === "issue" ? "!" : "\u2022"}
                        </span>
                        <span>{finding.message}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="mt-2 text-xs leading-4 text-slate-600">No checks have been run. Input readiness and server file availability are unknown.</p>
              )}
              <button type="button" onClick={validateMockInputs} className={secondaryButton + " mt-2 w-full"}>
                Validate Inputs (mock checks)
              </button>
              <p className="mt-1.5 text-[10px] leading-4 text-slate-500">No YAML parsing, file-existence checks, path resolution, or scientific validation occurs.</p>

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