import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { EditableParameterField, ParameterDraft, ParameterDraftChange } from "../../../lib/api";

interface Props {
  fields: EditableParameterField[];
  draft: ParameterDraft | null;
  saving: boolean;
  saveError: string | null;
  onCancel: () => void;
  onSave: (changes: ParameterDraftChange[], expectedRevision: number | null) => Promise<void>;
}

function display(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value) ?? String(value);
}

function initialValue(field: EditableParameterField, draft: ParameterDraft | null): unknown {
  return draft?.changes.find((change) => change.field_id === field.field_id)?.value ?? field.current_value;
}

function sameValue(left: unknown, right: unknown): boolean {
  return Object.is(left, right);
}

export default function ParameterEditPanel({ fields, draft, saving, saveError, onCancel, onSave }: Props) {
  const initialValues = useMemo(() => Object.fromEntries(fields.map((field) => [field.field_id, initialValue(field, draft)])), [fields, draft]);
  const [values, setValues] = useState<Record<string, unknown>>(initialValues);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setValues(initialValues);
    setErrors({});
  }, [initialValues]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    const changes: ParameterDraftChange[] = [];

    for (const field of fields) {
      const value = values[field.field_id];
      const isNumber = typeof value === "number" && Number.isFinite(value);
      const validType = field.data_type === "string" ? typeof value === "string"
        : field.data_type === "boolean" ? typeof value === "boolean"
          : field.data_type === "integer" ? isNumber && Number.isInteger(value)
            : isNumber;
      if (!validType) {
        nextErrors[field.field_id] = `Enter a valid ${field.data_type} value.`;
        continue;
      }
      if (field.required && value === "") {
        nextErrors[field.field_id] = "This value is required.";
        continue;
      }
      if (field.allowed_values.length && !field.allowed_values.some((allowed) => sameValue(allowed, value))) {
        nextErrors[field.field_id] = `Choose an allowed value: ${field.allowed_values.map(display).join(", ")}.`;
        continue;
      }
      if (typeof value === "number" && field.minimum !== null && value < field.minimum) {
        nextErrors[field.field_id] = `Value must be at least ${field.minimum}.`;
        continue;
      }
      if (typeof value === "number" && field.maximum !== null && value > field.maximum) {
        nextErrors[field.field_id] = `Value must be at most ${field.maximum}.`;
        continue;
      }
      if (!sameValue(value, field.current_value)) changes.push({ field_id: field.field_id, value });
    }

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0 && changes.length > 0) {
      void onSave(changes, draft?.revision ?? null);
    }
  }

  if (fields.length === 0) {
    return (
      <section className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-4" aria-label="Parameter edit mode">
        <h3 className="text-sm font-semibold text-amber-950">No approved editable parameters</h3>
        <p className="mt-1 text-sm leading-5 text-amber-900">This project has not approved parameter-specific types and constraints for this file. Its parsed values remain read-only.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
          <button type="button" disabled title="There are no approved editable values to save." className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white opacity-50">Save Draft</button>
        </div>
      </section>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3 rounded-lg border border-blue-200 bg-blue-50/40 p-4" aria-label="Edit approved parameters">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">Edit approved parameters</h3>
        <p className="mt-1 text-xs text-slate-600">Changes are saved as a separate draft. The uploaded source file stays unchanged.</p>
      </div>
      {saveError && <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{saveError}</p>}
      <div className="space-y-3">
        {fields.map((field) => {
          const original = field.current_value;
          const value = values[field.field_id];
          const modified = !sameValue(value, original);
          return (
            <div key={field.field_id} className="min-w-0 rounded-lg border border-slate-200 bg-white p-3">
              <label className="block text-sm font-semibold text-slate-800" htmlFor={`parameter-${field.field_id}`}>{field.label}</label>
              {field.data_type === "boolean" ? (
                <select id={`parameter-${field.field_id}`} value={String(value)} onChange={(event) => setValues((current) => ({ ...current, [field.field_id]: event.target.value === "true" }))} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-sm">
                  <option value="true">true</option><option value="false">false</option>
                </select>
              ) : (
                <input id={`parameter-${field.field_id}`} type={field.data_type === "integer" || field.data_type === "number" ? "number" : "text"} step={field.data_type === "integer" ? "1" : "any"} value={typeof value === "number" ? value : typeof value === "string" ? value : ""} onChange={(event) => setValues((current) => ({ ...current, [field.field_id]: field.data_type === "string" ? event.target.value : event.target.value === "" ? "" : event.target.valueAsNumber }))} aria-invalid={Boolean(errors[field.field_id])} aria-describedby={errors[field.field_id] ? `error-${field.field_id}` : undefined} className="mt-1 w-full min-w-0 rounded-md border border-slate-300 px-2.5 py-2 text-sm" />
              )}
              <p className="mt-1 break-words text-xs text-slate-500">Original: <code>{display(original)}</code>{modified && <> ? Proposed: <code className="font-semibold text-blue-800">{display(value)}</code></>}</p>
              {errors[field.field_id] && <p id={`error-${field.field_id}`} role="alert" className="mt-1 text-xs text-rose-700">{errors[field.field_id]}</p>}
              {(field.minimum !== null || field.maximum !== null || field.allowed_values.length > 0) && <p className="mt-1 text-xs text-slate-500">Approved constraints: {field.minimum !== null ? `minimum ${field.minimum}` : ""}{field.minimum !== null && field.maximum !== null ? "; " : ""}{field.maximum !== null ? `maximum ${field.maximum}` : ""}{field.allowed_values.length > 0 ? ` permitted values ${field.allowed_values.map(display).join(", ")}` : ""}</p>}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-3">
        <button type="button" onClick={onCancel} disabled={saving} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
        <button type="submit" disabled={saving || fields.every((field) => sameValue(values[field.field_id], field.current_value))} className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{saving ? "Saving?" : "Save Draft"}</button>
      </div>
    </form>
  );
}
