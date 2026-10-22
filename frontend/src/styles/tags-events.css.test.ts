import { readFileSync } from "node:fs";
import { THEMES } from "../lib/appearance";
import { AA, contrast, customProperties, parseRules, stripComments } from "../test/cssTools";

// vitest runs from the frontend directory and reads the stylesheets as text (css: false).
const app = parseRules(stripComments(readFileSync("src/app.css", "utf8")));
const themes = parseRules(stripComments(readFileSync("src/themes.css", "utf8")));
const tags = parseRules(stripComments(readFileSync("src/styles/tags-events.css", "utf8")));
const base = customProperties(app.filter((r) => r.selector === ":root")[0].body);

/** The tokens the cascade gives an element under <html data-mode data-theme>. */
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

/** Each variant of the tag and the status pair it takes (the pairs of .chip, whose contrast the theme tests check). */
const VARIANTS: [string, string, string][] = [
  ["info", "info-tint", "info"], ["warning", "warn-tint", "warn"], ["error", "crit-tint", "crit"],
  ["passed", "ok-tint", "ok"], ["failed", "crit-tint", "crit"], ["running", "stale-tint", "stale"],
];

describe("the square tag of the System events page and the Audit outcome (w32)", () => {
  it("is every rule in @layer w6, with tokens only: no colour of its own and so no new token to put in the looks", () => {
    expect(tags.length).toBe(1 + VARIANTS.length);
    for (const rule of tags) {
      expect(rule.at, rule.selector).toEqual(["@layer w6"]);
      expect(rule.body, rule.selector).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
      expect(rule.body, rule.selector).not.toMatch(/^\s*--|;\s*--/); // it defines no custom property
    }
  });

  it("names its six variants, and each takes the tint and the ink of the status it stands for", () => {
    for (const [name, tint, ink] of VARIANTS) {
      const rule = tags.find((r) => r.selector === `.ev-tag-${name}`);
      expect(rule, `.ev-tag-${name}`).toBeDefined();
      expect(rule!.body).toContain(`background: var(--${tint})`);
      expect(rule!.body).toContain(`color: var(--${ink})`);
    }
  });

  it("is a square, never a pill: the corner is the 4 px token and the box is a chip's height", () => {
    const base = tags.find((r) => r.selector === ".ev-tag")!;
    expect(base.body).toContain("border-radius: var(--radius-sm)");
    expect(app.filter((r) => r.selector === ":root")[0].body).toMatch(/--radius-sm:\s*4px/);
    expect(base.body).toContain("height: var(--chip-h)");
    expect(base.body).toContain("white-space: nowrap");
    expect(base.body).not.toMatch(/border-radius:\s*(9{2,}|50%|\d{2,}px)/);
  });

  it.each(combos)("reads at AA in $id $mode", ({ id, mode }) => {
    const tokens = cascade(id, mode);
    for (const [name, tint, ink] of VARIANTS) {
      expect(contrast(tokens.get(ink)!, tokens.get(tint)!), `${name} in ${id} ${mode}`).toBeGreaterThanOrEqual(AA);
    }
  });
});

describe("main.tsx (w32 tags)", () => {
  it("imports the tag stylesheet after app.css (its layer is declared there)", () => {
    const main = readFileSync("src/main.tsx", "utf8");
    expect(main).toContain('import "./styles/tags-events.css";');
    expect(main.indexOf('import "./styles/tags-events.css"')).toBeGreaterThan(main.indexOf('import "./app.css"'));
  });
});
