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
