import { readFileSync } from "node:fs";
import { parseRules, stripComments } from "../test/cssTools";

// vitest runs from the frontend directory and reads the stylesheets as text (css: false).
const rules = parseRules(stripComments(readFileSync("src/styles/pages-shapes.css", "utf8")));
/** A selector list split at its top-level commas (a comma inside :is(...) or [...] stays in its part). */
function parts(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of selector) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else current += ch;
  }
  return [...out, current.trim()];
}
const bodyOf = (selector: string) => rules.find((rule) => parts(rule.selector).includes(selector))?.body ?? "";

describe("the Map by shape stylesheet (w36)", () => {
  it("has rules, and every one is in @layer w6 (app.css.test.ts also holds the one-layer shape and the raw-colour check for the file)", () => {
    expect(rules.length).toBeGreaterThan(30);
    for (const rule of rules) expect(rule.at[0], rule.selector).toBe("@layer w6");
  });

  it("starts every selector with the page class .shapes-page or the dialog's .shapes-dialog, so no other page, row or table is restyled", () => {
    for (const rule of rules) {
      for (const part of parts(rule.selector)) expect(part, rule.selector).toMatch(/^\.(shapes-page|shapes-dialog)(?![\w-])/);
    }
  });

  it("names no class that another page file owns (the Points page's Map by shape link and cap line, the Sources toolbar)", () => {
    const text = rules.map((rule) => rule.selector).join("\n");
    expect(text).not.toMatch(/\.(shape-link|points-cap|toolbar)(?![\w-])/);
  });

  it("defines no token of its own and writes no raw colour", () => {
    for (const rule of rules) {
      expect(rule.body, rule.selector).not.toMatch(/(^|;)\s*--[\w-]+\s*:/);
      expect(rule.body, rule.selector).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    }
  });

  it("moves nothing: no transition, no animation and no keyframes", () => {
    for (const rule of rules) {
      expect(rule.body, rule.selector).not.toMatch(/\b(transition|animation)\b/);
      expect(rule.at.join(" "), rule.selector).not.toMatch(/keyframes|starting-style/);
    }
  });

  it("sets nothing in a monospace face, draws no pill and no corner over the radius tokens", () => {
    for (const rule of rules) {
      expect(rule.body, rule.selector).not.toMatch(/monospace|ui-mono|font-family/);
      const radius = /border-radius:\s*([^;]+)/.exec(rule.body)?.[1];
      if (radius) expect(radius, rule.selector).toMatch(/^var\(--radius(-sm)?\)$/);
    }
  });

  it("keeps the room of what appears later: the warning slot of a row, the search line, the status line of the dialog and the note of the bar", () => {
    expect(bodyOf(".shapes-page .shape-warn")).toMatch(/min-height:\s*2lh/);
    expect(bodyOf(".shapes-page .shapes-live")).toMatch(/min-height:\s*2lh/);
    expect(bodyOf(".shapes-page .shapes-bar-note")).toMatch(/min-height:\s*2lh/);
    expect(bodyOf(".shapes-dialog .shapes-status")).toMatch(/height:\s*3lh/);
    expect(bodyOf(".shapes-dialog .shapes-report")).toMatch(/height:\s*min\(/);
  });

  it("styles a button that waits by aria-disabled, never by :disabled (the focus may be on it)", () => {
    const text = rules.map((rule) => rule.selector).join("\n");
    expect(text).toContain('[aria-disabled="true"]');
    expect(text).not.toMatch(/:disabled/);
  });

  it("is imported after app.css (its layer is declared there)", () => {
    const main = readFileSync("src/main.tsx", "utf8");
    expect(main).toContain('import "./styles/pages-shapes.css";');
    expect(main.indexOf('import "./styles/pages-shapes.css"')).toBeGreaterThan(main.indexOf('import "./app.css"'));
  });
});
