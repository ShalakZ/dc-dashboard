import { breakdownBlock, breakdownData, valueRow } from "../test/dashboardFixtures";
import {
  breakdownDescription, breakdownLine, drillAction, drillTip, emptyBreakdownText, hasNoBars, insideOthersText, isNoDataBar, kindNoun, kindOptions, moreFigure, moreText,
  narrowLabel, parentIds, pluralKind, selectedKind,
} from "./breakdown";

const more = (over: Partial<ReturnType<typeof breakdownBlock>["more"]> = {}) => breakdownBlock({ more: { count: 107, with_value: 107, value: 1234.5, estimated: false, partial: false, ...over } });

describe("the kind in the plural", () => {
  it("adds an s unless the kind ends in one, and keeps its capitalisation", () => {
    expect(pluralKind("Rack")).toBe("Racks");
    expect(pluralKind("Panels")).toBe("Panels");
    expect(pluralKind("Other equipment")).toBe("Other equipments");
    expect(pluralKind("UPS")).toBe("UPS");
    expect(pluralKind("pdu")).toBe("pdus");
  });

  it("is the kind itself for exactly one", () => {
    expect(kindNoun("Rack", 1)).toBe("Rack");
    expect(kindNoun("Rack", 2)).toBe("Racks");
    expect(kindNoun("Rack", 0)).toBe("Racks");
  });
});

describe("the line under the chart", () => {
  it("says how many more and their sum in all, with the unit", () => {
    expect(moreText(more(), "kWh")).toBe("and 107 more Racks: 1234.50 kWh in all");
  });

  it("carries the sum's ~ and * marks, and a cost's currency", () => {
    expect(moreText(more({ value: 12.3, estimated: true, partial: true }), "QAR")).toBe("and 107 more Racks: ~12.30* QAR in all");
  });

  it("uses the singular for one more, and says how many of the rest had no figure", () => {
    expect(moreText(more({ count: 1, with_value: 1, value: 4 }), "kWh")).toBe("and 1 more Rack: 4.00 kWh in all");
    expect(moreText(more({ count: 10, with_value: 7, value: 4 }), "kWh")).toBe("and 10 more Racks: 4.00 kWh in all (3 with no data)");
  });

  it("is a dash, never a zero, when the sum cannot be worked out, and empty when nothing was left out", () => {
    expect(moreText(more({ count: 5, with_value: 0, value: null }), "kWh")).toBe("and 5 more Racks: —");
    expect(moreFigure(more({ count: 5, with_value: 0, value: null }), "kWh")).toEqual({ text: "—", without: 0 });
    expect(moreText(more({ count: 0, with_value: 0, value: null }), "kWh")).toBe("");
  });

  it("says how many are inside others, in the singular and the plural", () => {
    expect(insideOthersText(breakdownBlock({ inside_others: 3 }))).toBe("3 Racks are inside other Racks and are counted there.");
    expect(insideOthersText(breakdownBlock({ inside_others: 1 }))).toBe("1 Rack is inside another Rack and is counted there.");
    expect(insideOthersText(breakdownBlock({ inside_others: 0 }))).toBe("");
  });

  it("is both sentences on one line, or whichever applies, or nothing", () => {
    expect(breakdownLine({ ...more(), inside_others: 3 }, "kWh")).toBe("and 107 more Racks: 1234.50 kWh in all 3 Racks are inside other Racks and are counted there.");
    expect(breakdownLine(more(), "kWh")).toBe("and 107 more Racks: 1234.50 kWh in all");
    expect(breakdownLine(breakdownBlock({ inside_others: 2, more: { count: 0, with_value: 0, value: null, estimated: false, partial: false } }), "kWh"))
      .toBe("2 Racks are inside other Racks and are counted there.");
    expect(breakdownLine(breakdownBlock({ more: { count: 0, with_value: 0, value: null, estimated: false, partial: false } }), "kWh")).toBe("");
  });
});

describe("a chart with nothing to draw", () => {
  const panels = (over: Partial<ReturnType<typeof breakdownBlock>> = {}) => breakdownBlock({ kind: "Panel", root: { id: 1, name: "Seeded pilot hall" }, count: 8, ...over });

  it("knows when no bar has a figure", () => {
    expect(hasNoBars([])).toBe(true);
    expect(hasNoBars([valueRow({ value: null, no_data: true })])).toBe(true);
    expect(hasNoBars([valueRow({ value: null }), valueRow({ value: 0 })])).toBe(false);
    expect(hasNoBars([valueRow({ value: null, no_data: true }), valueRow({ value: 0, no_data: true })]), "a silent meter's zero is no figure either").toBe(true);
    expect(hasNoBars([valueRow({ value: 0, no_data: true }), valueRow({ value: 3 })])).toBe(false);
  });

  it("knows a bar that recorded nothing: no figure or the zero of a silent meter, both flagged no_data; a recorded zero and a figure are not", () => {
    expect(isNoDataBar({ value: null, no_data: true })).toBe(true);
    expect(isNoDataBar({ value: 0, no_data: true })).toBe(true);
    expect(isNoDataBar({ value: 0, no_data: false })).toBe(false);
    expect(isNoDataBar({ value: null, no_data: false })).toBe(false); // a cost recorded without a rate: the "no rate" dash, not "no data"
    expect(isNoDataBar({ value: 4.2, no_data: true })).toBe(false);
  });

  it("says none of the assets has readings, naming the root", () => {
    expect(emptyBreakdownText(panels(), "energy")).toBe("None of the 8 Panels under Seeded pilot hall has energy readings.");
    expect(emptyBreakdownText(panels(), "cost")).toBe("None of the 8 Panels under Seeded pilot hall has cost figures.");
  });

  it("says the site when there is no root, and the singular for one asset", () => {
    expect(emptyBreakdownText(panels({ root: null }), "energy")).toBe("None of the 8 Panels under the site has energy readings.");
    expect(emptyBreakdownText(panels({ count: 1 }), "energy")).toBe("The Panel under Seeded pilot hall has no energy readings.");
  });

  it("says there are none of the kind at all, and under an asset points to Split by when the asset holds other kinds (w25)", () => {
    const under = panels({ count: 0, root: { id: 2, name: "Hall 1" }, kinds: [{ kind: "Rack", count: 117 }] });
    expect(emptyBreakdownText(under, "energy")).toBe("No Panels under Hall 1. Choose another kind in Split by.");
    expect(emptyBreakdownText({ ...under, kind: "rack", kinds: [{ kind: "Rack", count: 117 }, { kind: "Row", count: 3 }] }, "energy")).toBe("No racks under Hall 1. Choose another kind in Split by.");
  });

  it("keeps the plain sentence with no root, and where the root holds no other kind (nothing to choose)", () => {
    expect(emptyBreakdownText(panels({ count: 0, root: null, kinds: [{ kind: "Rack", count: 117 }] }), "energy")).toBe("No Panels under the site.");
    expect(emptyBreakdownText(panels({ count: 0, root: { id: 2, name: "Hall 1" }, kinds: [] }), "energy")).toBe("No Panels under Hall 1.");
    expect(emptyBreakdownText(panels({ count: 0, root: { id: 2, name: "Hall 1" }, kinds: [{ kind: "panel", count: 0 }] }), "energy"), "the same kind spelled otherwise is not another kind").toBe("No Panels under Hall 1.");
  });

  it("leaves the sentences of assets that have no readings as they are, under an asset too", () => {
    const kinds = [{ kind: "Panel", count: 8 }, { kind: "Rack", count: 117 }];
    expect(emptyBreakdownText(panels({ kinds }), "energy")).toBe("None of the 8 Panels under Seeded pilot hall has energy readings.");
    expect(emptyBreakdownText(panels({ count: 1, kinds }), "cost")).toBe("The Panel under Seeded pilot hall has no cost figures.");
  });
});

describe("drill-through on a breakdown (w25, R10)", () => {
  const assets = [
    { id: 1, parent_id: null, name: "Site", kind: "site", sort_order: 0 },
    { id: 2, parent_id: 1, name: "Hall 1", kind: "hall", sort_order: 0 },
    { id: 3, parent_id: 2, name: "Rack 05", kind: "rack", sort_order: 0 },
    { id: 4, parent_id: 3, name: "Feed A", kind: "feed", sort_order: 0 },
  ];

  it("knows which assets have children: those that are some asset's parent", () => {
    expect([...parentIds(assets)].sort()).toEqual([1, 2, 3]);
    expect(parentIds([]).size).toBe(0);
  });

  it("narrows to an asset with children and opens the page of one without", () => {
    const parents = parentIds(assets);
    expect(drillAction(3, parents)).toBe("narrow");
    expect(drillAction(4, parents)).toBe("open");
    expect(drillAction(99, parents), "an asset the list does not know has no children there").toBe("open");
  });

  it("words the tooltip's line and the button", () => {
    expect(drillTip("narrow", "Rack 05")).toBe("Click to narrow the dashboard to Rack 05");
    expect(drillTip("open", "Feed A")).toBe("Click to open Feed A's page");
    expect(narrowLabel("Rack 05")).toBe("Narrow to Rack 05");
  });
});

describe("Split by", () => {
  it("lists each kind with its count", () => {
    expect(kindOptions(breakdownBlock(), "Rack")).toEqual([{ value: "Rack", label: "Rack (117)" }, { value: "Panel", label: "Panel (8)" }]);
  });

  it("adds the kind being shown first when the list does not hold it, and never a blank one", () => {
    expect(kindOptions(breakdownBlock(), "Row")[0]).toEqual({ value: "Row", label: "Row (0)" });
    expect(kindOptions(breakdownBlock(), "Row")).toHaveLength(3);
    expect(kindOptions(breakdownBlock(), "  ")).toHaveLength(2);
  });

  it("matches the shown kind to an option by the comparison key, not by its spelling", () => {
    const options = kindOptions(breakdownBlock(), "rack");
    expect(options).toHaveLength(2); // "rack" is "Rack": not added again
    expect(selectedKind(options, "rack")).toBe("Rack");
    expect(selectedKind(options, "Row")).toBe("Row");
  });
});

describe("the chart's name for a screen reader", () => {
  it("says how many bars of how many assets, under what", () => {
    expect(breakdownDescription(breakdownData(10), breakdownBlock())).toBe("Bar chart of 10 of 117 Racks under Hall 1. Energy in kWh. Open Details for the figures.");
    expect(breakdownDescription(breakdownData(3), breakdownBlock({ count: 3, root: null }))).toBe("Bar chart of 3 Racks under the site. Energy in kWh. Open Details for the figures.");
  });
});
