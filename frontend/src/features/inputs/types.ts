export type DependencyStatus = "Not checked" | "Needs review";

export interface InputDependency {
  name: string;
  category: string;
  role: string;
  exampleReference: string;
  status: DependencyStatus;
}

export interface ConfigurationSection {
  title: string;
  description: string;
}

export interface ConfigurationSummaryItem {
  label: string;
  value: string;
}

export interface ValidationFinding {
  severity: "issue" | "warning";
  message: string;
}
