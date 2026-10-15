import { readFileSync } from "node:fs";
import { parseRules, stripComments } from "../test/cssTools";

// vitest runs from the frontend directory and reads the stylesheet as text (css: false).
const text = stripComments(readFileSync("src/styles/scans-polish.css", "utf8"));
const rules = parseRules(text);
const rule = (selector: string, at = "@layer w6") => {
  const found = rules.filter((r) => r.selector === selector && r.at.join(" > ") === at);
  expect(found, `exactly one rule for "${selector}" in ${at}`).toHaveLength(1);
  return found[0].body;
};

describe("the Scans page styles (W7t)", () => {
  it("is one @layer w6 block with nothing outside it, no raw colour, and only selectors that name a class", () => {
    expect(text.match(/@layer/g) ?? []).toHaveLength(1);
    expect(text.slice(0, text.search(/@layer\s+w6\s*\{/)).trim()).toBe("");
    expect(text.trim().endsWith("}")).toBe(true);
    for (const r of rules) {
      expect(r.body, `colour in "${r.selector}"`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
      expect(r.selector, "a selector names a class").toMatch(/\./);
    }
  });

  it("the note under the Ports field is two lines tall whether it has text or not, so Save does not move while someone types", () => {
    const body = rule(".scope-ports-note");
    expect(body).toMatch(/min-height:\s*2lh/);
    expect(body).toMatch(/line-height:\s*1\.4/); // the unit counts lines of the note's own line height
  });

  it("the readout is cut at two lines (a long list of named ports would be a taller slot), the warning is not", () => {
    const readout = rule(".scope-ports-readout");
    expect(readout).toContain("-webkit-line-clamp: 2");
    expect(readout).toContain("overflow: hidden");
    expect(rules.some((r) => r.selector.includes("warning"))).toBe(false);
  });

  it("the Recent scans table stacks Scan again over Details only when the TABLE is narrower than 860px, and never wraps a button's own text", () => {
    expect(rule(".scans-recent")).toContain("container-type: inline-size");
    const inQuery = "@layer w6 > @container (max-width: 859.98px)";
    expect(rule("td.scan-actions", inQuery)).toContain("white-space: normal");
    const buttons = rule("td.scan-actions > .quiet", inQuery);
    expect(buttons).toContain("display: block");
    expect(buttons).toContain("margin-left: auto");
    expect(buttons).toContain("white-space: nowrap");
    // Outside the query nothing about the cell changes: it keeps the nowrap row of pages-sources.css, so wide windows keep one line.
    expect(rules.filter((r) => r.selector.includes("scan-actions") && r.at.join(" ") === "@layer w6")).toEqual([]);
  });
});
