import { readFileSync } from "node:fs";
import { parseRules, stripComments } from "../test/cssTools";

// vitest runs from the frontend directory and reads the stylesheet as text (css: false).
const rules = parseRules(stripComments(readFileSync("src/styles/tree-move.css", "utf8")));
const rule = (selector: string) => {
  const found = rules.filter((r) => r.selector === selector);
  expect(found, `exactly one rule for "${selector}"`).toHaveLength(1);
  return found[0].body;
};

describe("the picking and dragging styles of the Assets Tree", () => {
  it("the 'inside' drop mark is a dashed outline, so it differs in SHAPE from a picked row's solid frame", () => {
    const body = rule('.node[data-drop="inside"]');
    expect(body).toContain("outline: 2px dashed var(--accent)");
    expect(body).toContain("outline-offset: -2px");
    expect(body).toContain("background: var(--accent-tint)");
    expect(body).not.toContain("box-shadow"); // the solid inset frame it used to be: the same as a picked row's, a pixel thicker
  });

  it("a picked row that is the target gives up its solid frame (it would show through the dashes), and keeps the open asset's bar", () => {
    expect(rule('.node[data-picked][data-drop="inside"]')).toContain("box-shadow: none");
    const both = rule('.node[data-picked].is-selected[data-drop="inside"]');
    expect(both).toContain("inset 3px 0 0 var(--accent)");
    expect(both).not.toContain("inset 0 0 0");
    // Each of these must outrank the picked rule it overrides: more attributes and classes, or the same count and later in the file.
    const order = (selector: string) => rules.findIndex((r) => r.selector === selector);
    expect(order('.node[data-picked][data-drop="inside"]')).toBeGreaterThan(order(".node[data-picked].is-selected"));
    expect(order('.node[data-picked].is-selected[data-drop="inside"]')).toBeGreaterThan(order(".node[data-picked].is-selected"));
  });

  it("the picked count never shrinks (the hint beside it is what gives way) and the buttons stay at the right", () => {
    const count = rule(".tree-slot-count");
    expect(count).toMatch(/(^|[;\s])flex:\s*none/);
    expect(count).toContain("margin-right: auto");
    const text = rule(".tree-slot-text");
    expect(text).toMatch(/flex:\s*1/);
    expect(text).toContain("min-width: 0");
    expect(text).toContain("text-overflow: ellipsis");
    // The count rule comes after the text rule: they have the same weight and both apply to the count's element.
    expect(rules.findIndex((r) => r.selector === ".tree-slot-count")).toBeGreaterThan(rules.findIndex((r) => r.selector === ".tree-slot-text"));
  });

  it("the slot's spacing is the tight one that fits '350 picked', Move to... and Clear in the narrowest column (measured: 201px of room at 220px)", () => {
    expect(rule(".tree-slot")).toContain("gap: 4px");
    expect(rule(".tree-slot")).toContain("padding: 0 6px 0 12px"); // the header's padding: 12 left, 6 right
    expect(rule(".tree-slot")).toContain("height: 32px"); // and it stays one reserved line
    expect(rule(".tree-slot-btn")).toContain("padding: 0 6px");
  });

  it("the no-drop mark is still its own dashed red frame", () => {
    expect(rule('.node[data-drop="invalid"]')).toContain("outline: 2px dashed var(--danger)");
  });
});

// W7s: Delete joins Move to... and Clear, and a slot that has it is two lines high in a narrow column. The decision is the column's own width
// (a container query on .tree-body), not a JS measurement: the first paint and the loading skeleton's slot get the same answer as the loaded bar.
describe("the Delete button and the narrow pick bar (W7s)", () => {
  const NARROW = "@container (max-width: 268px)";
  const inNarrow = rules.filter((r) => r.at.includes(NARROW));
  const narrow = (selector: string) => {
    const found = inNarrow.filter((r) => r.selector === selector);
    expect(found, `exactly one narrow rule for "${selector}"`).toHaveLength(1);
    return found[0].body;
  };

  it("the one container query of the file is 268px wide at most, and it sits inside @layer w6", () => {
    const queries = new Set(rules.flatMap((r) => r.at).filter((a) => a.startsWith("@container")));
    expect([...queries]).toEqual([NARROW]);
    expect(inNarrow.length).toBeGreaterThan(0);
    for (const r of inNarrow) expect(r.at, `"${r.selector}"`).toEqual(["@layer w6", NARROW]);
  });

  it("the tree body is the container: inline size only, so its height keeps coming from the column", () => {
    const found = rules.filter((r) => r.selector === ".tree-col > .tree-body");
    expect(found).toHaveLength(1);
    expect(found[0].at).toEqual(["@layer w6"]);
    expect(found[0].body).toMatch(/container-type:\s*inline-size/);
    expect(found[0].body).not.toMatch(/(^|[;\s])(container-type:\s*(size|normal)|contain:|container:)/); // size would collapse the height; the shorthand would name it
  });

  it("a slot that has Delete is two reserved lines high when the container is narrow: the count (or the hint) on line 1, the buttons on line 2", () => {
    const body = narrow(".tree-slot.has-delete");
    expect(body).toContain("height: 64px");
    expect(body).toContain("flex-wrap: wrap");
    expect(body).toContain("align-content: center");
    expect(body).toMatch(/row-gap:\s*2px/);
    expect(narrow(".tree-slot.has-delete .tree-slot-text")).toMatch(/flex:\s*0 0 100%/); // the whole first line, so the buttons cannot join it
  });

  it("the narrow rules name has-delete: a viewer without Delete keeps the single 32px line at every width", () => {
    for (const r of inNarrow) expect(r.selector, `"${r.selector}"`).toMatch(/^\.tree-slot\.has-delete(\s|$)/);
    expect(rule(".tree-slot")).toContain("height: 32px");
    expect(rules.filter((r) => r.at.length === 1 && r.selector.includes("has-delete"))).toEqual([]);
  });

  it("Delete is the ordinary outlined button with a critical word, filled critical-tint on hover (the page header's Delete), tokens only, and quiet while aria-disabled", () => {
    expect(rule(".tree-slot-delete")).toMatch(/color:\s*var\(--crit\)/);
    const hover = rules.find((r) => r.selector.includes(".tree-slot-delete:hover"))!;
    expect(hover.body).toMatch(/background:\s*var\(--crit-tint\)/);
    expect(hover.body).toMatch(/border-color:\s*var\(--crit\)/);
    expect(hover.selector).toContain(':not([aria-disabled="true"])');
  });

  it("all of it comes after the rules whose order is pinned above, takes colours from tokens, and adds no bare .node rule", () => {
    const order = (selector: string) => rules.findIndex((r) => r.selector === selector);
    const last = order('.node[data-picked].is-selected[data-drop="inside"]');
    expect(last).toBeGreaterThan(-1);
    for (const selector of [".tree-col > .tree-body", ".tree-slot-delete", ".tree-slot.has-delete", ".tree-slot.has-delete .tree-slot-text"]) {
      expect(order(selector), selector).toBeGreaterThan(last);
    }
    const source = stripComments(readFileSync("src/styles/tree-move.css", "utf8"));
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(rules.filter((r) => /^\.node(?![\w[.-])/.test(r.selector))).toEqual([]);
    expect(rules.every((r) => r.at[0] === "@layer w6")).toBe(true);
  });
});
