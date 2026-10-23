import { readFileSync } from "node:fs";
import { customProperties, parseRules, stripComments } from "../test/cssTools";

// vitest runs from the frontend directory and reads the stylesheets as text (css: false).
const rules = parseRules(stripComments(readFileSync("src/styles/pages-shapes.css", "utf8")));
const appBase = customProperties(parseRules(stripComments(readFileSync("src/app.css", "utf8"))).filter((rule) => rule.selector === ":root")[0].body);
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
    expect(bodyOf(".shapes-page .shapes-bar-note")).toMatch(/min-height:\s*1lh/); // always one line (see below), so the slot is one line
    expect(bodyOf(".shapes-dialog .shapes-status")).toMatch(/height:\s*3lh/);
    expect(bodyOf(".shapes-dialog .shapes-report")).toMatch(/height:\s*min\(/);
  });

  it("keeps the bar's note on ONE line (an ellipsis; the whole sentence is its title), so the bar is the controls and one line, never the controls and a paragraph (review Minor 6)", () => {
    const note = bodyOf(".shapes-page .shapes-bar-note");
    expect(note).toMatch(/white-space:\s*nowrap/);
    expect(note).toMatch(/overflow:\s*hidden/);
    expect(note).toMatch(/text-overflow:\s*ellipsis/);
    expect(note).toMatch(/flex:\s*1 1 0/); // no basis of its own: it takes what the controls leave on their row ...
    expect(note).toMatch(/min-width:\s*12rem/); // ... and goes to a row of its own (one line, the full width) when that is less than 12rem
  });

  it("gives the go button of the bar a width of its own, wide enough for 'Review 99,999 mappings...', so the label never moves the select and the tick (review I-1)", () => {
    const go = bodyOf(".shapes-page .shapes-bar-go button");
    expect(go).toMatch(/min-width:\s*var\(--shapes-go-w\)/);
    expect(go).toMatch(/white-space:\s*nowrap/);
    // The token is app.css's (this file defines none), in ch: the width of a digit in the button's own font. 25 characters of label, the padding (2 x 14px) and the border
    // (2 x 1px) make about 207px at 13px (measured), which is 25.2 digits of an average UI font: 30ch leaves room for the widest label and a wider font.
    expect(appBase.get("shapes-go-w")).toMatch(/^\d+ch$/);
    expect(parseInt(appBase.get("shapes-go-w") ?? "0", 10)).toBeGreaterThanOrEqual(30);
  });

  it("makes the Review dialog 1080 px wide at most and never wider than the window less 24 px each side (it must stay inside 1024 and 800)", () => {
    expect(bodyOf(".shapes-dialog")).toMatch(/width:\s*min\(1080px,\s*calc\(100vw - 48px\)\)/);
    expect(bodyOf(".shapes-dialog")).not.toMatch(/\b64rem\b/);
  });

  it("puts the dialog's one status line in the footer row, with the room of three lines, and gives it the whole first line of the footer in a narrow window", () => {
    expect(bodyOf(".shapes-dialog .shapes-status")).toMatch(/flex:\s*1 1 18rem/);
    const narrow = rules.find((rule) => rule.at.join(" ").includes("max-width") && parts(rule.selector).includes(".shapes-dialog .shapes-status"));
    expect(narrow?.body).toMatch(/flex-basis:\s*100%/);
  });

  it("keeps a word whole in the samples table: no break inside the tag, the unit hint, the metric or the scale; only the address may break anywhere; the asset path breaks at a slash", () => {
    expect(bodyOf(".shapes-dialog .shapes-samples td")).toMatch(/white-space:\s*nowrap/);
    expect(bodyOf(".shapes-dialog .shapes-samples th")).toMatch(/white-space:\s*nowrap/);
    expect(bodyOf(".shapes-dialog .shapes-samples .shapes-address")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(bodyOf(".shapes-dialog .shapes-samples .shapes-asset")).toMatch(/white-space:\s*normal/);
    expect(bodyOf(".shapes-dialog .shapes-samples .shapes-asset")).not.toMatch(/anywhere/);
    for (const rule of rules) {
      if (/\.shapes-samples/.test(rule.selector) && !/shapes-address/.test(rule.selector)) expect(rule.body, rule.selector).not.toMatch(/overflow-wrap:\s*anywhere/);
    }
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
