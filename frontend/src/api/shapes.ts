import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "./client";
import type { Metric } from "./types";

// w36 Map by tag shape. The types are the CONTRACT of the plan (GET /api/sources/{id}/shapes and POST /api/sources/{id}/shapes/lines); the page reads them and
// works out nothing about shapes itself.

export interface ShapeExample { name: string; address: string }
export interface ShapeSuggestion {
  metric: Metric; scale: number; interval_seconds: number; custom_unit: string | null;
  /** Always true: the server only ever guesses. */
  guess: true;
  /** The members of the shape disagree about the metric. */
  mixed: boolean;
}
/** The meters like this one: how many have the shape, and the first names (5) that lack it. */
export interface ShapeEquipment { population: number; with_shape: number; missing: string[]; missing_total: number }
export type Billing = "counter" | "power";
export interface Shape {
  /** The identity of the shape: digits collapsed to `#`, case-folded. It may contain `#`: never put it in a selector or an id. */
  key: string;
  label: string;
  count: number;
  mapped: number;
  twins: number;
  duplicates: number;
  examples: ShapeExample[];
  unit_hints: string[];
  mixed_units: boolean;
  suggestion: ShapeSuggestion;
  billing: Billing | null;
  per_equipment: number;
  equipment: ShapeEquipment | null;
  /** Keys of the shapes that differ only in one letter of the equipment part. */
  similar: string[];
  rule: null;
}
export interface ShapeAsset { id: number; parent_id: number | null; name: string; kind: string; icon: string | null }
export interface ShapeMatch { name: string; address: string; shape: string | null }
export interface ShapesAnswer {
  source_id: number;
  source_name: string;
  points: number;
  mapped: number;
  other_tags: number;
  other_examples: ShapeExample[];
  shapes: Shape[];
  shapes_total: number;
  more_shapes: number;
  assets: ShapeAsset[];
  matches?: { count: number; first: ShapeMatch[] };
}

export type NameFrom = "part1" | "parts12" | "part1_part2";
/** One line of the lines request. `scale` and `unit` are left out on purpose: the server then uses the shape's suggested scale and its single unit hint. */
export interface ShapeDecision { shape: string; metric: Metric; name_from: NameFrom }
export interface ShapeLinesBody { decisions: ShapeDecision[]; parent_id: number | null; create_assets: boolean }
export type CheckSeverity = "blocking" | "warning";
export interface ShapeCheck { kind: string; severity: CheckSeverity; shape: string | null; text: string }
export interface ShapeLinesByShape { shape: string; label: string; lines: number; assets: number; skipped_mapped: number; skipped_twins: number }
export interface ShapeSample { shape: string; tag: string; address: string; asset: string; unit_hint: string | null; metric: Metric; scale: number }
export interface ShapeLinesAnswer {
  csv: string;
  lines: number;
  blocking: boolean;
  by_shape: ShapeLinesByShape[];
  checks: ShapeCheck[];
  samples: ShapeSample[];
}

/** The longest `q` the server takes (a longer one is a 422). */
export const SEARCH_MAX = 100;
/** The shortest: a shorter text sends no `q` at all. */
export const SEARCH_MIN = 2;

/** The query key sits under `keys.sources` on purpose, so that the tag-list Undo and every write that refreshes the sources refresh this page too. */
export const shapesKey = (sourceId: number, q: string) => ["sources", sourceId, "shapes", q] as const;

/** The path of the shapes read. `q` is encoded with URLSearchParams: a text may hold `&`, `#` or `%`. */
export function shapesPath(sourceId: number, q: string): string {
  const base = `/api/sources/${sourceId}/shapes`;
  return q === "" ? base : `${base}?${new URLSearchParams({ q })}`;
}

/**
 * The shapes of a source (discovery.view). The previous answer stays on screen while a new search is read, so typing never puts the page back into loading
 * (which would unmount the search box and drop its focus).
 */
export const useShapes = (sourceId: number, q: string) =>
  useQuery({ queryKey: shapesKey(sourceId, q), queryFn: () => api.get<ShapesAnswer>(shapesPath(sourceId, q)), placeholderData: keepPreviousData });

/** Read-only: the tag-list CSV of these decisions, with the server's checks (discovery.accept). Nothing is written. */
export const postShapeLines = (sourceId: number, body: ShapeLinesBody) =>
  api.post<ShapeLinesAnswer>(`/api/sources/${sourceId}/shapes/lines`, body);
