import { readFileSync } from "node:fs";
import { THEMES } from "../lib/appearance";
import { AA, contrast, customProperties, parseRules, stripComments } from "../test/cssTools";

// vitest runs from the frontend directory and reads the stylesheets as text (css: false). jsdom has no layout, so the declarations are pinned here;
// the button's count and the drawer were looked at in a browser (widths 1440, 1024 and 800, light and dark).
const app = parseRules(stripComments(readFileSync("src/app.css", "utf8")));
const themes = parseRules(stripComments(readFileSync("src/themes.css", "utf8")));
const text = stripComments(readFileSync("src/styles/month-check.css", "utf8"));
const rules = parseRules(text);
const base = customProperties(app.filter((r) => r.selector === ":root")[0].body);

const rule = (selector: string) => {
  const found = rules.filter((r) => r.selector === selector && r.at.join(" > ") === "@layer w6");
  expect(found, `exactly one plain rule for "${selector}"`).toHaveLength(1);
  return found[0].body;
};

describe("the month check stylesheet (w21)", () => {
  it("is one @layer w6 block with nothing outside it, tokens only, only selectors that name a class, and the UI bans hold", () => {
    expect(text.match(/@layer/g) ?? []).toHaveLength(1);
    expect(text.slice(0, text.search(/@layer\s+w6\s*\{/)).trim()).toBe("");
    expect(text.trim().endsWith("}")).toBe(true);
    for (const r of rules) {
      expect(r.body, `colour in "${r.selector}"`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
      expect(r.selector, "a selector names a class").toMatch(/\./);
    }
    const used = new Set([...text.matchAll(/var\(--([\w-]+)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(0);
    for (const name of used) expect(base.has(name), `--${name} is a token of app.css`).toBe(true);
    expect(text).not.toMatch(/font-style:\s*italic/); // no italic accent
    expect(text).not.toMatch(/font-family/); // no monospace label
    expect(text).not.toMatch(/border-radius:\s*(\d{3,}px|50%|9999)/); // no pill
    expect(text).not.toMatch(/!important/);
  });

  it("the count is a slot of a FIXED width (2.75em holds 99+ in its own font: a minimum would let 99+ widen the button) that stays when it is empty, a small rounded rectangle and not a pill", () => {
    const slot = rule(".check-count");
    expect(slot).toMatch(/display:\s*inline-block/);
    expect(slot).toMatch(/box-sizing:\s*border-box/);
    expect(slot).toMatch(/(^|[;\s])width:\s*2\.75em/);
    expect(slot).not.toMatch(/min-width/);
    expect(slot).toMatch(/text-align:\s*center/);
    expect(slot).toMatch(/border-radius:\s*var\(--radius-sm\)/);
    expect(slot).toMatch(/font-variant-numeric:\s*tabular-nums/);
    // Empty it draws nothing, but it keeps its room: the rule changes the fill and nothing else.
    expect(rule(".check-count:empty").replace(/background:[^;]+;?/, "").trim()).toBe("");
    expect(rule(".check-count:empty")).toMatch(/background:\s*none/);
    expect(text, "the slot never collapses").not.toMatch(/display:\s*none|:empty\s*\{[^}]*(width|display)/);
  });

  it("sets no height of its own: the Check month button stays at the base button's --ctl-h, and no rule here names a button", () => {
    expect(text).not.toMatch(/(^|[;{\s])(min-|max-)?height\s*:/);
    expect(text).not.toMatch(/(^|[\s,>+~])button\b/);
    expect(app.find((r) => r.selector === "button")!.body).toMatch(/min-height:\s*var\(--ctl-h\)/);
  });

  it("a number is the warning chip's pair, a zero the quiet stale chip's pair", () => {
    expect(rule(".check-count")).toMatch(/background:\s*var\(--warn-tint\)/);
    expect(rule(".check-count")).toMatch(/color:\s*var\(--warn\)/);
    expect(rule(".check-count[data-zero]")).toMatch(/background:\s*var\(--stale-tint\)/);
    expect(rule(".check-count[data-zero]")).toMatch(/color:\s*var\(--stale\)/);
  });

  it("the groups are columns with a rule above each, the findings have a rule between them, and a long path wraps instead of widening the drawer", () => {
    expect(rule(".month-check-body")).toMatch(/flex-direction:\s*column/);
    expect(rule(".month-check-body")).toMatch(/min-width:\s*0/);
    expect(rule(".month-check-group")).toMatch(/border-top:\s*1px solid var\(--border\)/);
    expect(rule(".month-check-list")).toMatch(/list-style:\s*none/);
    expect(rule(".month-check-item")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".month-check-item")).toMatch(/border-top:\s*1px solid var\(--border\)/);
    expect(rule(".month-check-item:first-child")).toMatch(/border-top:\s*0/);
  });
});

describe("the count's colours, in every look", () => {
  /** The tokens an element gets under <html data-mode data-theme> (the same walk as the drawer's style test). */
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

  it("covers all eight looks", () => {
    expect(combos).toHaveLength(8);
  });

  it.each(combos)("$id, $mode: the number (--warn on --warn-tint) and the zero (--stale on --stale-tint) read at 4.5:1", ({ id, mode }) => {
    const map = cascade(id, mode);
    expect(contrast(map.get("warn")!, map.get("warn-tint")!)).toBeGreaterThanOrEqual(AA);
    expect(contrast(map.get("stale")!, map.get("stale-tint")!)).toBeGreaterThanOrEqual(AA);
  });
});

describe("main.tsx", () => {
  it("imports the stylesheet after app.css (its layer is declared there)", () => {
    const main = readFileSync("src/main.tsx", "utf8");
    expect(main).toContain('import "./styles/month-check.css";');
    expect(main.indexOf('import "./styles/month-check.css"')).toBeGreaterThan(main.indexOf('import "./app.css"'));
  });
});
