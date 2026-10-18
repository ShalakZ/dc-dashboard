import { readFileSync } from "node:fs";
import { THEMES } from "../lib/appearance";
import { AA, contrast, customProperties, parseRules, stripComments } from "../test/cssTools";

// vitest runs from the frontend directory and reads the stylesheets as text (css: false).
const app = parseRules(stripComments(readFileSync("src/app.css", "utf8")));
const themes = parseRules(stripComments(readFileSync("src/themes.css", "utf8")));
const confirm = parseRules(stripComments(readFileSync("src/styles/feedback-confirm.css", "utf8")));
const base = customProperties(app.filter((r) => r.selector === ":root")[0].body);

/** The tokens the cascade gives an element under <html data-mode data-theme> (the same walk as the other feedback style tests). */
function cascade(themeId: string, mode: "light" | "dark") {
  const map = new Map(base);
  const apply = (selector: string) => {
    const found = themes.filter((r) => r.selector.split(",").map((part) => part.trim()).includes(selector));
    expect(found, `exactly one rule for "${selector}"`).toHaveLength(1);
    for (const [name, value] of customProperties(found[0].body)) map.set(name, value);
  };
  apply(`:root[data-theme="${themeId}"]`);
  if (mode === "dark") apply(':root[data-mode="dark"]');
  apply(`:root[data-theme="${themeId}"][data-mode="${mode}"]`);
  return map;
}
const combos = THEMES.flatMap((t) => (["light", "dark"] as const).map((mode) => ({ id: t.id, mode })));

describe("the delete confirmation's own styles", () => {
  it("style the checking line, the empty body and the message's newlines, nothing else, and only with tokens", () => {
    expect(confirm.map((r) => r.selector).sort()).toEqual([".confirm-body .confirm-note", ".confirm-body p", ".confirm-body:empty", ".confirm-checking"]);
    for (const rule of confirm) expect(rule.body, rule.selector).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(confirm.find((r) => r.selector.endsWith(".confirm-checking"))!.body).toContain("color: var(--text-2)");
  });

  it("keeps the newlines of a message (the assets delete puts its billing warning in a paragraph of its own)", () => {
    expect(confirm.find((r) => r.selector === ".confirm-body p")!.body).toContain("white-space: pre-line");
  });

  // W18 R4: the note is a paragraph of its own under the message. The dialog zeroes every paragraph's margin (`.dialog p`, specificity 0,1,1), so the
  // rule has to out-rank it, and the gap is the one the message's own two paragraphs have: the blank line between them, one line high.
  it("the note paragraph has a top gap that out-ranks the dialog's own paragraph margin, in @layer w6, the height of a line", () => {
    const rule = confirm.find((r) => r.selector === ".confirm-body .confirm-note")!;
    expect(rule.at).toEqual(["@layer w6"]);
    expect(rule.body).toMatch(/margin-top:\s*1lh/);
    const dialogP = app.find((r) => r.selector === ".dialog h2, .dialog p");
    expect(dialogP?.body).toContain("margin: 0"); // the rule this one has to beat: (0,1,1) against this selector's (0,2,0)
    expect(rule.selector.match(/\./g)).toHaveLength(2);
  });

  it.each(combos)("$id, $mode: the checking line (--text-2) reads on the dialog's page colour at 4.5:1", ({ id, mode }) => {
    const map = cascade(id, mode);
    expect(contrast(map.get("text-2")!, map.get("bg")!)).toBeGreaterThanOrEqual(AA);
  });

  it("the dialog is on --bg (the contrast above is measured against the right colour)", () => {
    const dialog = app.find((r) => r.selector === ".dialog");
    expect(dialog?.body).toContain("background: var(--bg)");
  });
});
