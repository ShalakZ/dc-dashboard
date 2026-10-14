import { readFileSync } from "node:fs";
import { THEMES } from "../lib/appearance";
import { AA, contrast, customProperties, parseRules, stripComments } from "../test/cssTools";

// vitest runs from the frontend directory and reads the stylesheets as text (css: false).
const app = stripComments(readFileSync("src/app.css", "utf8"));
const themes = stripComments(readFileSync("src/themes.css", "utf8"));
const toastCss = stripComments(readFileSync("src/styles/feedback-toasts.css", "utf8"));
const appRules = parseRules(app);
const themeRules = parseRules(themes);
const toastRules = parseRules(toastCss);
const base = customProperties(appRules.filter((r) => r.selector === ":root")[0].body);
const HEX = /^#[0-9a-fA-F]{6}$/;

const only = (list: ReturnType<typeof parseRules>, selector: string) => {
  const found = list.filter((r) => r.selector === selector);
  expect(found, `exactly one rule for "${selector}"`).toHaveLength(1);
  return found[0];
};

/** The tokens an element gets under <html data-mode data-theme>: the base, the preset, the dark block (dark only), then the look's accent (as themes.css.test.ts does). */
function cascade(themeId: string, mode: "light" | "dark") {
  const map = new Map(base);
  for (const [name, value] of customProperties(only(themeRules, `:root[data-theme="${themeId}"]`).body)) map.set(name, value);
  if (mode === "dark") for (const [name, value] of customProperties(only(themeRules, ':root[data-mode="dark"]').body)) map.set(name, value);
  for (const [name, value] of customProperties(only(themeRules, `:root[data-theme="${themeId}"][data-mode="${mode}"]`).body)) map.set(name, value);
  return map;
}

const combos = THEMES.flatMap((t) => (["light", "dark"] as const).map((mode) => ({ id: t.id, mode })));

describe("the toast's colours, in every look", () => {
  it("covers all eight looks", () => {
    expect(combos).toHaveLength(8);
  });

  describe.each(combos)("$id, $mode", ({ id, mode }) => {
    const map = cascade(id, mode);
    const tok = (name: string) => {
      const value = map.get(name);
      expect(value, `--${name}`).toMatch(HEX);
      return value!;
    };
    // The icons are marks, not text, but they carry the kind; they are held to the text ratio so a pale one is caught.
    const pairs: Array<[string, string, string]> = [
      ["the success icon (--ok) on the card (--bg)", "ok", "bg"],
      ["the info icon (--info) on the card", "info", "bg"],
      ["the error icon (--crit) on the card", "crit", "bg"],
      ["the message (--text) on the card", "text", "bg"],
      ["the close cross (--text-2) on the card", "text-2", "bg"],
      ["the count badge (--text-2) on its ground (--surface)", "text-2", "surface"],
      ["the action label (--accent-ink) on the card (W7p)", "accent-ink", "bg"],
      ["the action label (--accent-ink) on its hover ground (--accent-tint)", "accent-ink", "accent-tint"],
    ];
    it.each(pairs)("%s reads at 4.5:1", (_name, fg, bg) => {
      expect(contrast(tok(fg), tok(bg))).toBeGreaterThanOrEqual(AA);
    });
  });
});

describe("the toast's stylesheet", () => {
  // The plain rule of a selector: directly in the layer, not inside @media or @starting-style.
  const rule = (selector: string) => only(toastRules.filter((r) => r.at.length === 1), selector).body;

  it("uses tokens only: no raw colour, and every var(--x) is a token of app.css", () => {
    for (const r of toastRules) expect(r.body, `colour in "${r.selector}"`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    const used = new Set([...toastCss.matchAll(/var\(--([\w-]+)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(0);
    for (const name of used) expect(base.has(name), `--${name} is defined in :root`).toBe(true);
  });

  it("paints the pairs measured above: the kind's colour on the icon, --text on a --bg card, the close cross from .icon-btn (--text-2)", () => {
    expect(rule('.toast[data-kind="success"] .toast-icon')).toMatch(/color:\s*var\(--ok\)/);
    expect(rule('.toast[data-kind="info"] .toast-icon')).toMatch(/color:\s*var\(--info\)/);
    expect(rule('.toast[data-kind="error"] .toast-icon')).toMatch(/color:\s*var\(--crit\)/);
    expect(rule(".toast")).toMatch(/background:\s*var\(--bg\)/);
    expect(rule(".toast")).toMatch(/color:\s*var\(--text\)/);
    expect(rule(".toast")).toMatch(/border:\s*1px solid var\(--border-strong\)/);
    expect(rule(".toast")).toMatch(/box-shadow:\s*var\(--shadow-pop\)/);
    expect(rule(".toast-count")).toMatch(/background:\s*var\(--surface\)/);
    expect(rule(".toast-count")).toMatch(/color:\s*var\(--text-2\)/);
    expect(only(appRules, ".icon-btn").body).toMatch(/color:\s*var\(--text-2\)/); // the close button is an .icon-btn
    expect(rule(".toast-close"), "the close button keeps the .icon-btn colour").not.toMatch(/\bcolor:/);
  });

  it("styles the action button (W7p) with tokens: the accent ink on the card, the accent tint on hover, no pill, and the text keeps its room", () => {
    const action = rule(".toast-action");
    expect(action).toMatch(/color:\s*var\(--accent-ink\)/);
    expect(action).toMatch(/background:\s*var\(--bg\)/);
    expect(action).toMatch(/flex:\s*none/);
    expect(action).toMatch(/max-width:\s*45%/);
    expect(action).toMatch(/min-height:\s*28px/); // as tall as the close button beside it, so the row does not grow
    expect(action, "not a pill").not.toMatch(/border-radius/);
    expect(rule(".toast-action:hover:not(:disabled)")).toMatch(/background:\s*var\(--accent-tint\)/);
  });

  it("sits bottom right at 900: above the pop-ups (90) and below the dialogs (1000), and takes no click itself", () => {
    const stack = rule(".toast-stack");
    expect(stack).toMatch(/position:\s*fixed/);
    expect(stack).toMatch(/right:\s*16px/);
    expect(stack).toMatch(/bottom:\s*16px/);
    expect(stack).toMatch(/width:\s*min\(360px,\s*calc\(100vw - 32px\)\)/);
    expect(stack).toMatch(/pointer-events:\s*none/);
    expect(rule(".toast")).toMatch(/pointer-events:\s*auto/);
    const z = (body: string) => Number(/z-index:\s*(\d+)/.exec(body)?.[1]);
    expect(z(stack)).toBe(900);
    expect(z(stack)).toBeGreaterThan(z(only(appRules, ".row-menu-panel").body));
    expect(z(stack)).toBeGreaterThan(z(only(appRules, ".prof-menu").body));
    expect(z(stack)).toBeLessThan(z(only(appRules, ".dialog-backdrop").body));
  });

  it("stacks upward from the corner (oldest first in the column, bottom anchored), and takes the full width below 720px", () => {
    expect(rule(".toast-stack")).toMatch(/flex-direction:\s*column\b(?!-reverse)/);
    expect(rule(".toast-stack")).toMatch(/justify-content:\s*flex-end/);
    const narrow = toastRules.filter((r) => r.selector === ".toast-stack" && r.at.some((a) => /max-width:\s*719\.98px/.test(a)));
    expect(narrow).toHaveLength(1);
    expect(narrow[0].body).toMatch(/left:\s*16px/);
    expect(narrow[0].body).toMatch(/width:\s*auto/);
  });

  it("fades with the 150ms motion token, in and out, and a leaving toast ends up transparent", () => {
    expect(rule(".toast")).toMatch(/transition:\s*opacity var\(--motion\),\s*transform var\(--motion\)/);
    expect(base.get("motion")).toMatch(/^150ms\b/);
    expect(rule('.toast[data-leaving="true"]')).toMatch(/opacity:\s*0/);
    const entry = toastRules.filter((r) => r.selector === ".toast" && r.at.includes("@starting-style"));
    expect(entry).toHaveLength(1);
    expect(entry[0].body).toMatch(/opacity:\s*0/);
  });
});

describe("the room a page leaves under its end for a settled toast (whole-wave review I-3)", () => {
  it("main and the asset detail column keep --toast-clear (96px) under their content, enough for a two-line toast (62px) and its 16px margin", () => {
    expect(parseInt(base.get("toast-clear") ?? "0", 10)).toBeGreaterThanOrEqual(62 + 16);
    for (const selector of ["main", ".assets-detail"]) {
      const found = appRules.filter((r) => r.selector === selector && r.body.includes("padding"));
      expect(found, selector).toHaveLength(1);
      expect(found[0].body, selector).toMatch(/padding:\s*0 var\(--gutter\) var\(--toast-clear\)/);
    }
  });
});

describe("the Discovery graph page keeps its old 48px (re-review m-2: its canvas has no last row for a toast to cover)", () => {
  it("main:has(.graph-page) sets padding-bottom: 48px, which beats the shared --toast-clear of main", () => {
    const found = appRules.filter((r) => r.selector === "main:has(.graph-page)");
    expect(found).toHaveLength(1);
    expect(found[0].body).toMatch(/padding-bottom:\s*48px/);
  });
});
