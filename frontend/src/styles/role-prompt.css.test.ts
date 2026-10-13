import { readdirSync, readFileSync } from "node:fs";
import { customProperties, parseRules, stripComments } from "../test/cssTools";

// vitest runs from the frontend directory and reads the stylesheets as text (css: false).
const text = stripComments(readFileSync("src/styles/role-prompt.css", "utf8"));
const rules = parseRules(text);
const app = parseRules(stripComments(readFileSync("src/app.css", "utf8")));
const base = customProperties(app.filter((r) => r.selector === ":root")[0].body);

// The plain rule of a selector: directly inside the layer, not in @media, @starting-style or @keyframes.
const plain = (selector: string) => {
  const found = rules.filter((r) => r.selector === selector && r.at.length === 1);
  expect(found, `exactly one plain rule for "${selector}"`).toHaveLength(1);
  return found[0].body;
};

describe("the dependency prompt's stylesheet", () => {
  it("is one @layer w6 block, with tokens only: no raw colour, and every var(--x) is a token of app.css", () => {
    expect(text.match(/@layer/g) ?? []).toHaveLength(1);
    expect(text.trimStart()).toMatch(/^@layer\s+w6\s*\{/);
    expect(text.trimEnd().endsWith("}")).toBe(true);
    expect(text).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    const used = new Set([...text.matchAll(/var\(--([\w-]+)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(0);
    for (const name of used) expect(base.has(name), `--${name} is defined in :root`).toBe(true);
  });

  it("styles only what the card owns: the card, its text, its list and its button row", () => {
    const selectors = new Set(rules.filter((r) => !r.at.some((a) => a.startsWith("@keyframes"))).map((r) => r.selector));
    expect([...selectors].sort()).toEqual([".dep-prompt", ".dep-prompt p", ".dep-prompt ul", ".dep-prompt-actions"]);
  });

  it("is a fixed card above its checkbox's row and below the tip bubble: position fixed, z-index 1 to 100 (the dialog is its own stacking context)", () => {
    const card = plain(".dep-prompt");
    expect(card).toMatch(/position:\s*fixed/);
    const z = Number(/z-index:\s*(\d+)/.exec(card)?.[1]);
    expect(z).toBeGreaterThanOrEqual(1);
    expect(z).toBeLessThanOrEqual(100);
    expect(card).toMatch(/width:\s*max-content/); // its measured width does not depend on where it is put
    expect(card).toMatch(/max-width:\s*min\(360px,\s*calc\(100vw - 16px\)\)/);
  });

  it("looks like the toast: --bg card, --border-strong edge, --shadow-pop, no pill", () => {
    const card = plain(".dep-prompt");
    expect(card).toMatch(/background:\s*var\(--bg\)/);
    expect(card).toMatch(/color:\s*var\(--text\)/);
    expect(card).toMatch(/border:\s*1px solid var\(--border-strong\)/);
    expect(card).toMatch(/border-radius:\s*var\(--radius\)/);
    expect(card).toMatch(/box-shadow:\s*var\(--shadow-pop\)/);
    expect(card).not.toMatch(/border-radius:\s*(9999|999|50%)/);
  });

  it("fades in with the 150ms motion token (the browser's @starting-style)", () => {
    expect(plain(".dep-prompt")).toMatch(/transition:\s*opacity var\(--motion\)/);
    expect(base.get("motion")).toMatch(/^150ms\b/);
    const entry = rules.filter((r) => r.selector === ".dep-prompt" && r.at.includes("@starting-style"));
    expect(entry).toHaveLength(1);
    expect(entry[0].body).toMatch(/opacity:\s*0/);
  });
});

describe("the arming delay (R8): for its first 400ms the card takes no click, so a click aimed at the next checkbox goes through", () => {
  const keyframes = rules.filter((r) => r.at.some((a) => a.startsWith("@keyframes")));

  it("is one animation, set on the card and nowhere else", () => {
    expect(text.match(/@keyframes/g) ?? []).toHaveLength(1);
    expect(text.match(/\banimation[\w-]*\s*:/g) ?? []).toHaveLength(1);
    expect(plain(".dep-prompt")).toMatch(/animation:\s*dep-prompt-arm 1ms linear 400ms backwards\s*(;|$)/);
    for (const r of rules.filter((r) => r.selector !== ".dep-prompt" || r.at.length !== 1)) expect(r.body, r.selector).not.toMatch(/\banimation[\w-]*\s*:/);
  });

  it("holds its first frame during the delay (fill-mode backwards) and sets nothing but pointer-events in it", () => {
    expect(keyframes.map((r) => r.selector)).toEqual(["from"]);
    expect(keyframes[0].at).toEqual(["@layer w6", "@keyframes dep-prompt-arm"]);
    expect(keyframes[0].body.trim().replace(/\s+/g, " ")).toBe("pointer-events: none;");
  });

  it("is not removed under reduced motion by this file (app.css only drops transitions)", () => {
    expect(rules.filter((r) => r.at.some((a) => a.includes("prefers-reduced-motion")))).toEqual([]);
  });
});

describe("a fixed card needs its ancestors to stay plain (whole-wave review I-4)", () => {
  // `position: fixed` is placed against the window only while no ancestor has transform, filter, backdrop-filter, perspective, contain,
  // container-type, content-visibility, will-change or a clip-path / mask of its own; one of them would make that ancestor the card's
  // containing block and every measured top/left would be off by its position. These are the boxes the card sits in.
  const ANCESTORS = [".dialog-backdrop", ".dialog", ".role-editor", ".role-editor-body", ".table-wrap", ".role-grid", ".role-perm", ".role-sensitive", ".role-summary"];
  const names = new RegExp(`(${ANCESTORS.map((name) => name.replace(".", "\\.")).join("|")})(?![\\w-])`);
  const CONTAINING = /(^|[;\s])(transform|filter|backdrop-filter|contain|container-type|container|content-visibility|will-change|perspective|clip-path|mask)\s*:/;
  // The one allowed: the dense tables (Sources, Scans) are measured by their own width. The Roles grid is a plain .table-wrap (tested below).
  const EXEMPT = new Set([".table-wrap.dense"]);

  const sheets = ["src/app.css", "src/themes.css", ...readdirSync("src/styles").filter((f) => f.endsWith(".css")).sort().map((f) => `src/styles/${f}`)];

  it("reads every stylesheet there is (app.css, themes.css and the five-plus files of styles/)", () => {
    expect(sheets.length).toBeGreaterThanOrEqual(10);
    expect(sheets).toContain("src/styles/role-prompt.css");
  });

  it.each(sheets)("%s gives none of those boxes a containing-block property", (file) => {
    const found = parseRules(stripComments(readFileSync(file, "utf8")))
      .filter((r) => names.test(r.selector) && CONTAINING.test(r.body) && !EXEMPT.has(r.selector))
      .map((r) => `${r.selector} { ${r.body.trim()} }`);
    expect(found).toEqual([]);
  });

  it("the guard can see one (the check run on a small example)", () => {
    const sample = parseRules(".dialog.narrow:has(> .role-editor) { filter: blur(1px); } .dialog-rows { transform: none; } .role-grid td { will-change: transform; } .table-wrap.dense { container-type: inline-size; }");
    const hits = sample.filter((r) => names.test(r.selector) && CONTAINING.test(r.body) && !EXEMPT.has(r.selector)).map((r) => r.selector);
    expect(hits).toEqual([".dialog.narrow:has(> .role-editor)", ".role-grid td"]); // .dialog-rows is another class; the exempt selector is let through
  });

  it("the exemption is real: the Roles editor's grid is a .table-wrap without .dense", () => {
    const editor = readFileSync("src/components/RoleEditor.tsx", "utf8");
    expect(editor).toContain('className="table-wrap"');
    expect(editor).not.toMatch(/table-wrap dense|dense table-wrap/);
    expect(editor).not.toMatch(/\bdense\b/);
  });
});
