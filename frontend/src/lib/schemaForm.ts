import type { JsonSchema, JsonSchemaProperty } from "../api/types";

export type FieldKind = "string" | "number" | "integer" | "boolean";
export interface FormField {
  name: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  default?: unknown;
  description?: string;
}

const KINDS: FieldKind[] = ["string", "number", "integer", "boolean"];

function kindOf(property: JsonSchemaProperty): FieldKind {
  const candidates = property.anyOf
    ? property.anyOf.map((option) => option.type).filter((t) => t !== "null")
    : [property.type];
  const first = candidates[0];
  return KINDS.includes(first as FieldKind) ? (first as FieldKind) : "string";
}

export function fieldsFromSchema(schema: JsonSchema): FormField[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, property]) => ({
    name,
    label: property.title ?? name,
    kind: kindOf(property),
    required: required.has(name),
    default: property.default,
    description: property.description,
  }));
}

export type RawValues = Record<string, string | boolean>;

export function initialValues(fields: FormField[]): RawValues {
  const out: RawValues = {};
  for (const field of fields) {
    if (field.kind === "boolean") out[field.name] = field.default === true;
    else out[field.name] = field.default === undefined || field.default === null ? "" : String(field.default);
  }
  return out;
}

export function coerceValues(fields: FormField[], raw: RawValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = raw[field.name];
    if (field.kind === "boolean") {
      out[field.name] = value === true;
      continue;
    }
    const text = typeof value === "string" ? value.trim() : "";
    if (text === "") {
      if (field.required) out[field.name] = "";
      continue;
    }
    if (field.kind === "number" || field.kind === "integer") {
      const parsed = field.kind === "integer" ? Number.parseInt(text, 10) : Number.parseFloat(text);
      out[field.name] = Number.isFinite(parsed) && String(parsed) === text ? parsed : text;
    } else {
      out[field.name] = text;
    }
  }
  return out;
}
