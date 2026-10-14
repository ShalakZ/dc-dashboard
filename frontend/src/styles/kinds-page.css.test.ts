import { readFileSync } from "node:fs";
import { THEMES } from "../lib/appearance";
import { AA, contrast, customProperties, parseRules, stripComments } from "../test/cssTools";

// W7q: the Starter tag, the toolbar and the picked rows of the Asset kinds page (src/styles/pages-assets.css, every rule under .kinds-page).
// vitest runs from the frontend directory and reads the stylesheets as text (css: false).
const app = parseRules(stripComments(readFileSync("src/app.css", "utf8")));
const themes = parseRules(stripComments(readFileSync("src/themes.css", "utf8")));
const assets = parseRules(stripComments(readFileSync("src/styles/pages-assets.css", "utf8")));
const base = customProperties(app.filter((r) => r.selector === ":root")[0].body);
const LAYER = "@layer w6";
/** The rule of a selector directly inside the layer (not in an @container or @media). */
const plain = (selector: string) => {
  const found = assets.filter((r) => r.selector === selector && r.at.length === 1 && r.at[0] === LAYER);
  expect(found, `exactly one plain rule for "${selector}"`).toHaveLength(1);
  return found[0].body;
};
/** The rule of a selector inside the container query `query`. */
const inContainer = (query: string, selector: string) => {
  const found = assets.filter((r) => r.selector === selector && r.at.length === 2 && r.at[1] === `@container ${query}`);
  expect(found, `exactly one rule for "${selector}" in @container ${query}`).toHaveLength(1);
  return found[0].body;
};
/** [ids, classes + attributes + pseudo-classes, elements] of one selector (no :is/:not/:where in the selectors compared here). */
const specificity = (selector: string): [number, number, number] => {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
  const rest = selector.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|::?[\w-]+(\([^)]*\))?/g, " ");
  return [ids, classes, (rest.match(/[A-Za-z][\w-]*/g) ?? []).length];
};
const compareSpecificity = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const declared = (body: string, prop: string) => new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(body)?.[1].trim();

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

describe("the Asset kinds page's toolbar and rows", () => {
  it("every W7q rule is under .kinds-page and writes no colour of its own", () => {
    const mine = assets.filter((r) => /kinds-(toolbar|filter|slot|bar|selected|filter-room|none)|kind-starter|kind-check|is-picked/.test(r.selector));
    expect(mine.length).toBeGreaterThan(10); // the guard can see them
    for (const r of mine) {
      expect(r.selector, r.selector).toMatch(/^\.kinds-page /);
      expect(r.body, r.selector).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    }
  });

  it("the Assets cell is found by its class: no rule names the second cell any more (a checkbox column moved it to the third)", () => {
    expect(assets.filter((r) => /nth-child\(2\)/.test(r.selector) && /kinds/.test(r.selector))).toEqual([]);
    expect(declared(plain(".kinds-page .kinds-table .kind-assets"), "white-space")).toBe("nowrap");
  });

  it("the toolbar is a container that sticks under the top bar (the --bar-h that scroll-padding-top keeps clear), on the page's own background", () => {
    const body = plain(".kinds-page .kinds-toolbar");
    expect(declared(body, "container-type")).toBe("inline-size");
    expect(declared(body, "position")).toBe("sticky");
    expect(declared(body, "top")).toBe("var(--bar-h)");
    expect(declared(body, "background")).toBe("var(--bg)"); // rows scrolling past must not show through, also not through its own bottom padding
    expect(declared(body, "margin")).toBeUndefined(); // a margin under it would be a transparent gap
    expect(app.some((r) => r.selector === "html" && /scroll-padding-top:\s*var\(--bar-h\)/.test(r.body))).toBe(true);
  });

  it("the slot has a fixed basis and a minimum height, and its own line below 720px of the toolbar's width, in both states", () => {
    const body = plain(".kinds-page .kinds-slot");
    expect(declared(body, "flex")).toBe("0 0 360px");
    expect(declared(body, "min-height")).toBe("var(--btn-h)");
    expect(declared(inContainer("(max-width: 720px)", ".kinds-page .kinds-slot"), "flex-basis")).toBe("100%");
    // Where the bar wraps under its count the slot keeps the wrapped height in the idle state too: 20px line + one or two 30px lines of buttons.
    expect(declared(plain(".kinds-page .kinds-selected"), "line-height")).toBe("20px");
    expect(declared(inContainer("(max-width: 400px)", ".kinds-page .kinds-slot"), "min-height")).toBe("50px");
    expect(declared(inContainer("(max-width: 260px)", ".kinds-page .kinds-slot"), "min-height")).toBe("80px");
  });

  it("the filter, the gap and the slot fit one line from the width where the slot stops having its own line (the filter's 336px is measured: four buttons)", () => {
    const basis = Number(/^0 0 (\d+)px$/.exec(declared(plain(".kinds-page .kinds-slot"), "flex")!)?.[1]);
    const gap = Number(/(\d+)px$/.exec(declared(plain(".kinds-page .kinds-toolbar"), "gap")!)?.[1]); // "6px 16px": the column gap is the second
    const drop = assets.find((r) => r.selector === ".kinds-page .kinds-slot" && r.at[1]?.startsWith("@container (max-width: 720px"));
    expect(drop, "the rule that gives the slot its own line").toBeDefined();
    expect(336 + gap + basis).toBeLessThanOrEqual(Number(/max-width: (\d+)px/.exec(drop!.at[1])![1]));
  });

  it("a picked row's tint is named from the page and the table, so it outranks the global row hover (tbody tr:hover > td)", () => {
    expect(declared(plain(".kinds-page .kinds-table tr.is-picked > td"), "background")).toBe("var(--accent-tint)");
    const hover = app.filter((r) => r.selector === "tbody tr:hover > td");
    expect(hover.length).toBeGreaterThan(0);
    const picked = specificity(".kinds-page .kinds-table tr.is-picked > td");
    const hovered = specificity(hover[0].selector);
    expect(compareSpecificity(picked, hovered)).toBeGreaterThan(0);
  });

  it("the icon tile, which is the picked row's own tint, turns to the page colour with a hairline on a picked row", () => {
    const body = plain(".kinds-page .kinds-table tr.is-picked .kind-tile");
    expect(declared(body, "background")).toBe("var(--bg)");
    expect(declared(body, "box-shadow")).toBe("inset 0 0 0 1px var(--border)");
  });

  it("the Starter tag is the outlined role-badge: square-ish (never a pill), in its own flex slot beside the label", () => {
    const body = plain(".kinds-page .kind-starter");
    expect(declared(body, "flex")).toBe("none");
    expect(declared(body, "margin-left")).toBe("0");
    expect(declared(body, "border-radius")).toBeUndefined(); // the radius is .role-badge's: var(--radius-sm)
    const badge = readFileSync("src/styles/pages-admin.css", "utf8");
    expect(badge).toMatch(/\.role-badge \{[^}]*border-radius: var\(--radius-sm\)/);
    expect(badge).toMatch(/\.role-badge \{[^}]*border: 1px solid var\(--border-strong\)/);
  });

  it("the page header's two buttons drop under the title below the width measured for the longer label (530px)", () => {
    const body = inContainer("(max-width: 530px)", ".kinds-page .page-head > .actions");
    expect(declared(body, "grid-column")).toBe("1");
  });

  it.each(combos)("$id, $mode: the tag, the count, the buttons and the muted text read at 4.5:1 on the grounds they sit on", ({ id, mode }) => {
    const map = cascade(id, mode);
    const token = (name: string) => map.get(name)!;
    // The Starter tag's text (--text-2, from .role-badge) on the row, on the hovered row and on a picked row.
    for (const ground of ["bg", "row-hover", "accent-tint"]) expect(contrast(token("text-2"), token(ground)), `Starter tag on ${ground}`).toBeGreaterThanOrEqual(AA);
    // The kind's name (--text) and the muted count (--text-2) on a picked row.
    expect(contrast(token("text"), token("accent-tint")), "name on a picked row").toBeGreaterThanOrEqual(AA);
    // The toolbar is on the page background: the count (--text), the quiet buttons (--accent, --crit for Delete) and the empty-filter line (--text-2).
    expect(contrast(token("text"), token("bg")), "12 selected").toBeGreaterThanOrEqual(AA);
    expect(contrast(token("accent"), token("bg")), "Select all unused, Clear, Add all").toBeGreaterThanOrEqual(AA);
    expect(contrast(token("crit"), token("bg")), "Delete").toBeGreaterThanOrEqual(AA);
    expect(contrast(token("text-2"), token("bg")), "No kinds match this filter.").toBeGreaterThanOrEqual(AA);
    // The same buttons, hovered: their wash is --accent-tint / --crit-tint.
    expect(contrast(token("accent"), token("accent-tint")), "quiet button hovered").toBeGreaterThanOrEqual(AA);
    expect(contrast(token("crit"), token("crit-tint")), "Delete hovered").toBeGreaterThanOrEqual(AA);
  });
});
