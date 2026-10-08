import type { BillingAssetRow } from "../api/types";

/** `2026-01` moved by `delta` months, as plain `YYYY-MM` string maths (no Date, so no timezone can shift it). */
export function shiftMonth(month: string, delta: number): string {
  const [year, m] = month.split("-").map(Number);
  const index = year * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** `October 2026` for `2026-10`. */
export function monthLabel(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(Date.UTC(year, m - 1, 1)));
}

/** Tree depth per asset id. The API lists assets parents-first, so one pass over the parent chain is enough. */
export function depthsByAsset(assets: readonly BillingAssetRow[]): Map<number, number> {
  const depth = new Map<number, number>();
  for (const a of assets) {
    const parent = a.parent_id === null ? undefined : depth.get(a.parent_id);
    depth.set(a.asset_id, parent === undefined ? 0 : parent + 1);
  }
  return depth;
}

export const fmtKwh = (kwh: number) => kwh.toFixed(1);
export const fmtCost = (cost: number) => cost.toFixed(2);
/** A rate with up to six decimals and no trailing zeros; a dash when there is none (never zero). */
export const fmtRate = (rate: number | null) => (rate === null ? "—" : String(Number(rate.toFixed(6))));
