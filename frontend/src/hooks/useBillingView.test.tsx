import { renderHook } from "@testing-library/react";
import type { BillingAssetRow, BillingCosts, CostFigure } from "../api/types";
import { billingModel } from "../lib/billingRows";
import { sizeDefaultFold } from "../lib/foldLevels";
import { useBillingView } from "./useBillingView";

const figure: CostFigure = { kwh: 1, cost: 0.1, estimated: false, partial: false, no_data: false };
const asset = (asset_id: number, parent_id: number | null, name: string, metered = true): BillingAssetRow => ({
  asset_id, parent_id, name, path: name, rate_per_kwh: 0.1, days: [], total: metered ? figure : null,
});
const month = (assets: BillingAssetRow[]): BillingCosts => ({
  closed: null, month: "2026-10", timezone: "Asia/Qatar", currency: "QAR", days: [], assets,
});

/** 1 Site > 2 Hall 1 > 3 Rack 01, 4 Rack 02 ; 5 Hall 2 > 6 Rack 01. */
const small = month([
  asset(1, null, "Site"), asset(2, 1, "Hall 1"), asset(3, 2, "Rack 01"), asset(4, 2, "Rack 02"), asset(5, 1, "Hall 2"), asset(6, 5, "Rack 01"),
]);

/** 1 Site > 8 halls > 8 racks each > 1 feed each: 1 + 8 + 64 + 64 = 137 rows, more than the 60 a month opens with. */
function long(): BillingCosts {
  const rows: BillingAssetRow[] = [asset(1, null, "Site")];
  let id = 2;
  for (let h = 1; h <= 8; h++) {
    const hall = id++;
    rows.push(asset(hall, 1, `Hall ${h}`));
    for (let r = 1; r <= 8; r++) {
      const rack = id++;
      rows.push(asset(rack, hall, `Rack ${h}.${r}`));
      rows.push(asset(id++, rack, `Feed ${h}.${r}`));
    }
  }
  return month(rows);
}

describe("useBillingView", () => {
  it("is null while there are no costs and for the two empty months", () => {
    expect(renderHook(() => useBillingView(undefined, null, "")).result.current).toBeNull();
    expect(renderHook(() => useBillingView(month([]), null, "")).result.current).toBeNull();
    expect(renderHook(() => useBillingView(month([asset(1, null, "Site", false), asset(2, 1, "Hall", false)]), null, "")).result.current).toBeNull();
  });

  it("gives the model, the fold and the visible rows of a month with rows", () => {
    const { result } = renderHook(() => useBillingView(small, null, ""));
    const shown = result.current!;
    expect(shown.model.total).toBe(6);
    expect(shown.effective.size).toBe(0); // a short month opens with every row
    expect(shown.view.rows.map((r) => r.asset.asset_id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(shown.view.filtering).toBe(false);
  });

  it("folds a long month to the size default when nothing is remembered", () => {
    const costs = long();
    const { result } = renderHook(() => useBillingView(costs, null, ""));
    const expected = sizeDefaultFold(billingModel(costs.assets));
    expect(expected.size).toBeGreaterThan(0);
    expect(Array.from(result.current!.effective).sort()).toEqual(Array.from(expected).sort());
    expect(result.current!.view.shown).toBeLessThanOrEqual(60);
    expect(result.current!.view.total).toBe(137);
  });

  it("restricts a remembered fold to the rows that can fold (a leaf or a stray id is dropped)", () => {
    const { result } = renderHook(() => useBillingView(small, new Set([2, 3, 999]), ""));
    expect(Array.from(result.current!.effective)).toEqual([2]); // 3 is a leaf, 999 is not in this month
    expect(result.current!.view.rows.map((r) => r.asset.asset_id)).toEqual([1, 2, 5, 6]);
  });

  it("follows a filter: filtering is on, the rows that match are counted, the fold is ignored", () => {
    const { result } = renderHook(() => useBillingView(small, new Set([2]), "rack 01"));
    const view = result.current!.view;
    expect(view.filtering).toBe(true);
    expect(view.matches).toBe(2);
    expect(view.rows.map((r) => r.asset.asset_id)).toEqual([1, 2, 3, 5, 6]);
  });

  it("gives the same objects for the same inputs", () => {
    const folded = new Set([2]);
    const { result, rerender } = renderHook(() => useBillingView(small, folded, "ra"));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
