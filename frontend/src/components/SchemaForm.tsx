import type { FormField, RawValues } from "../lib/schemaForm";

export function SchemaForm({ fields, values, onChange }: { fields: FormField[]; values: RawValues; onChange: (v: RawValues) => void }) {
  const set = (name: string, value: string | boolean) => onChange({ ...values, [name]: value });
  return (
    <>
      {fields.map((f) => (
        <label key={f.name}>
          {f.label}
          {f.kind === "boolean" ? (
            <input type="checkbox" checked={values[f.name] === true} onChange={(e) => set(f.name, e.target.checked)} />
          ) : (
            <input type={f.kind === "string" ? "text" : "number"} step={f.kind === "integer" ? "1" : f.kind === "number" ? "any" : undefined}
              required={f.required} value={String(values[f.name] ?? "")} onChange={(e) => set(f.name, e.target.value)} />
          )}
          {f.description && <small className="muted">{f.description}</small>}
        </label>
      ))}
    </>
  );
}
