import type { ConfigurationSection, ConfigurationSummaryItem, InputDependency } from "./types";

// Contextual examples only. These are not confirmed references for any selected job.
export const exampleDependencies: InputDependency[] = [
  {
    name: "params/metsim/params.yaml",
    category: "MetSim configuration",
    role: "Example meteorological-model configuration dependency.",
    exampleReference: "Example from project context; not resolved for this job.",
    status: "Not checked",
  },
  {
    name: "params/vic/vic_params.txt",
    category: "VIC configuration",
    role: "Example VIC parameter-file dependency.",
    exampleReference: "Example from project context; not resolved for this job.",
    status: "Not checked",
  },
  {
    name: "params/routing/route_param.txt",
    category: "Routing configuration",
    role: "Example routing parameter-file dependency.",
    exampleReference: "Example from project context; not resolved for this job.",
    status: "Not checked",
  },
  {
    name: "params/routing/uh.txt",
    category: "Routing configuration",
    role: "Example unit-hydrograph dependency.",
    exampleReference: "Example from project context; not resolved for this job.",
    status: "Not checked",
  },
];

export const configurationSections: ConfigurationSection[] = [
  { title: "Basin and study area", description: "No job-specific values available in this prototype." },
  { title: "Meteorological forcing", description: "No job-specific values available in this prototype." },
  { title: "VIC model settings", description: "No job-specific values available in this prototype." },
  { title: "Routing settings", description: "No job-specific values available in this prototype." },
  { title: "Calibration data", description: "Observed discharge availability has not been checked." },
  { title: "Outputs and processing", description: "Workflow-generated files have not been discovered." },
];

export const exampleParsedSettings: ConfigurationSummaryItem[] = [
  { label: "Model type", value: "Not checked" },
  { label: "Basin ID", value: "Not checked" },
  { label: "Start date", value: "Not checked" },
  { label: "End date", value: "Not checked" },
  { label: "Spin-up", value: "Not checked" },
  { label: "Time step", value: "Not checked" },
];

// A safe placeholder preview. No real YAML, credentials, or server paths are included.
export const exampleConfiguration = [
  "# Illustrative structure only; not loaded from a job or RAT installation",
  "model:",
  "  type: Not checked",
  "basin:",
  "  id: Not checked",
  "period:",
  "  start_date: Not checked",
  "  end_date: Not checked",
  "spin_up: Not checked",
  "forcing:",
  "  time_step: Not checked",
  "calibration:",
  "  observed_discharge: Not checked",
].join("\n");
