import { readFileSync } from "node:fs";
import { parseRules, stripComments } from "../test/cssTools";

// The template gallery's stylesheet (w27). The layer, the tokens-only colours and the clashes are guarded for every page file by app.css.test.ts;
// these are the rules of the gallery itself: a rectangular tag, a dialog that keeps its footer in sight, and the owner's look rules.
const css = stripComments(readFileSync("src/styles/templates.css", "utf8"));
const rules = parseRules(css);
const app = parseRules(stripComments(readFileSync("src/app.css", "utf8")));
const body = (selector: string) => {
  const found = rules.filter((r) => r.selector === selector);
  expect(found, `exactly one rule for "${selector}"`).toHaveLength(1);
  return found[0].body;
};
const prop = (text: string, name: string) => new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+)`).exec(text)?.[1].trim();
/** The size of a radius token as app.css declares it on :root. */
const radiusPx = (token: string) => Number(new RegExp(`${token}:\\s*(\\d+)px`).exec(app.filter((r) => r.selector === ":root").map((r) => r.body).join(";"))?.[1] ?? NaN);

describe("styles/templates.css", () => {
  it("the Recommended tag is a rectangle: its radius is the small token, 4px at most", () => {
    const radius = prop(body(".tpl-tag"), "border-radius");
    expect(radius).toBe("var(--radius-sm)");
    expect(radiusPx("--radius-sm")).toBeLessThanOrEqual(4);
  });

  it("has no pill, no italic, no monospace and no gradient anywhere", () => {
    expect(css).not.toMatch(/border-radius:\s*(999|9999|50%|100%)/);
    expect(css).not.toMatch(/font-style:\s*italic|monospace|gradient\(/);
    for (const r of rules) {
      for (const m of r.body.matchAll(/border-radius:\s*([^;]+)/g)) expect(m[1], `"${r.selector}"`).toMatch(/var\(--radius(-sm|-lg)?\)|^0\b/);
    }
  });

  it("the dialog is about 760px wide and its body is the one box that scrolls, so the footer stays in sight at 1024x640 and 800x600", () => {
    const dialog = body(".tpl-dialog");
    expect(prop(dialog, "width")).toBe("min(760px, 100%)");
    expect(prop(dialog, "overflow")).toBe("hidden");
    expect(prop(dialog, "grid-template-rows")).toBe("auto minmax(0, 1fr)");
    expect(prop(body(".tpl-pane"), "grid-template-rows")).toBe("minmax(0, 1fr) auto");
    expect(prop(body(".tpl-body"), "overflow")).toBe("auto");
    expect(prop(body(".tpl-body"), "min-height")).toBe("0");
    expect(rules.some((r) => /\.tpl-foot/.test(r.selector) && /overflow\s*:\s*(auto|scroll)/.test(r.body))).toBe(false); // the footer never scrolls
  });

  it("an idle Create (aria-disabled) looks idle on hover too", () => {
    const rule = rules.find((r) => r.selector.includes('.tpl-create[aria-disabled="true"]:hover'));
    expect(rule, "a hover rule for the waiting Create").toBeDefined();
    expect(rule!.body).toMatch(/cursor:\s*not-allowed/);
  });

  it("draws the picture with classes (no colour in the SVG itself) in tokens only", () => {
    for (const selector of [".tpl-glyph", ".tpl-glyph-text", ".tpl-mark", ".tpl-blank", ".tpl-preview"]) {
      expect(body(selector), selector).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    }
    expect(prop(body(".tpl-glyph"), "fill")).toBe("var(--bg)");
    expect(prop(body(".tpl-mark"), "stroke")).toBe("var(--accent)");
  });
});
