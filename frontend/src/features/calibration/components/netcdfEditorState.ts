import type { NetCDFCellEdit } from "../../../lib/api";

export function defaultSelectors(shape: number[]): Array<number | null> {
  return shape.map((_, axis) => axis < Math.max(0, shape.length - 2) ? 0 : null);
}

export function filterVariablesWithSelection<T extends { name: string }>(variables: T[], query: string, selectedName: string): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  const matches = variables.filter((item) => item.name.toLowerCase().includes(normalizedQuery));
  const selected = variables.find((item) => item.name === selectedName);
  return selected && !matches.some((item) => item.name === selectedName) ? [selected, ...matches] : matches;
}

export function editKey(indices: number[]): string {
  return indices.join(",");
}

export function setPendingEdit<T extends NetCDFCellEdit>(pending: Map<string, T>, edit: T, original: unknown): Map<string, T> {
  const next = new Map(pending);
  const key = editKey(edit.indices);
  if (String(original ?? "") === String(edit.value ?? "")) next.delete(key);
  else next.set(key, edit);
  return next;
}

export function matchesVariableView(view: { variable: string; selectors: Array<number | null>; dimensions: string[]; shape: number[] }, variable: string, selectors: Array<number | null>, dimensions?: string[], shape?: number[]): boolean {
  return view.variable === variable
    && JSON.stringify(view.selectors) === JSON.stringify(selectors)
    && (dimensions === undefined || JSON.stringify(view.dimensions) === JSON.stringify(dimensions))
    && (shape === undefined || JSON.stringify(view.shape) === JSON.stringify(shape));
}
