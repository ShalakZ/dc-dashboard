import { readFileSync } from "node:fs";
import { THEMES } from "../lib/appearance";
import { NON_TEXT, contrast, customProperties, parseRules, stripComments } from "../test/cssTools";

// vitest runs from the frontend directory and reads the stylesheets as text (css: false).
const text = stripComments(readFileSync("src/styles/graph-nodes.css", "utf8"));
const rules = parseRules(text);
const app = parseRules(stripComments(readFileSync("src/app.css", "utf8")));
const themes = parseRules(stripComments(readFileSync("src/themes.css", "utf8")));
const base = customProperties(app.filter((r) => r.selector === ":root")[0].body);

const rule = (selector: string, at = "@layer w6") => {
  const found = rules.filter((r) => r.selector === selector && r.at.join(" > ") === at);
  expect(found, `exactly one rule for "${selector}" in ${at}`).toHaveLength(1);
  return found[0].body;
};
const themeRule = (selector: string) => customProperties(themes.filter((r) => r.selector === selector)[0].body);

/** The tokens an element gets under <html data-mode data-theme>: the base, the preset, the dark block (dark only), then the look's own block (as themes.css.test.ts). */
function cascade(id: string, mode: "light" | "dark") {
  const map = new Map(base);
  const layers = [`:root[data-theme="${id}"]`, ...(mode === "dark" ? [':root[data-mode="dark"]'] : []), `:root[data-theme="${id}"][data-mode="${mode}"]`];
  for (const selector of layers) for (const [name, value] of themeRule(selector)) map.set(name, value);
  return map;
}

describe("the Discovery node styles (W7u)", () => {
  it("is one @layer w6 block with nothing outside it, no raw colour, and only selectors that name a class", () => {
    expect(text.match(/@layer/g) ?? []).toHaveLength(1);
    expect(text.slice(0, text.search(/@layer\s+w6\s*\{/)).trim()).toBe("");
    expect(text.trim().endsWith("}")).toBe(true);
    for (const r of rules) {
      expect(r.body, `colour in "${r.selector}"`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
      if (!r.at.some((a) => a.startsWith("@keyframes"))) expect(r.selector, "a selector names a class").toMatch(/\./);
    }
  });

  it("never writes .graph-canvas or .graph-page on its own (the clash guard of app.css.test.ts): graph-tools.css owns both, and a class bare here and named there fails that guard", () => {
    // The part of a selector before its first combinator, per comma-separated part (nothing here has a comma or a space inside a :not()/:is()).
    const first = (selector: string) => selector.split(",").map((part) => part.trim().split(/[\s>+~]/)[0]);
    for (const r of rules.filter((x) => !x.at.some((a) => a.startsWith("@keyframes")))) {
      for (const compound of first(r.selector)) {
        expect(compound, `"${r.selector}" starts with a bare .graph-canvas`).not.toMatch(/^\.graph-canvas(?::{1,2}[\w-]+(?:\([^)]*\))?|\[[^\]]*\])*$/);
      }
    }
    expect(rules.filter((r) => /graph-page/.test(r.selector)).map((r) => r.selector)).toEqual([]);
    // ...and it does name .graph-canvas, so the path highlight stays inside the Discovery canvas
    expect(rules.some((r) => /graph-canvas/.test(r.selector))).toBe(true);
  });

  it("the four dot colours are the status tokens, and the online dot alone pulses", () => {
    expect(rule(".gdot-online")).toMatch(/background:\s*var\(--ok\)/);
    expect(rule(".gdot-offline")).toMatch(/background:\s*var\(--crit\)/);
    expect(rule(".gdot-credentials")).toMatch(/background:\s*var\(--warn\)/);
    expect(rule(".gdot-idle")).toMatch(/background:\s*var\(--text-2\)/);
    expect(rules.filter((r) => /animation\s*:\s*gdot-pulse/.test(r.body)).map((r) => r.selector)).toEqual([".gdot-online"]);
  });

  it("the dot is 8px and round; the pulse moves opacity only (nothing to repaint beyond 8px)", () => {
    const dot = rule(".gdot");
    expect(dot).toMatch(/width:\s*8px/);
    expect(dot).toMatch(/height:\s*8px/);
    expect(dot).toMatch(/border-radius:\s*50%/);
    const frames = rules.filter((r) => r.at.includes("@keyframes gdot-pulse"));
    expect(frames.map((r) => r.selector)).toEqual(["0%", "50%", "100%"]);
    for (const f of frames) expect(f.body.replace(/opacity:\s*[\d.]+;/, "").trim(), `"${f.selector}" sets opacity and nothing else`).toBe("");
  });

  it("the protocol badge is a plain rectangle: a 1px border, the small radius, never a pill", () => {
    const badge = rule(".gproto");
    expect(badge).toMatch(/border:\s*1px solid var\(--border-strong\)/);
    expect(badge).toMatch(/border-radius:\s*var\(--radius-sm\)/);
    expect(badge).not.toMatch(/border-radius:\s*(9999|999|50%|[1-9]\d{2,})/);
    expect(badge).not.toMatch(/font-family|monospace|italic/);
  });

  it("the progress strip is 3px, absolutely placed on the bottom edge of a positioned host, so it adds no height", () => {
    const strip = rule(".gprogress");
    expect(strip).toMatch(/position:\s*absolute/);
    expect(strip).toMatch(/bottom:\s*0/);
    expect(strip).toMatch(/left:\s*0/);
    expect(strip).toMatch(/height:\s*3px/);
    expect(strip).toMatch(/background:\s*var\(--accent\)/);
    expect(rule(".gprogress-host")).toMatch(/position:\s*relative/);
  });

  it("a lit path leaves the nodes and edges that are on it alone and dims the rest, the edges more", () => {
    expect(rule(".graph-canvas.has-focus .react-flow__node:not(.lit)")).toMatch(/opacity:\s*0\.35/);
    expect(rule(".graph-canvas.has-focus .react-flow__edge:not(.lit)")).toMatch(/opacity:\s*0\.25/);
    expect(rule(".graph-canvas.has-focus .react-flow__edge.lit")).toMatch(/--xy-edge-stroke:\s*var\(--accent\)/);
  });

  it("the dimming is immediate: no opacity transition on the nodes and edges (a fade over 2,280 layers made every hover 5-6 slow frames; whole-wave review, finding 1)", () => {
    expect(rules.filter((r) => /transition/.test(r.body))).toEqual([]);
    expect(rule(".graph-canvas.has-focus .react-flow__node:not(.lit)")).toMatch(/opacity:\s*0\.35/); // the dimming itself stays
  });

  it("the found node gets a 2px accent outline and a short pulse", () => {
    const flash = rule(".react-flow__node.flash");
    expect(flash).toMatch(/outline:\s*2px solid var\(--accent\) !important/); // the library says outline: none on a focused node, in its unlayered sheet
    expect(flash).toMatch(/animation:\s*gnode-flash [\d.]+s ease-in-out 2\b/);
  });

  describe("reduced motion", () => {
    const calm = (selector: string) => rule(selector, "@layer w6 > @media (prefers-reduced-motion: reduce)");

    it("every animation of the file has an off switch of its own (the global rule removes transitions only)", () => {
      const animated = rules
        .filter((r) => /animation\s*:\s*(?!none)/.test(r.body) && !r.at.some((a) => a.includes("prefers-reduced-motion")))
        .map((r) => r.selector);
      expect(animated.sort()).toEqual([".gdot-online", ".react-flow__node.flash"]);
      expect(calm(".gdot-online")).toMatch(/animation:\s*none/);
      expect(calm(".react-flow__node.flash")).toMatch(/animation:\s*none/);
    });

    it("the library's flowing dashes (its own sheet is unlayered) are stopped with !important", () => {
      expect(calm(".react-flow__edge.animated path")).toMatch(/animation:\s*none\s*!important/);
    });

    it("the flash keeps its outline, so Find still shows where it went", () => {
      expect(calm(".react-flow__node.flash")).not.toMatch(/outline/);
    });
  });

  // The dot is a mark, not text: WCAG 1.4.11 asks 3:1 against what it sits on. The source node is on --bg; an unidentified service (no dot) on --surface, but the surface is checked too.
  describe.each(THEMES.flatMap((t) => (["light", "dark"] as const).map((mode) => ({ id: t.id, mode }))))("$id, $mode", ({ id, mode }) => {
    const tokens = cascade(id, mode);
    const tok = (name: string) => {
      const value = tokens.get(name);
      expect(value, `--${name}`).toMatch(/^#[0-9a-fA-F]{6}$/);
      return value!;
    };
    it.each([["ok"], ["crit"], ["warn"], ["text-2"]])("the dot token --%s reads at 3:1 on --bg and on --surface", (name) => {
      for (const ground of ["bg", "surface"]) {
        expect(contrast(tok(name), tok(ground)), `--${name} on --${ground}`).toBeGreaterThanOrEqual(NON_TEXT);
      }
    });
    it("the progress strip (--accent) reads at 3:1 on --bg and on --surface", () => {
      for (const ground of ["bg", "surface"]) expect(contrast(tok("accent"), tok(ground)), `--accent on --${ground}`).toBeGreaterThanOrEqual(NON_TEXT);
    });
  });
});
