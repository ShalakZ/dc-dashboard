import { readFileSync } from "node:fs";
import { THEMES } from "../lib/appearance";
import { AA, contrast, customProperties, parseRules, stripComments } from "../test/cssTools";

// vitest runs from the frontend directory and reads the stylesheets as text (css: false).
const app = parseRules(stripComments(readFileSync("src/app.css", "utf8")));
const themes = parseRules(stripComments(readFileSync("src/themes.css", "utf8")));
const move = parseRules(stripComments(readFileSync("src/styles/asset-move.css", "utf8")));
const base = customProperties(app.filter((r) => r.selector === ":root")[0].body);
const rule = (selector: string) => {
  const found = move.filter((r) => r.selector === selector);
  expect(found, `exactly one rule for "${selector}"`).toHaveLength(1);
  return found[0].body;
};

/** The tokens the cascade gives an element under <html data-mode data-theme> (the same walk as the other style tests). */
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

describe("the Move to... dialog's own styles", () => {
  it("name only place-* classes (the dialog, its field and its buttons are app.css's), and use tokens only", () => {
    for (const r of move) {
      expect(r.selector, r.selector).toMatch(/\.place-/);
      expect(r.selector, r.selector).not.toMatch(/\.dialog|\.node\b/);
      expect(r.body, r.selector).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    }
  });

  it("the place list has a FIXED height, so a search that thins it never resizes the dialog or moves the buttons (a max-height would)", () => {
    const body = rule(".place-list");
    expect(body).toMatch(/(^|[;\s])height:\s*min\(/);
    expect(body).not.toMatch(/max-height/);
    expect(body).toContain("overflow: auto");
    expect(body).toContain("scrollbar-gutter: stable");
  });

  it("the message slot is three lines tall (plus the tint box's 14px) whether or not it has text, so the warning arriving moves nothing", () => {
    expect(rule(".place-message")).toContain("min-height: calc(3lh + 14px)"); // 3 lines, plus the padding and border the tinted warning adds
  });

  it("the one button whose face changes (Move, Checking..., Move anyway) has a minimum width that holds the longest, and a grey look while it is aria-disabled", () => {
    expect(rule(".place-go")).toMatch(/min-width:\s*8rem/);
    const off = move.find((r) => r.selector.startsWith('.place-go[aria-disabled="true"]'))!;
    expect(off.body).toContain("background: var(--surface)");
    expect(off.body).toContain("color: var(--text-disabled)");
  });

  it("indents by depth with a cap, so a deep branch keeps room for the name", () => {
    expect(rule(".place-row")).toContain("min(var(--depth, 0), 8)");
  });

  it.each(combos)("$id, $mode: the warning, the refusal, the chosen place and the reason read at 4.5:1 on their own grounds", ({ id, mode }) => {
    const map = cascade(id, mode);
    const token = (name: string) => map.get(name)!;
    expect(contrast(token("warn-ink"), token("warn-bg")), "warning text").toBeGreaterThanOrEqual(AA);
    expect(contrast(token("crit"), token("crit-tint")), "refusal text").toBeGreaterThanOrEqual(AA);
    expect(contrast(token("accent-ink"), token("accent-tint")), "chosen place").toBeGreaterThanOrEqual(AA);
    expect(contrast(token("text-2"), token("bg")), "reason and the unavailable place").toBeGreaterThanOrEqual(AA);
  });
});
