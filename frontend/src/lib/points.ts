import type { PointRow } from "../api/types";

export type PointSortKey = "address" | "name" | "data_type" | "unit_hint" | "mapped";
export interface PointView { sort: PointSortKey; dir: "asc" | "desc"; unmappedOnly: boolean; query: string }
export const DEFAULT_POINT_VIEW: PointView = { sort: "address", dir: "asc", unmappedOnly: false, query: "" };

// Numeric: `3:2` sorts before `3:10`. Base sensitivity: case and accents do not split ties.
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

const mappedText = (p: PointRow, assetLabel: (assetId: number) => string): string =>
  p.mapping ? `${assetLabel(p.mapping.asset_id)} ${p.mapping.metric}` : "";

function sortText(p: PointRow, key: PointSortKey, assetLabel: (assetId: number) => string): string {
  switch (key) {
    case "address": return p.address;
    case "name": return p.name;
    case "data_type": return p.data_type;
    case "unit_hint": return p.unit_hint ?? "";
    case "mapped": return mappedText(p, assetLabel);
  }
}

/** The rows to show: filtered (unmapped only; `query` as a case-insensitive substring of address, name, type, unit hint, mapped asset label or metric) then sorted. */
export function viewPoints(points: PointRow[], assetLabel: (assetId: number) => string, view: PointView): PointRow[] {
  const query = view.query.trim().toLowerCase();
  const kept = points.filter((p) => {
    if (view.unmappedOnly && p.mapping) return false;
    if (query === "") return true;
    const fields = [p.address, p.name, p.data_type, p.unit_hint ?? "", p.mapping ? assetLabel(p.mapping.asset_id) : "", p.mapping?.metric ?? ""];
    return fields.some((field) => field.toLowerCase().includes(query));
  });
  const sign = view.dir === "desc" ? -1 : 1;
  const rows = kept.map((point) => ({ point, text: sortText(point, view.sort, assetLabel) }));
  // Only the primary comparison is reversed; ties always read in address order.
  rows.sort((a, b) =>
    sign * collator.compare(a.text, b.text) || collator.compare(a.point.address, b.point.address) || a.point.id - b.point.id);
  return rows.map((row) => row.point);
}

/** The view after a click on a column header: same column flips the direction, a new column starts ascending. */
export function sortBy(view: PointView, key: PointSortKey): PointView {
  if (view.sort === key) return { ...view, dir: view.dir === "asc" ? "desc" : "asc" };
  return { ...view, sort: key, dir: "asc" };
}
