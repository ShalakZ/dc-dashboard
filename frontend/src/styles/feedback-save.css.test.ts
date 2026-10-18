import { readdirSync, readFileSync } from "node:fs";
import { THEMES } from "../lib/appearance";
import { AA, contrast, customProperties, parseRules, stripComments } from "../test/cssTools";

// vitest runs from the frontend directory and reads the stylesheets as text (css: false).
const app = stripComments(readFileSync("src/app.css", "utf8"));
const appRules = parseRules(app);
const themes = parseRules(stripComments(readFileSync("src/themes.css", "utf8")));
const save = parseRules(stripComments(readFileSync("src/styles/feedback-save.css", "utf8")));
const base = customProperties(appRules.filter((r) => r.selector === ":root")[0].body);

/** The one rule whose selector list has `selector` as a member (a list is split at its commas; none here sits inside parentheses). */
const only = (list: typeof save, selector: string) => {
  const found = list.filter((r) => r.selector.split(",").map((part) => part.trim()).includes(selector));
  expect(found, `exactly one rule for "${selector}"`).toHaveLength(1);
  return found[0];
};

/** The tokens the cascade gives an element under <html data-mode data-theme> (the same walk as themes.css.test.ts). */
function cascade(themeId: string, mode: "light" | "dark") {
  const map = new Map(base);
  const apply = (selector: string) => {
    for (const [name, value] of customProperties(only(themes, selector).body)) map.set(name, value);
  };
  apply(`:root[data-theme="${themeId}"]`);
  if (mode === "dark") apply(':root[data-mode="dark"]');
  apply(`:root[data-theme="${themeId}"][data-mode="${mode}"]`);
  return map;
}

/** CSS specificity [ids, classes + attributes + pseudo-classes, types]. :where() counts nothing, :not() and :is() count their argument. */
function specificity(selector: string): [number, number, number] {
  const flat = selector.replace(/:where\([^)]*\)/g, "").replace(/:(?:not|is)\(([^)]*)\)/g, " $1 ");
  const noAttr = flat.replace(/\[[^\]]*\]/g, "");
  return [
    (flat.match(/#[\w-]+/g) ?? []).length,
    (flat.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length,
    (noAttr.match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length,
  ];
}
const beats = (a: [number, number, number], b: [number, number, number]) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

const combos = THEMES.flatMap((t) => (["light", "dark"] as const).map((mode) => ({ id: t.id, mode })));

describe("the saved button's colours", () => {
  it("the checks can see a failure (the helpers are exercised on known values)", () => {
    expect(contrast("#ffffff", "#ffff00")).toBeLessThan(AA);
    expect(specificity('button.save-btn[data-phase="saved"]:hover:not(:disabled)')).toEqual([0, 4, 1]);
    expect(specificity(".primary:hover:not(:disabled)")).toEqual([0, 3, 0]);
    expect(specificity("button:where(:hover:not(:disabled))")).toEqual([0, 0, 1]);
  });

  it.each(combos)("$id, $mode: the page colour on the green fill reads at 4.5:1", ({ id, mode }) => {
    const map = cascade(id, mode);
    expect(contrast(map.get("bg")!, map.get("ok")!)).toBeGreaterThanOrEqual(AA);
  });
});

describe("the SaveButton section", () => {
  it("is one @layer w6 block", () => {
    const text = stripComments(readFileSync("src/styles/feedback-save.css", "utf8"));
    expect(text.match(/@layer/g)).toHaveLength(1);
    expect(text).toMatch(/^\s*@layer\s+w6\s*\{/);
    expect(save.length).toBeGreaterThan(0);
    for (const rule of save) expect(rule.at, rule.selector).toEqual(expect.arrayContaining(["@layer w6"]));
  });

  it("colours are tokens only: var(--…), never a literal", () => {
    for (const rule of save) {
      const colours = [...rule.body.matchAll(/(?:^|;|\s)(color|background|background-color|border|border-color|outline|outline-color|box-shadow)\s*:\s*([^;]+)/g)];
      for (const [, property, value] of colours) {
        expect(value, `${property} in "${rule.selector}"`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
        expect(value.replace(/var\(--[\w-]+\)/g, ""), `${property} in "${rule.selector}"`).not.toMatch(/\b(white|black|red|green|blue|gray|grey|yellow|orange)\b/i);
      }
    }
  });

  it("the three labels share one grid cell, so one width holds in every state", () => {
    expect(only(save, ".save-btn").body).toMatch(/display:\s*inline-grid/);
    expect(only(save, ".save-face").body).toMatch(/grid-area:\s*1\s*\/\s*1/);
    expect(only(save, ".save-face").body).toMatch(/display:\s*inline-flex/);
  });

  it("the button is never narrower than the loading skeleton's placeholder, whatever the font (a floor, so a longer label still grows it)", () => {
    expect(only(save, ".save-btn").body).toMatch(/min-width:\s*92px/);
    expect(only(save, ".save-btn").body).not.toMatch(/(^|;|\s)(width|max-width):/);
    // the three skeletons that stand in for it draw the same number
    expect(readFileSync("src/pages/SettingsPage.tsx", "utf8")).toMatch(/SAVE_WIDTH = 92;/);
    expect(readFileSync("src/pages/StoragePage.tsx", "utf8")).toMatch(/\[92, 120, 124, 176\]/);
    expect(readFileSync("src/components/Skeleton.tsx", "utf8")).toMatch(/<Skeleton variant="block" width=\{92\} height=\{CTL_H\} \/>/);
  });

  it("the faces that are not showing are hidden, not collapsed (they still set the width)", () => {
    const hidden = only(save, '.save-face[aria-hidden="true"]').body;
    expect(hidden).toMatch(/visibility:\s*hidden/);
    expect(hidden).not.toMatch(/display:\s*none/);
  });

  it("the button's display beats every other rule that sets `display` on a button (app.css and the page style files): grid, not flex", () => {
    const pageRules = readdirSync("src/styles")
      .filter((f) => f.endsWith(".css") && !f.startsWith("feedback-"))
      .flatMap((f) => parseRules(stripComments(readFileSync(`src/styles/${f}`, "utf8"))));
    const setsDisplay = (r: { selector: string; body: string }) => /(^|;|\s)display\s*:/.test(r.body);
    // a rule for a <button> element: its last compound selector is `button` or starts with it (`button.danger`, `.row button:not(.x)`)
    const forButtons = (r: { selector: string }) => r.selector.split(",").some((part) => /(^|[\s>+~])button(?![\w-])/.test(part.trim()));
    const rivals = [...appRules, ...pageRules].filter((r) => forButtons(r) && setsDisplay(r));
    expect(rivals.length, "app.css's base `button` rule is among them").toBeGreaterThan(0);
    for (const rule of rivals) {
      for (const part of rule.selector.split(",").map((p) => p.trim()).filter((p) => /(^|[\s>+~])button(?![\w-])/.test(p))) {
        expect(beats(specificity(".save-btn"), specificity(part)), `".save-btn" against "${part}"`).toBe(true);
      }
    }
  });

  it("the green wins over .primary and over .primary:hover, and over the base hover", () => {
    const rest = only(save, 'button.save-btn[data-phase="saved"]');
    const hover = only(save, 'button.save-btn[data-phase="saved"]:hover:not(:disabled)');
    for (const rule of [rest, hover]) {
      expect(rule.body).toMatch(/background:\s*var\(--ok\)/);
      expect(rule.body).toMatch(/border-color:\s*var\(--ok\)/);
      expect(rule.body).toMatch(/color:\s*var\(--bg\)/);
    }
    const primary = appRules.find((r) => r.selector === ".primary")!;
    const primaryHover = appRules.find((r) => r.selector === ".primary:hover:not(:disabled)")!;
    const primaryDisabled = appRules.find((r) => r.selector === ".primary:disabled")!;
    expect(primary && primaryHover && primaryDisabled).toBeTruthy();
    expect(beats(specificity(rest.selector), specificity(primary.selector))).toBe(true);
    expect(beats(specificity(rest.selector), specificity(primaryDisabled.selector))).toBe(true);
    expect(beats(specificity(hover.selector), specificity(primaryHover.selector))).toBe(true);
  });

  it("entering the green takes 150 ms, fading back 600 ms, and only colours move (the width never does)", () => {
    expect(only(save, 'button.save-btn[data-phase="saved"]').body).toMatch(/transition:[^;]*150ms/);
    const fade = only(save, 'button.save-btn[data-phase="fading"]').body;
    expect(fade).toMatch(/transition:[^;]*background-color 600ms[^;]*border-color 600ms[^;]*color 600ms/);
    for (const rule of save) expect(rule.body, rule.selector).not.toMatch(/transition:[^;]*\b(all|width|padding|min-width)\b/);
  });

  it("uses no hard-banned look: no italic, no monospace, no gradient, no pill radius", () => {
    for (const rule of save) expect(rule.body, rule.selector).not.toMatch(/font-style:\s*italic|monospace|gradient\(|border-radius:\s*(9999|999|50%)/);
  });
});
