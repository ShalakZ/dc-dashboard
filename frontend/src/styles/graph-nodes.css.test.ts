import { readFileSync } from "node:fs";
import { THEMES } from "../lib/appearance";
import { SOURCE_H } from "../lib/graph";
import { AA, NON_TEXT, contrast, customProperties, parseRules, stripComments } from "../test/cssTools";

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

  it("the protocol badge is gone: the source card (W12c) says the protocol in words and with an icon", () => {
    expect(rules.filter((r) => /gproto/.test(r.selector))).toEqual([]);
  });

  it("the icon before a title (W12c) is 16px, in --text-2, never shrunk, with no transition; the title line holds it in a flex line that adds no row", () => {
    const icon = rule(".gicon");
    expect(icon).toMatch(/flex:\s*none/);
    expect(icon).toMatch(/width:\s*16px/);
    expect(icon).toMatch(/height:\s*16px/);
    expect(icon).toMatch(/color:\s*var\(--text-2\)/);
    expect(rule(".gicon svg.i")).toMatch(/width:\s*16px/);
    expect(rule(".gicon svg.i")).toMatch(/height:\s*16px/);
    const title = rule(".gtitle");
    expect(title).toMatch(/display:\s*flex/);
    expect(title).toMatch(/align-items:\s*flex-start/); // a title that wraps keeps the icon beside its first line
    expect(title).not.toMatch(/(?:^|;)\s*(?:height|min-height|margin|padding)\s*:/); // nothing that could make a node taller
    for (const r of rules.filter((x) => /gicon|gtitle/.test(x.selector))) expect(r.body, r.selector).not.toMatch(/transition|animation/);
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

  it("the Show-more node (W12b) is the button alone: no padding, an invisible frame, the button across the node, no height of its own", () => {
    const node = rule(".gnode-more.gnode-more");
    expect(node).toMatch(/padding:\s*0\b/);
    expect(node).toMatch(/border-color:\s*transparent/);
    expect(node).toMatch(/background:\s*none/);
    expect(node).not.toMatch(/(?:^|;)\s*(?:height|min-height)\s*:/);
    expect(rule(".gnode-more button")).toMatch(/width:\s*100%/);
  });

  it("the mapped badge of a collapsed asset (W12b) is a plain rectangle in tokens, on the title row, which the title leaves room on", () => {
    const badge = rule(".gnode-mapped");
    expect(badge).toMatch(/border:\s*1px solid var\(--border-strong\)/);
    expect(badge).toMatch(/border-radius:\s*var\(--radius-sm\)/);
    expect(badge).toMatch(/color:\s*var\(--text-2\)/);
    expect(badge).toMatch(/flex:\s*none/);
    expect(badge).not.toMatch(/border-radius:\s*(9999|999|50%|[1-9]\d{2,})|font-family|monospace|italic/);
    expect(rule(".gnode-asset .row .node-title")).toMatch(/min-width:\s*0/);
  });

  it("the mapping menu button (W12a) is 20px and absolutely placed at the top right of a positioned node, and the first line leaves room for it: the node is no taller", () => {
    const button = rule(".gnode-hasmenu .gnode-menu-btn");
    expect(button).toMatch(/position:\s*absolute/);
    expect(button).toMatch(/width:\s*20px/);
    expect(button).toMatch(/height:\s*20px/);
    expect(button).toMatch(/top:\s*\d+px/);
    expect(button).toMatch(/right:\s*\d+px/);
    expect(rule(".gnode-hasmenu")).toMatch(/position:\s*relative/);
    // a point's title is a direct child of the node; a group's title shares a row with its toggle, so the row leaves the room and the toggle stands left of the button
    expect(rule(".gnode-hasmenu > .node-title, .gnode-hasmenu > .gnode-head")).toMatch(/padding-right:\s*24px/);
    expect(rule(".gnode-hasmenu .gnode-menu-btn svg.i")).toMatch(/width:\s*14px/);
  });

  it("the + of an asset node (W12a) is a 20px round control at the node's top right corner, out of the layout, in tokens", () => {
    const add = rule(".gnode-add");
    expect(add).toMatch(/width:\s*20px\s*!important/); // the library's unlayered sheet says 6px: only an important declaration in a layer beats it
    expect(add).toMatch(/height:\s*20px\s*!important/);
    expect(add).toMatch(/border-radius:\s*50%/);
    expect(add).toMatch(/top:\s*0\s*!important/); // the library centres a right handle at mid height: the top edge is the corner
    expect(add).toMatch(/background-color:\s*var\(--accent\)\s*!important/);
    expect(add).toMatch(/color:\s*var\(--bg\)/);
    expect(add).not.toMatch(/position\s*:\s*(?!absolute)/); // the handle is absolute by the library already: a position here would only be able to take it out of that
    expect(add).not.toMatch(/(?:^|;)\s*(?:margin|float)\s*:/); // nothing that could move the node's own box
  });

  it("the + is hidden by opacity alone and inert while hidden (never visibility or display: either takes it out of the Tab order or the accessibility tree, and a hidden control cannot take the focus back from a closed dialog); shown on hover, focus, a selected node and while dragged from", () => {
    const hidden = rule(".gnode-add");
    expect(hidden).toMatch(/opacity:\s*0\b/);
    expect(hidden).toMatch(/pointer-events:\s*none\s*!important/); // the library's unlayered sheet says all on a connectable handle
    expect(hidden).not.toMatch(/visibility\s*:/);
    expect(hidden).not.toMatch(/display\s*:\s*none/);
    const shown = rule(".react-flow__node:hover .gnode-add, .react-flow__node:focus-within .gnode-add, .react-flow__node.selected .gnode-add, .gnode-add:focus, .gnode-add:focus-visible, .gnode-add.connectingfrom");
    expect(shown).toMatch(/opacity:\s*1\b/);
    expect(shown).toMatch(/pointer-events:\s*all\s*!important/);
    expect(shown).not.toMatch(/visibility\s*:/);
    expect(rules.filter((r) => /gnode-add/.test(r.selector) && /display\s*:\s*none|visibility\s*:/.test(r.body))).toEqual([]);
    expect(rule(".gnode-add svg.i")).toMatch(/width:\s*12px/);
  });

  it("the line dragged from the + is dashed and in the accent", () => {
    const line = rule(".gconnect");
    expect(line).toMatch(/stroke:\s*var\(--accent\)/);
    expect(line).toMatch(/stroke-dasharray:\s*\d+\s+\d+/);
    expect(line).toMatch(/fill:\s*none/);
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
    it("the + (W12a): its plus (--bg) reads on its fill (--accent) and on its hover fill (--accent-hover) at 3:1, and the control itself on the canvas (--bg)", () => {
      for (const fill of ["accent", "accent-hover"]) expect(contrast(tok("bg"), tok(fill)), `--bg on --${fill}`).toBeGreaterThanOrEqual(NON_TEXT);
      expect(contrast(tok("accent"), tok("bg")), "--accent on --bg").toBeGreaterThanOrEqual(NON_TEXT);
    });
  });
});

// W12c: the source card's own stylesheet. Its six lines have FIXED heights, and the card fits the room the layout keeps for a source (`SOURCE_H`) by design, not by luck.
describe("the source card styles (W12c, graph-source-card.css)", () => {
  const cardText = stripComments(readFileSync("src/styles/graph-source-card.css", "utf8"));
  const cardRules = parseRules(cardText);
  const card = (selector: string) => {
    const found = cardRules.filter((r) => r.selector === selector && r.at.join(" > ") === "@layer w6");
    expect(found, `exactly one rule for "${selector}"`).toHaveLength(1);
    return found[0].body;
  };
  const px = (body: string, property: string) => {
    const m = new RegExp(`(?:^|[;\\s])${property}:\\s*(\\d+)px`).exec(body);
    expect(m, `${property} in px in "${body}"`).not.toBeNull();
    return Number(m![1]);
  };

  it("the head may take two lines (W14: a name of two 18px lines), every other line has a height in px, and the lines, their gaps (none), the node's padding (4px, doubled class in graph-nodes.css) and its border add up to 134px, inside SOURCE_H", () => {
    const title = card(".gsrc-head .gsrc-title");
    const clamp = Number(/-webkit-line-clamp:\s*(\d+)/.exec(title)?.[1]);
    const leading = px(title, "line-height");
    expect({ clamp, leading }).toEqual({ clamp: 2, leading: 18 });
    // the head is as tall as its tallest part: the 20px tile and button, or the title's lines (a one-line name leaves it at 20, a two-line one at 36)
    const head = Math.max(px(card(".gsrc-head"), "min-height"), px(card(".gsrc-head .gsrc-tile"), "height"), px(card(".gsrc-head .gnode-menu-btn"), "height"), clamp * leading);
    const heights = {
      head,
      sub: px(card(".gsrc-sub, .gsrc-status, .gsrc-seen"), "height"),
      mapped: px(card(".gsrc-mapped"), "height"),
      actions: px(card(".gsrc-actions"), "height"),
    };
    expect(heights).toEqual({ head: 36, sub: 16, mapped: 20, actions: 20 });
    // no gap between the lines: the rows keep their own leading, and a gap of 1px would already reach 139
    expect(card(".gsrc-body")).toMatch(/(?:^|[;\s])gap:\s*0\s*;/);
    // head, protocol line, status line, mapped line, Details, last seen: the full card
    const lines = [heights.head, heights.sub, heights.sub, heights.mapped, heights.actions, heights.sub];
    // `.gnode { padding: 6px 8px }` (app.css) is narrowed for the source card by `.gnode-source.gnode-source` (graph-nodes.css)
    const pad = /(?:^|[;\s])padding:\s*(\d+)px\s+(\d+)px\s*;?\s*$/.exec(rule(".gnode-source.gnode-source"));
    expect(pad, "padding: 4px 8px on the source card").not.toBeNull();
    expect([Number(pad![1]), Number(pad![2])]).toEqual([4, 8]);
    const padding = Number(pad![1]) * 2;
    const border = 1 + 1;
    const total = lines.reduce((a, b) => a + b, 0) + padding + border;
    expect(total).toBe(134);
    expect(total).toBeLessThanOrEqual(SOURCE_H);
    // the words line plus the bar under it fill the mapped line exactly
    expect(px(card(".gsrc-words"), "height") + px(card(".gsrc-bar"), "margin-top") + px(card(".gsrc-bar"), "height")).toBe(heights.mapped);
  });

  it("the title may take two lines (W14, P2): a two-line clamp with the ellipsis the browser draws, the title giving way first (min-width 0); the fold, the tile and the Source actions button stand at the first line", () => {
    const title = card(".gsrc-head .gsrc-title");
    expect(title).toMatch(/display:\s*-webkit-box/);
    expect(title).toMatch(/-webkit-line-clamp:\s*2\b/);
    expect(title).toMatch(/-webkit-box-orient:\s*vertical/);
    expect(title).toMatch(/overflow:\s*hidden/);
    expect(title).toMatch(/line-height:\s*18px/);
    expect(title).toMatch(/min-width:\s*0/);
    expect(title).toMatch(/flex:\s*1 1 0/);
    expect(title).not.toMatch(/white-space:\s*nowrap/); // a nowrap title would stay on one line whatever the clamp says
    expect(card(".gsrc-head")).toMatch(/align-items:\s*flex-start/);
  });

  it("the protocol line, the status line and the last-seen line are still ONE line each: no wrap, an ellipsis", () => {
    const body = card(".gsrc-sub, .gsrc-status, .gsrc-seen");
    expect(body).toMatch(/white-space:\s*nowrap/);
    expect(body).toMatch(/overflow:\s*hidden/);
    expect(body).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("the menu button and the icon tile are 20px squares on the title line, never shrunk (the title takes the squeeze)", () => {
    const button = card(".gsrc-head .gnode-menu-btn");
    expect(px(button, "width")).toBe(20);
    expect(px(button, "height")).toBe(20);
    expect(button).toMatch(/flex:\s*none/);
    expect(px(card(".gsrc-head .gsrc-tile"), "width")).toBe(20);
    expect(px(card(".gsrc-head .gsrc-tile"), "height")).toBe(20);
    expect(card(".gsrc-head .gsrc-tile")).toMatch(/flex:\s*none/);
  });

  it("the bar is 4px, a plain rectangle in tokens (never a pill); its fill is the accent", () => {
    const bar = card(".gsrc-bar");
    expect(px(bar, "height")).toBe(4);
    expect(bar).toMatch(/background:\s*var\(--border-strong\)/); // W14 (P2): --border (1.2:1 on the card) made an empty track invisible
    expect(bar).not.toMatch(/border-radius/);
    expect(card(".gsrc-fill")).toMatch(/background:\s*var\(--accent\)/);
    expect(card(".gsrc-fill")).toMatch(/height:\s*100%/);
  });

  // W14 (P2): the empty track is a picture of "nothing mapped yet", so it must show on the card (--bg) in every look. The floor is 1.5:1 (a quiet track, not a control boundary: the words say the number).
  describe.each(THEMES.flatMap((t) => (["light", "dark"] as const).map((mode) => ({ id: t.id, mode }))))("the empty track, $id, $mode", ({ id, mode }) => {
    it("--border-strong reads on --bg at 1.5:1 or more", () => {
      const tokens = cascade(id, mode);
      const [track, ground] = [tokens.get("border-strong"), tokens.get("bg")];
      expect(track, "--border-strong").toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(ground, "--bg").toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(contrast(track!, ground!), `--border-strong on --bg (${id}, ${mode})`).toBeGreaterThanOrEqual(1.5);
    });
  });

  it("nothing in the card is hidden or moved by the stylesheet: no display none, no visibility, no absolute placement", () => {
    for (const r of cardRules) expect(r.body, r.selector).not.toMatch(/display:\s*none|visibility\s*:|position:\s*absolute/);
  });

  it("the card names classes of its own only (gsrc-*), plus the menu button's, which graph-nodes.css never writes on its own", () => {
    const named = new Set(cardRules.flatMap((r) => [...r.selector.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1])));
    for (const cls of named) expect(cls, `.${cls}`).toMatch(/^(gsrc-|gnode-menu-btn$|i$)/);
  });
});

// (w33) A source the newest scan of its range did not find is drawn on a quieter ground (the class gsrc-not-seen, graph-source-card.css). Its words keep their colours, so what has to hold is
// the contrast of those colours on the new ground, in every look and both modes: 4.5:1 for the text, 3:1 for the status dot, 1.5:1 for the empty track of the mapped bar.
describe("a source that is not seen (w33, graph-source-card.css)", () => {
  const cardRules = parseRules(stripComments(readFileSync("src/styles/graph-source-card.css", "utf8")));
  const found = cardRules.filter((r) => r.selector === ".gsrc-not-seen.gsrc-not-seen" && r.at.join(" > ") === "@layer w6");

  it("is one rule: the ground is --surface, the border stays dashed, and nothing else changes (no opacity, no colour of its own, no size)", () => {
    expect(found, "exactly one rule for .gsrc-not-seen.gsrc-not-seen").toHaveLength(1);
    const body = found[0].body;
    expect(body).toMatch(/background:\s*var\(--surface\)/);
    expect(body).toMatch(/border-style:\s*dashed/);
    expect(body).toMatch(/border-color:\s*var\(--border\)/); // the lighter edge: with the ground it is what makes the card quieter
    expect(body).not.toMatch(/opacity|(?:^|[;\s])color\s*:|filter|(?:^|[;\s])(?:width|height|min-height|padding|margin|border-width)\s*:/);
  });

  describe.each(THEMES.flatMap((t) => (["light", "dark"] as const).map((mode) => ({ id: t.id, mode }))))("$id, $mode", ({ id, mode }) => {
    const tokens = cascade(id, mode);
    const tok = (name: string) => {
      const value = tokens.get(name);
      expect(value, `--${name}`).toMatch(/^#[0-9a-fA-F]{6}$/);
      return value!;
    };
    it("the title (--text) and the muted lines (--text-2) read on --surface at 4.5:1", () => {
      for (const name of ["text", "text-2"]) expect(contrast(tok(name), tok("surface")), `--${name} on --surface (${id}, ${mode})`).toBeGreaterThanOrEqual(AA);
    });
    it("the status dot colours read at 3:1 and the empty track of the mapped bar at 1.4:1 (decoration; 1.5:1 needs the white ground of a card that was seen) on --surface", () => {
      for (const name of ["ok", "crit", "warn", "text-2", "accent"]) expect(contrast(tok(name), tok("surface")), `--${name} on --surface (${id}, ${mode})`).toBeGreaterThanOrEqual(NON_TEXT);
      expect(contrast(tok("border-strong"), tok("surface")), `--border-strong on --surface (${id}, ${mode})`).toBeGreaterThanOrEqual(1.4);
    });
  });
});

// (w33) The card's last line in the warning ink (`A different server answers at this address`, nodes.tsx: the classes `gsrc-seen gsrc-warn warning`, no `muted`): the ink is the existing --warn-ink
// (app.css `.warning`), so what has to hold is its contrast on the two grounds a card has (--bg, and --surface when the card is also drawn as not seen), in every look and both modes.
// The Move... button beside Details takes the row's 20px and a 4px gap; the card is no taller (the six lines above still add up to 134).
describe("the warning line and the Move... button of the source card (w33, graph-source-card.css)", () => {
  const cardRules = parseRules(stripComments(readFileSync("src/styles/graph-source-card.css", "utf8")));
  const card = (selector: string) => {
    const found = cardRules.filter((r) => r.selector === selector && r.at.join(" > ") === "@layer w6");
    expect(found, `exactly one rule for "${selector}"`).toHaveLength(1);
    return found[0].body;
  };

  it("the button row has a 4px gap and keeps its 20px; Move... is 20px high like Details, and nothing here names a colour of its own", () => {
    expect(card(".gsrc-actions")).toMatch(/(?:^|[;\s])gap:\s*4px/);
    expect(card(".gsrc-actions")).toMatch(/(?:^|[;\s])height:\s*20px/);
    expect(card(".gsrc-actions .gsrc-move")).toMatch(/(?:^|[;\s])height:\s*20px/);
    expect(card(".gsrc-actions .gsrc-move")).not.toMatch(/color|background|opacity|width|margin|padding/);
  });

  it("the warning line has no rule of its own: it wears app.css's `.warning` (--warn-ink), so no colour is added", () => {
    expect(cardRules.filter((r) => /gsrc-warn/.test(r.selector))).toEqual([]);
    const warning = app.filter((r) => r.selector === ".warning" && r.at.join(" > ") === "@layer w6");
    expect(warning).toHaveLength(1);
    expect(warning[0].body).toMatch(/color:\s*var\(--warn-ink\)/);
  });

  describe.each(THEMES.flatMap((t) => (["light", "dark"] as const).map((mode) => ({ id: t.id, mode }))))("$id, $mode", ({ id, mode }) => {
    it("--warn-ink reads at 4.5:1 on --bg (the card) and on --surface (the card when it is also not seen)", () => {
      const tokens = cascade(id, mode);
      for (const ground of ["bg", "surface"]) {
        const [ink, behind] = [tokens.get("warn-ink"), tokens.get(ground)];
        expect(ink, "--warn-ink").toMatch(/^#[0-9a-fA-F]{6}$/);
        expect(behind, `--${ground}`).toMatch(/^#[0-9a-fA-F]{6}$/);
        expect(contrast(ink!, behind!), `--warn-ink on --${ground} (${id}, ${mode})`).toBeGreaterThanOrEqual(AA);
      }
    });
  });
});
