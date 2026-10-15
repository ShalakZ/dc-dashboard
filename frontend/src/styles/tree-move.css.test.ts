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
  const NARROW = "@container (max-width: 275px)";
  const inNarrow = rules.filter((r) => r.at.includes(NARROW));
  const narrow = (selector: string) => {
    const found = inNarrow.filter((r) => r.selector === selector);
    expect(found, `exactly one narrow rule for "${selector}"`).toHaveLength(1);
    return found[0].body;
  };

  it("the one container query of the file is 275px wide at most, and it sits inside @layer w6", () => {
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

  it("a slot that has Delete is two reserved lines high when the container is narrow: the count (or the hint) and Move to... on line 1, Delete and Clear on line 2", () => {
    const body = narrow(".tree-slot.has-delete");
    expect(body).toContain("height: 64px");
    expect(body).toContain("flex-wrap: wrap");
    expect(body).toMatch(/row-gap:\s*2px/);
    // W7t: line 1 stands still. With something picked there are three flex lines (the break item is the middle one) and with nothing picked two,
    // so a centred block (align-content: center) would move line 1 by 13px at the first pick; from the top it cannot (7 + 24 + 2 + 0 + 2 + 24 + 5 = 64).
    expect(body).toMatch(/align-content:\s*flex-start/);
    expect(body).not.toContain("align-content: center");
    expect(body).toMatch(/padding-top:\s*7px/);
    // The text takes the room beside Move to... (it used to be the whole first line, which put every button on the second).
    const text = narrow(".tree-slot.has-delete .tree-slot-text");
    expect(text).toMatch(/flex:\s*1 1 0(?![\w%])/);
    expect(text).not.toMatch(/100%/);
    expect(text).toMatch(/line-height:\s*24px/); // as high as a button, so line 1 is 24px with or without Move to... and the words stay put
  });

  it("a zero-height break item forces Delete and Clear onto line 2: it is a flex item of 100% after the order-0 items and before the order-2 buttons", () => {
    const brk = narrow(".tree-slot.has-delete::after");
    expect(brk).toMatch(/content:\s*""/);
    expect(brk).toMatch(/flex:\s*0 0 100%/);
    expect(brk).toMatch(/height:\s*0(?![\w.])/);
    expect(brk).toMatch(/order:\s*1(?![\w.])/);
    expect(narrow(".tree-slot.has-delete .tree-slot-delete")).toMatch(/order:\s*2(?![\w.])/);
    expect(narrow(".tree-slot.has-delete .tree-slot-clear")).toMatch(/order:\s*2(?![\w.])/);
  });

  it("the short hint ('Ctrl-click to pick') replaces the long one only in a slot that has Delete in a narrow container; elsewhere the long hint stays", () => {
    expect(rule(".tree-slot-short")).toMatch(/display:\s*none/); // outside the query: a viewer without Delete, and every wide column
    expect(rules.find((r) => r.selector === ".tree-slot-short")!.at).toEqual(["@layer w6"]);
    expect(narrow(".tree-slot.has-delete .tree-slot-long")).toMatch(/display:\s*none/);
    expect(narrow(".tree-slot.has-delete .tree-slot-short")).toMatch(/display:\s*inline/);
    // The base rule comes first, so the narrow rule of the same selector weight outranks it by order and by its higher specificity.
    expect(rules.findIndex((r) => r.selector === ".tree-slot-short")).toBeLessThan(rules.findIndex((r) => r.selector === ".tree-slot.has-delete .tree-slot-short"));
  });

  it("the narrow rules name has-delete: a viewer without Delete keeps the single 32px line at every width", () => {
    for (const r of inNarrow) expect(r.selector, `"${r.selector}"`).toMatch(/^\.tree-slot\.has-delete(::after|\s|$)/);
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
    for (const selector of [
      ".tree-col > .tree-body", ".tree-slot-delete", ".tree-slot-short", ".tree-slot.has-delete", ".tree-slot.has-delete::after",
      ".tree-slot.has-delete .tree-slot-text", ".tree-slot.has-delete .tree-slot-delete", ".tree-slot.has-delete .tree-slot-clear",
      ".tree-slot.has-delete .tree-slot-long", ".tree-slot.has-delete .tree-slot-short",
    ]) {
      expect(order(selector), selector).toBeGreaterThan(last);
    }
    const source = stripComments(readFileSync("src/styles/tree-move.css", "utf8"));
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(rules.filter((r) => /^\.node(?![\w[.-])/.test(r.selector))).toEqual([]);
    expect(rules.every((r) => r.at[0] === "@layer w6")).toBe(true);
  });
});
