import { readFileSync } from "node:fs";
import { THEMES } from "../lib/appearance";
import { AA, contrast, customProperties, parseRules, stripComments } from "../test/cssTools";

// vitest runs from the frontend directory and reads the stylesheets as text (css: false). jsdom has no layout, so the declarations are pinned
// here and the drawer was looked at in a browser (widths, the toast over the footer, light and dark).
const app = parseRules(stripComments(readFileSync("src/app.css", "utf8")));
const themes = parseRules(stripComments(readFileSync("src/themes.css", "utf8")));
const toasts = parseRules(stripComments(readFileSync("src/styles/feedback-toasts.css", "utf8")));
const css = stripComments(readFileSync("src/styles/drawer.css", "utf8"));
const drawer = parseRules(css);
const base = customProperties(app.filter((r) => r.selector === ":root")[0].body);

/** The plain rule of a selector: directly in the layer, not inside @media or @keyframes. */
const rule = (selector: string) => {
  const found = drawer.filter((r) => r.selector === selector && r.at.length === 1);
  expect(found, `exactly one plain rule for "${selector}"`).toHaveLength(1);
  return found[0].body;
};
const z = (body: string) => Number(/z-index:\s*(\d+)/.exec(body)?.[1]);
const zOf = (list: typeof app, selector: string) => z(list.find((r) => r.selector === selector)?.body ?? "");

describe("the drawer's stylesheet", () => {
  it("uses tokens only: no raw colour, every var(--x) is a token of app.css or the drawer's own footer height, and the UI bans hold", () => {
    for (const r of drawer) expect(r.body, `colour in "${r.selector}"`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    const used = new Set([...css.matchAll(/var\(--([\w-]+)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(0);
    for (const name of used) expect(base.has(name) || name === "drawer-foot-h", `--${name} is defined`).toBe(true);
    expect(css).not.toMatch(/font-style:\s*italic/); // no italic accent
    expect(css).not.toMatch(/font-family/); // no monospace label (the JSON block is the page's own)
    expect(css).not.toMatch(/border-radius:\s*(\d{3,}px|50%|9999)/); // no pill
  });

  it("is a dimmed layer over the whole window at 800: above the pop-ups, the sidebar tip and the loading bar, below the toasts and the dialogs", () => {
    const back = rule(".drawer-backdrop");
    expect(back).toMatch(/position:\s*fixed/);
    expect(back).toMatch(/inset:\s*0\b/);
    expect(back).toMatch(/background:\s*var\(--backdrop\)/);
    expect(back).toMatch(/overscroll-behavior:\s*contain/);
    expect(z(back)).toBe(800);
    for (const above of [".row-menu-panel", ".prof-menu", ".side-tip", ".top-progress", ".navbar"]) expect(z(back), above).toBeGreaterThan(zOf(app, above));
    expect(z(back)).toBeLessThan(zOf(toasts, ".toast-stack"));
    expect(z(back)).toBeLessThan(zOf(app, ".dialog-backdrop"));
    expect(zOf(app, ".tip-bubble"), "the ? bubbles inside a drawer stay on top").toBeGreaterThan(z(back));
    expect(rule(".drawer"), "the panel stacks inside its backdrop").not.toMatch(/z-index/);
  });

  it("is 520px wide at most (min(520px, 100vw)) and the whole width below 720px, the same breakpoint as the toast stack", () => {
    expect(rule(".drawer")).toMatch(/width:\s*min\(520px,\s*100vw\)/);
    expect(rule(".drawer")).toMatch(/height:\s*100%/);
    const narrow = drawer.filter((r) => r.selector === ".drawer" && r.at.some((a) => /max-width:\s*719\.98px/.test(a)));
    expect(narrow).toHaveLength(1);
    expect(narrow[0].body).toMatch(/width:\s*100%/);
    const stackNarrow = toasts.filter((r) => r.selector === ".toast-stack" && r.at.some((a) => /max-width:\s*719\.98px/.test(a)));
    expect(stackNarrow, "the toast stack's narrow breakpoint is the same text").toHaveLength(1);
  });

  it("is a column: a pinned head, one scrolling body that does not chain its scroll to the page, and an optional pinned footer", () => {
    expect(rule(".drawer")).toMatch(/display:\s*flex/);
    expect(rule(".drawer")).toMatch(/flex-direction:\s*column/);
    expect(rule(".drawer-head")).toMatch(/flex:\s*none/);
    expect(rule(".drawer-foot")).toMatch(/flex:\s*none/);
    const body = rule(".drawer-body");
    expect(body).toMatch(/flex:\s*1\b/);
    expect(body).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/overscroll-behavior:\s*contain/);
  });

  it("slides in over 200 ms (the backdrop fades over the same time) and does not move at all under prefers-reduced-motion", () => {
    expect(rule(".drawer")).toMatch(/animation:\s*drawer-in 200ms\b/);
    expect(rule(".drawer-backdrop")).toMatch(/animation:\s*drawer-fade 200ms\b/);
    const frames = (name: string) => drawer.filter((r) => r.at.includes(`@keyframes ${name}`));
    expect(frames("drawer-in")).toHaveLength(1);
    expect(frames("drawer-in")[0].body).toMatch(/transform:\s*translateX\(100%\)/);
    expect(frames("drawer-fade")).toHaveLength(1);
    expect(frames("drawer-fade")[0].body).toMatch(/opacity:\s*0/);
    const reduced = drawer.filter((r) => r.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a)));
    expect(reduced).toHaveLength(1);
    expect(reduced[0].selector.split(",").map((s) => s.trim()).sort()).toEqual([".drawer", ".drawer-backdrop"]);
    expect(reduced[0].body).toMatch(/animation:\s*none/);
  });

  it("keeps no resting transform, filter or containment on the drawer: it would become the containing block of the row menus and help bubbles inside it", () => {
    const CONTAINING = /(^|[;\s])(transform|filter|backdrop-filter|contain|container-type|container|content-visibility|will-change|perspective|clip-path|mask)\s*:/;
    const resting = drawer.filter((r) => !r.at.some((a) => a.startsWith("@keyframes")) && CONTAINING.test(r.body)).map((r) => r.selector);
    expect(resting).toEqual([]);
  });

  it("paints the pairs measured below: --text on a --bg panel, the close cross from .icon-btn (--text-2)", () => {
    expect(rule(".drawer")).toMatch(/background:\s*var\(--bg\)/);
    expect(rule(".drawer")).toMatch(/color:\s*var\(--text\)/);
    expect(rule(".drawer-foot")).toMatch(/background:\s*var\(--bg\)/);
    expect(app.find((r) => r.selector === ".icon-btn")!.body).toMatch(/color:\s*var\(--text-2\)/);
    expect(rule(".drawer-head")).not.toMatch(/background|\bcolor:/); // the head is the panel's colour
  });
});

describe("the toast stack over a drawer (plan review C2)", () => {
  const bottom = (body: string) => /bottom:\s*([^;]+)/.exec(body)?.[1].trim();

  it("the footer height is one fixed token, declared where the stack can see it (the body), and the footer uses nothing else", () => {
    expect([...css.matchAll(/--drawer-foot-h\s*:/g)]).toHaveLength(1);
    const declared = rule("body:has(.drawer)");
    expect(declared).toMatch(/--drawer-foot-h:\s*\d+px/);
    expect(parseInt(/--drawer-foot-h:\s*(\d+)px/.exec(declared)![1], 10)).toBeGreaterThanOrEqual(50); // room for a 34px button and its air
    const foot = rule(".drawer-foot");
    expect(foot).toMatch(/\bheight:\s*var\(--drawer-foot-h\)/);
    expect(foot).not.toMatch(/(min|max)-height/);
  });

  it("while a drawer is open the stack's bottom is the footer height plus the stack's own 16px margin, at every width", () => {
    const stackMargin = bottom(toasts.find((r) => r.selector === ".toast-stack" && r.at.length === 1)!.body);
    expect(stackMargin).toBe("16px");
    const lift = rule("body:has(.drawer) .toast-stack");
    expect(bottom(lift)).toBe("calc(var(--drawer-foot-h) + 16px)");
    expect(lift.replace(/bottom:[^;]+;?/, "").trim(), "it changes the bottom and nothing else").toBe("");
    // Not inside a media query, and no narrow rule that sets `bottom` again: the narrow full-width drawer gets the same lift.
    expect(drawer.filter((r) => r.selector.includes(".toast-stack") && r.at.length > 1)).toEqual([]);
    const narrowStack = toasts.filter((r) => r.selector === ".toast-stack" && r.at.length > 1);
    for (const r of narrowStack) expect(r.body, "a narrow toast rule would beat the lift").not.toMatch(/bottom:/);
  });

  it("a drawer without a footer has nothing to clear: the stack stays at its own 16px (the override is the more specific rule)", () => {
    const none = rule("body:has(.drawer):not(:has(.drawer-foot)) .toast-stack");
    expect(bottom(none)).toBe("16px");
    expect(css.indexOf("body:has(.drawer):not(:has(.drawer-foot)) .toast-stack")).toBeGreaterThan(css.indexOf("body:has(.drawer) .toast-stack"));
  });

  it("the toasts stay above the drawer (900 over 800)", () => {
    expect(zOf(toasts, ".toast-stack")).toBeGreaterThan(z(rule(".drawer-backdrop")));
  });
});

describe("the panel's colours, in every look", () => {
  /** The tokens an element gets under <html data-mode data-theme> (the same walk as the other feedback style tests). */
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

  it.each(combos)("$id, $mode: the title and text (--text) and the close cross (--text-2) read on the panel (--bg) at 4.5:1", ({ id, mode }) => {
    const map = cascade(id, mode);
    expect(contrast(map.get("text")!, map.get("bg")!)).toBeGreaterThanOrEqual(AA);
    expect(contrast(map.get("text-2")!, map.get("bg")!)).toBeGreaterThanOrEqual(AA);
  });
});

describe("main.tsx", () => {
  it("imports the drawer's stylesheet after app.css (its layer is declared there)", () => {
    const main = readFileSync("src/main.tsx", "utf8");
    expect(main).toContain('import "./styles/drawer.css";');
    expect(main.indexOf('import "./styles/drawer.css"')).toBeGreaterThan(main.indexOf('import "./app.css"'));
  });
});
