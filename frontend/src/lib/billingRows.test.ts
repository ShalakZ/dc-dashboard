import type { BillingAssetRow, BillingCosts, CostFigure } from "../api/types";
import { BILLING_FOLD_KEY, billingHasRows, billingModel, noMatchText, rowsLine, twistyLabel, visibleRows } from "./billingRows";
import { foldModel } from "./foldLevels";

const row = (asset_id: number, parent_id: number | null, name: string, path = name): BillingAssetRow => ({
  asset_id, parent_id, name, path, rate_per_kwh: null, days: [], total: null,
});

/**
 * 1 Site
 *   2 Hall 1       4 Rack 01      5 Rack 02
 *   3 Hall 2       6 Rack 01
 * 7 Spare (a root)
 * Listed in tree order, as the billing API lists them.
 */
const assets = [
  row(1, null, "Site", "Site"),
  row(2, 1, "Hall 1", "Site / Hall 1"),
  row(4, 2, "Rack 01", "Site / Hall 1 / Rack 01"),
  row(5, 2, "Rack 02", "Site / Hall 1 / Rack 02"),
  row(3, 1, "Hall 2", "Site / Hall 2"),
  row(6, 3, "Rack 01", "Site / Hall 2 / Rack 01"),
  row(7, null, "Spare", "Spare"),
];
const model = billingModel(assets);
const ids = (v: { rows: { asset: BillingAssetRow }[] }) => v.rows.map((r) => r.asset.asset_id);

describe("billingModel", () => {
  it("is the fold model of the rows, keyed by asset_id", () => {
    expect(BILLING_FOLD_KEY).toBe("dcdash.billingFolded");
    const same = foldModel(assets.map((a) => ({ id: a.asset_id, parent_id: a.parent_id })));
    expect(model).toEqual(same);
    expect(model.total).toBe(7);
    expect(model.roots).toEqual([1, 7]);
    expect(model.maxDepth).toBe(2);
  });
});

describe("visibleRows without a filter", () => {
  it("shows every row when nothing is folded, with depth, below and mode", () => {
    const v = visibleRows(assets, model, new Set(), "");
    expect(ids(v)).toEqual([1, 2, 4, 5, 3, 6, 7]);
    expect(v.rows.map((r) => r.depth)).toEqual([0, 1, 2, 2, 1, 2, 0]);
    expect(v.rows.map((r) => r.below)).toEqual([5, 2, 0, 0, 1, 0, 0]);
    expect(v.rows.map((r) => r.mode)).toEqual(["open", "open", "leaf", "leaf", "open", "leaf", "leaf"]);
    expect(v.rows.every((r) => !r.context)).toBe(true);
    expect(v.shown).toBe(7);
    expect(v.total).toBe(7);
    expect(v.matches).toBe(0);
    expect(v.filtering).toBe(false);
  });

  it("hides what is below a folded row, keeps its own row, and keeps the below count in full", () => {
    const v = visibleRows(assets, model, new Set([2]), "");
    expect(ids(v)).toEqual([1, 2, 3, 6, 7]);
    const hall1 = v.rows.find((r) => r.asset.asset_id === 2)!;
    expect(hall1.mode).toBe("folded");
    expect(hall1.below).toBe(2);
    expect(v.shown).toBe(5);
    expect(v.total).toBe(7);
  });

  it("hides the whole subtree of a folded row, and a fold inside it is not shown", () => {
    const v = visibleRows(assets, model, new Set([1, 2]), "");
    expect(ids(v)).toEqual([1, 7]);
    expect(v.rows[0].mode).toBe("folded");
    expect(v.rows[0].below).toBe(5);
    expect(v.shown).toBe(2);
  });

  it("shows a folded child when only the child is folded, and ignores ids that are not rows or cannot fold", () => {
    const v = visibleRows(assets, model, new Set([3, 99, 4]), "");
    expect(ids(v)).toEqual([1, 2, 4, 5, 3, 7]);
    expect(v.rows.find((r) => r.asset.asset_id === 3)!.mode).toBe("folded");
    expect(v.rows.find((r) => r.asset.asset_id === 4)!.mode).toBe("leaf"); // a leaf never reads as folded
  });

  it("is empty for no assets", () => {
    const v = visibleRows([], billingModel([]), new Set(), "");
    expect(v).toEqual({ rows: [], shown: 0, total: 0, matches: 0, filtering: false });
  });

  it("treats a filter of spaces as no filter", () => {
    const folded = new Set([2]);
    const spaces = visibleRows(assets, model, folded, "   ");
    expect(spaces).toEqual(visibleRows(assets, model, folded, ""));
    expect(spaces.filtering).toBe(false);
  });

  it("keeps the rows' own objects", () => {
    const v = visibleRows(assets, model, new Set(), "");
    expect(v.rows[0].asset).toBe(assets[0]);
  });
});

describe("visibleRows with a filter", () => {
  it("shows the matches and the ancestors of a match, in tree order, and nothing else", () => {
    const v = visibleRows(assets, model, new Set(), "rack 01");
    expect(ids(v)).toEqual([1, 2, 4, 3, 6]);
    expect(v.rows.map((r) => r.context)).toEqual([true, true, false, true, false]);
    expect(v.rows.map((r) => r.mode)).toEqual(["open", "open", "leaf", "open", "leaf"]);
    expect(v.rows.map((r) => r.depth)).toEqual([0, 1, 2, 1, 2]);
    expect(v.matches).toBe(2);
    expect(v.shown).toBe(5);
    expect(v.total).toBe(7);
    expect(v.filtering).toBe(true);
  });

  it("does not show the non-matching descendants of a match", () => {
    const v = visibleRows(assets, model, new Set(), "hall 1");
    expect(ids(v)).toEqual([1, 2]);
    expect(v.rows[1].context).toBe(false);
    expect(v.rows[1].mode).toBe("leaf"); // Rack 01 and Rack 02 are under it but do not match: no shown child
    expect(v.matches).toBe(1);
    const site = visibleRows(assets, model, new Set(), "site");
    expect(ids(site)).toEqual([1]);
    expect(site.rows[0].mode).toBe("leaf");
  });

  it("marks a match that has a matching descendant open, and not as context", () => {
    const more = [...assets.slice(0, 3), row(8, 4, "Hall 1 spare", "Site / Hall 1 / Rack 01 / Hall 1 spare"), ...assets.slice(3)];
    const v = visibleRows(more, billingModel(more), new Set(), "hall 1");
    expect(ids(v)).toEqual([1, 2, 4, 8]);
    expect(v.rows.map((r) => r.context)).toEqual([true, false, true, false]);
    expect(v.rows.map((r) => r.mode)).toEqual(["open", "open", "open", "leaf"]);
    expect(v.matches).toBe(2);
  });

  it("shows a match under a folded branch, and ignores the fold set", () => {
    const folded = new Set([1, 2]);
    const v = visibleRows(assets, model, folded, "rack 02");
    expect(ids(v)).toEqual([1, 2, 5]);
    expect(v.rows.map((r) => r.mode)).toEqual(["open", "open", "leaf"]);
  });

  it("leaves the fold set alone, and the same call without the filter brings the fold back", () => {
    const folded = new Set([2]);
    const before = visibleRows(assets, model, folded, "");
    visibleRows(assets, model, folded, "rack 02");
    expect([...folded]).toEqual([2]);
    expect(visibleRows(assets, model, folded, "")).toEqual(before);
    expect(ids(before)).toEqual([1, 2, 3, 6, 7]);
  });

  it("is case-insensitive, and trims the text", () => {
    expect(ids(visibleRows(assets, model, new Set(), "RACK 02"))).toEqual([1, 2, 5]);
    expect(ids(visibleRows(assets, model, new Set(), "  rAcK 02 "))).toEqual([1, 2, 5]);
  });

  it("searches the name only, never the path", () => {
    // "Site / Hall 1 / Rack 01" holds "hall 1" and "site", but the rack's name does not.
    const v = visibleRows(assets, model, new Set(), "site / hall");
    expect(v.rows).toEqual([]);
    expect(v.matches).toBe(0);
    expect(ids(visibleRows(assets, model, new Set(), "spare"))).toEqual([7]);
  });

  it("gives no rows for no match, and still says it is filtering", () => {
    const v = visibleRows(assets, model, new Set(), "zzz");
    expect(v).toEqual({ rows: [], shown: 0, total: 7, matches: 0, filtering: true });
  });

  it("counts a matching root with nothing below it", () => {
    const v = visibleRows(assets, model, new Set(), "spare");
    expect(v.rows.map((r) => [r.asset.asset_id, r.mode, r.context])).toEqual([[7, "leaf", false]]);
  });
});

describe("visibleRows on a big list", () => {
  it("walks a 2,000-row chain, folded and filtered, without overflowing the stack", () => {
    const chain = Array.from({ length: 2000 }, (_, i) => row(i + 1, i === 0 ? null : i, `Level ${i + 1}`));
    const big = billingModel(chain);
    expect(big.maxDepth).toBe(1999);
    const open = visibleRows(chain, big, new Set(), "");
    expect(open.shown).toBe(2000);
    expect(open.rows[1999].depth).toBe(1999);
    const folded = visibleRows(chain, big, new Set([10]), "");
    expect(folded.shown).toBe(10);
    const filtered = visibleRows(chain, big, new Set(), "level 2000");
    expect(filtered.shown).toBe(2000); // the one match and every ancestor
    expect(filtered.matches).toBe(1);
  });
});

describe("the wording", () => {
  it("labels a twisty with the action, the name and the rows below", () => {
    expect(twistyLabel("Hall 1", true, 59)).toBe("Collapse Hall 1, 59 rows below");
    expect(twistyLabel("Hall 1", false, 59)).toBe("Expand Hall 1, 59 rows below");
    expect(twistyLabel("Hall 1", true, 1)).toBe("Collapse Hall 1, 1 row below");
    expect(twistyLabel("Hall 1", false, 1)).toBe("Expand Hall 1, 1 row below");
  });

  it("says how many rows are shown when nothing filters", () => {
    expect(rowsLine({ shown: 370, total: 370, matches: 0, filtering: false })).toBe("All 370 rows shown");
    expect(rowsLine({ shown: 24, total: 370, matches: 0, filtering: false })).toBe("Showing 24 of 370 rows");
    expect(rowsLine({ shown: 1, total: 1, matches: 0, filtering: false })).toBe("1 row");
    expect(rowsLine({ shown: 0, total: 0, matches: 0, filtering: false })).toBe("No rows");
    expect(rowsLine({ shown: 2, total: 2, matches: 0, filtering: false })).toBe("All 2 rows shown");
  });

  it("says how many rows match when a filter has text", () => {
    expect(rowsLine({ shown: 15, total: 370, matches: 12, filtering: true })).toBe("12 of 370 rows match");
    expect(rowsLine({ shown: 0, total: 370, matches: 0, filtering: true })).toBe("No rows match");
    expect(rowsLine({ shown: 1, total: 1, matches: 1, filtering: true })).toBe("1 of 1 row match");
    expect(rowsLine({ shown: 0, total: 0, matches: 0, filtering: true })).toBe("No rows match");
  });

  it("names the filter in the no-match text, trimmed, in straight quotes", () => {
    expect(noMatchText("rack 99")).toBe('No assets match "rack 99".');
    expect(noMatchText("  rack 99 ")).toBe('No assets match "rack 99".');
  });
});

describe("billingHasRows", () => {
  const figure: CostFigure = { kwh: 1, cost: 0.1, estimated: false, partial: false, no_data: false };
  const month = (assetRows: BillingAssetRow[]): BillingCosts => ({
    closed: null, month: "2026-10", timezone: "Asia/Qatar", currency: "QAR", days: [], assets: assetRows,
  });

  it("is false when the month has no assets at all", () => {
    expect(billingHasRows(month([]))).toBe(false);
  });

  it("is false when no asset has a total (no energy data), true as soon as one has", () => {
    expect(billingHasRows(month(assets))).toBe(false); // the fixture rows above all have total: null
    expect(billingHasRows(month([...assets, { ...row(8, null, "Metered"), total: figure }]))).toBe(true);
  });
});
