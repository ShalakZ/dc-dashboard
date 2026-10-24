import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppShellSkeleton } from "./components/AppShellSkeleton";
import { AA, contrast, customProperties, NON_TEXT, parseRules, stripComments, type Rule } from "./test/cssTools";

// vitest is configured with `css: false`, which empties a CSS import, so the stylesheets are read as text.
const css = stripComments(readFileSync("src/app.css", "utf8")); // vitest runs from the frontend directory

const rules = parseRules(css);
const inLayer = (rule: Rule) => rule.at.some((a) => a.startsWith("@layer"));

// The tokens: one `:root` block, so a `var(--name)` has one meaning.
const rootRules = rules.filter((r) => r.selector === ":root");
const tokens = new Map<string, string>(
  [...(rootRules[0]?.body ?? "").matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()] as [string, string]),
);
const resolve = (value: string) => value.replace(/var\(--([\w-]+)\)/g, (_, name: string) => tokens.get(name) ?? `<missing --${name}>`);
const HEX = /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/;

/** The colour of `property` in the one rule whose selector list is exactly `selector`; a `var(--name)` is read from `:root`. */
function declared(selector: string, property: string): string {
  const found = rules.filter((r) => r.selector === selector);
  expect(found, `a rule for "${selector}"`).toHaveLength(1);
  const raw = new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+)`).exec(found[0].body)?.[1];
  expect(raw, `${property} of "${selector}"`).toBeDefined();
  const value = resolve(raw!.trim());
  expect(value, `${property} of "${selector}"`).toMatch(HEX);
  return value;
}

/** A token's colour. */
function tok(name: string): string {
  const value = tokens.get(name);
  expect(value, `--${name} in :root`).toMatch(HEX);
  return value!;
}

describe("contrast of the muted text", () => {
  it("the wording is checked against known ratios", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrast("#999999", "#f4f4f4")).toBeLessThan(AA); // what the billing cell used to be (about 2.6:1)
    expect(contrast("#999999", "#ffffff")).toBeLessThan(AA); // and the dimmed stat figure (about 2.8:1)
  });

  it("a muted Billing cell reads at 4.5:1 on its shaded ground", () => {
    const ink = declared("table.billing td.muted, table.billing td.muted .muted", "color");
    const ground = declared("table.billing td.muted", "background");
    expect(contrast(ink, ground)).toBeGreaterThanOrEqual(AA);
  });

  // w13: the dimmed (stale) figure of a widget is --stale on the card, in every look: styles/widgets.css.test.ts measures it.

  it("the plain muted text does too", () => {
    expect(contrast(declared(".muted", "color"), declared("body", "background"))).toBeGreaterThanOrEqual(AA);
  });
});

describe("navigation and page width", () => {
  it("styles the current page link (nothing marked it visibly before)", () => {
    expect(css).toMatch(/\.side-row\[aria-current="page"\]\s*\{[^}]*font-weight:\s*600/);
  });
  it("hides the skip link until it has focus", () => {
    expect(css).toMatch(/\.skip-link\s*\{[^}]*position:\s*absolute/);
    expect(css).toMatch(/\.skip-link:focus\s*\{/);
  });
  it("lets every page use the whole window: no rule for main sets a max-width, and main.wide is gone", () => {
    const mainRules = rules.filter((r) => /(^|[\s,>+~(])main(?![\w-])/.test(r.selector)); // main as a type, also inside :has(...)
    expect(mainRules.length, "the rules for main").toBeGreaterThan(3);
    for (const rule of mainRules) expect(rule.body, `"${rule.selector}"`).not.toMatch(/max-width/);
    expect(rules.filter((r) => /main\.wide/.test(r.selector))).toEqual([]);
    expect(rules.find((r) => r.selector === "main")?.body).toMatch(/flex:\s*1;\s*min-width:\s*0/);
  });
});

describe("the shell (W6 sidebar)", () => {
  const bodyOf = (selector: string) => rules.find((r) => r.selector === selector)?.body ?? "";

  it("has no bare nav rule left: the old top bar is gone, and a bare nav rule would restyle the sidebar", () => {
    expect(rules.filter((r) => /^nav(?![\w-])/.test(r.selector))).toEqual([]);
    expect(css).not.toMatch(/a\[aria-current="page"\]\s*\{[^}]*border-bottom/);
  });

  it("the rail scrolls in both states: .nav-groups is overflow-y auto and nothing makes it visible", () => {
    expect(bodyOf(".nav-groups")).toMatch(/overflow-y:\s*auto/);
    for (const rule of rules.filter((r) => r.selector.includes(".nav-groups"))) {
      expect(rule.body, `"${rule.selector}"`).not.toMatch(/overflow(-y)?:\s*visible/);
    }
  });

  it("the sidebar sits above the sticky tree column (z-index 40) and the tooltip above the sidebar (50)", () => {
    expect(bodyOf(".side")).toMatch(/z-index:\s*40\b/);
    expect(bodyOf(".side-tip")).toMatch(/z-index:\s*50\b/);
    expect(bodyOf(".side-tip")).toMatch(/position:\s*fixed/);
  });

  it("the sidebar width follows data-sidebar and the page keeps its own scroll bar out of the rail", () => {
    expect(bodyOf(".shell")).toMatch(/--side-w:\s*var\(--side-w-open\)/);
    expect(bodyOf('.shell[data-sidebar="minimized"]')).toMatch(/--side-w:\s*var\(--side-w-closed\)/);
  });

  it("a minimized rail hides its labels with the clip pattern, never display: none or visibility: hidden (a screen reader still reads them)", () => {
    const minimizedLabels = rules.filter((r) => r.selector.includes('[data-sidebar="minimized"]') && /\.(lbl|nav-heading)\b/.test(r.selector));
    expect(minimizedLabels.length, "a minimized rule for .lbl and .nav-heading").toBeGreaterThan(0);
    for (const rule of minimizedLabels) {
      expect(rule.body, `"${rule.selector}"`).not.toMatch(/display:\s*none|visibility:\s*hidden/);
    }
    const clip = minimizedLabels.find((r) => r.selector.includes(".nav-heading") && r.selector.includes(".lbl"));
    expect(clip, "one rule for both").toBeDefined();
    expect(clip!.body).toMatch(/position:\s*absolute/);
    expect(clip!.body).toMatch(/width:\s*1px/);
    expect(clip!.body).toMatch(/height:\s*1px/);
    expect(clip!.body).toMatch(/overflow:\s*hidden/);
    expect(clip!.body).toMatch(/clip:\s*rect\(0 0 0 0\)/);
    // and no other rule at all takes the label out of the accessibility tree
    for (const rule of rules.filter((r) => /\.(lbl|nav-heading)\b/.test(r.selector))) {
      expect(rule.body, `"${rule.selector}"`).not.toMatch(/display:\s*none|visibility:\s*hidden/);
    }
  });

  it("the skip link's focus ring does not stray onto the sidebar (offset 0)", () => {
    expect(bodyOf(".skip-link:focus")).toMatch(/outline-offset:\s*0\b/);
  });

  it("the graph's zoom buttons are dimmed once (by React Flow), not twice (the disabled-button rule)", () => {
    expect(bodyOf(".graph-canvas .react-flow__controls button")).toMatch(/opacity:\s*1\b/);
  });

  it("the graph's React Flow colours (both of its modes) are pointed at page tokens, never at a raw colour", () => {
    const flow = customProperties(bodyOf(".graph-canvas .react-flow"));
    for (const name of [
      "xy-background-color", "xy-edge-stroke", "xy-background-pattern-dots-color", "xy-controls-button-background-color",
      "xy-controls-button-background-color-hover", "xy-controls-button-color", "xy-controls-button-color-hover",
      "xy-controls-button-border-color", "xy-edge-label-background-color", "xy-edge-label-color", "xy-attribution-background-color",
    ]) {
      expect(flow.get(name), `--${name}`).toMatch(/^(?:transparent|var\(--[a-z0-9-]+\))$/);
    }
  });

  it("leaves the attribution link's colour to themes.css: React Flow's stylesheet is unlayered, so a layered rule would lose", () => {
    expect(rules.some((r) => r.selector === ".graph-canvas .react-flow__attribution a")).toBe(false);
  });

  it("every placeholder is --text-disabled at full opacity, in the layer (Chrome's own grey is 3.86:1 on the dark field)", () => {
    const found = rules.filter((r) => r.selector === "::placeholder");
    expect(found, "one rule for ::placeholder").toHaveLength(1);
    expect(inLayer(found[0])).toBe(true);
    expect(found[0].body).toMatch(/color:\s*var\(--text-disabled\)/);
    expect(found[0].body).toMatch(/opacity:\s*1\b/);
  });

  it("the asset page's no-data words are not set as a figure", () => {
    expect(bodyOf(".tile .big.none")).toMatch(/font-weight:\s*400/);
    expect(bodyOf(".tile .big.none")).toMatch(/color:\s*var\(--text-2\)/);
  });

  it("a section title is one rule, in app.css, in the layer, at --fs-lg", () => {
    const titles = rules.filter((r) => r.selector === ".section-title");
    expect(titles).toHaveLength(1);
    expect(inLayer(titles[0])).toBe(true);
    expect(titles[0].body).toMatch(/font-size:\s*var\(--fs-lg\)/);
  });

  it("Discovery is exactly one window tall inside the shell, the bar included, not on #root", () => {
    expect(bodyOf(".shell:has(.graph-page)")).toMatch(/height:\s*100vh/);
    // the shell is a column (bar, then frame); the frame takes what the bar leaves and may shrink, so main (and the canvas) fit in it
    expect(bodyOf(".shell")).toMatch(/display:\s*flex;\s*flex-direction:\s*column/);
    expect(bodyOf(".navbar")).toMatch(/flex:\s*none/); // the bar never shrinks in that column
    expect(bodyOf(".frame")).toMatch(/flex:\s*1/);
    expect(bodyOf(".frame")).toMatch(/min-height:\s*0/);
    expect(bodyOf(".frame")).toMatch(/display:\s*flex/);
    expect(bodyOf("main:has(.graph-page)")).toMatch(/min-height:\s*0/);
    expect(css).not.toMatch(/#root:has\(\.graph-page\)/);
  });

  describe("the top bar", () => {
    const zIndex = (selector: string) => Number(/z-index:\s*(\d+)/.exec(bodyOf(selector))?.[1]);
    const parts = (selector: string) => selector.split(",").map((part) => part.trim());

    it("is sticky, one bar high, above the sidebar (40) and below the tooltip (50)", () => {
      expect(bodyOf(".navbar")).toMatch(/position:\s*sticky/);
      expect(bodyOf(".navbar")).toMatch(/top:\s*0\b/);
      expect(bodyOf(".navbar")).toMatch(/height:\s*var\(--bar-h\)/);
      expect(zIndex(".navbar")).toBeGreaterThan(zIndex(".side"));
      expect(zIndex(".navbar")).toBeLessThan(zIndex(".side-tip"));
    });

    it("pushes the sticky sidebar and tree column down by its height, and keeps them one window tall with it", () => {
      for (const selector of [".side", ".tree-col"]) {
        expect(bodyOf(selector), `"${selector}" top`).toMatch(/top:\s*var\(--bar-h\)/);
        expect(bodyOf(selector), `"${selector}" height`).toMatch(/height:\s*calc\(100vh - var\(--bar-h\)\)/);
      }
      expect(bodyOf(".assets-layout")).toMatch(/min-height:\s*calc\(100vh - var\(--bar-h\)\)/);
    });

    it("keeps a focused element from hiding under it: a scroll offset on html, inside the layer", () => {
      const html = rules.filter((r) => r.selector === "html");
      expect(html).toHaveLength(1);
      expect(inLayer(html[0])).toBe(true);
      expect(html[0].body).toMatch(/scroll-padding-top:\s*var\(--bar-h\)/);
    });

    it("is the sidebar's navy, so the two form one L, and its focus ring is the sidebar's", () => {
      expect(tok("top-bg")).toBe(tok("side-bg"));
      expect(bodyOf(".navbar")).toMatch(/--ring:\s*var\(--side-accent\)/);
    });

    it("has no accent in any rule of its own (the accent is 2.09:1 on the navy), and the white surfaces inside it take the accent ring back", () => {
      const own = rules.filter((r) => r.selector.includes(".navbar"));
      expect(own.length, "the rules of the bar").toBeGreaterThan(0);
      for (const rule of own) expect(rule.body, `"${rule.selector}"`).not.toMatch(/var\(--accent/);
      // the profile panel and the quick find's popup are white and sit inside the bar: they would inherit its light ring (2.10:1 on white)
      for (const selector of [".prof-menu", ".qf-pop"]) {
        const found = rules.filter((r) => parts(r.selector).includes(selector));
        expect(found.some((r) => /--ring:\s*var\(--accent\)/.test(r.body)), `--ring: var(--accent) for ${selector}`).toBe(true);
      }
      // and not the mockup's catch-all, which would repaint those surfaces' rings
      expect(rules.filter((r) => /\.navbar\s+:focus-visible/.test(r.selector))).toEqual([]);
    });

    it("hides the extras of the chip, the clock and the profile in a narrow window, without taking a name out of the accessibility tree", () => {
      const narrow = rules.filter((r) => r.at.some((a) => /max-width:\s*1179\.98px/.test(a)));
      const hiding = narrow.map((r) => r.selector).join(" | ");
      expect(hiding).toContain(".live .detail");
      expect(hiding).toContain(".live .wide"); // w35: " of 48" of "3 of 48 meters stale" goes at the same width as the caption, so the longer word cannot widen the bar
      expect(hiding).toContain(".site-time .zone");
      expect(hiding).toContain(".who-role");
      // the role word is part of the profile button's name: clipped, not display: none
      const role = narrow.find((r) => r.selector.includes(".who-role"))!;
      expect(role.body).not.toMatch(/display:\s*none|visibility:\s*hidden/);
      expect(role.body).toMatch(/clip:\s*rect\(0 0 0 0\)/);
    });

    it("draws the chip's state as a shape as well as a colour: a dot, a hollow ring, a diamond", () => {
      expect(bodyOf(".live::before")).toMatch(/border-radius:\s*50%/);
      expect(bodyOf('.live[data-state="stale"]::before, .live[data-state="waiting"]::before')).toMatch(/box-shadow:\s*inset 0 0 0 2px var\(--top-stale\)/);
      expect(bodyOf('.live[data-state="offline"]::before')).toMatch(/clip-path:\s*polygon/);
    });

    describe("the quick find", () => {
      const field = '.qf input[type="search"]';

      it("is a field on the chip's lighter navy: the find tokens carry its ground, border, text and placeholder", () => {
        expect(bodyOf(".qf")).toMatch(/width:\s*var\(--find-w\)/);
        expect(bodyOf(field)).toMatch(/background:\s*var\(--top-find-bg\)/);
        expect(bodyOf(field)).toMatch(/border:\s*1px solid var\(--top-find-border\)/);
        expect(bodyOf(field)).toMatch(/color:\s*var\(--top-find-text\)/);
        expect(bodyOf(`${field}::placeholder`)).toMatch(/color:\s*var\(--top-find-ph\)/);
        expect(bodyOf(".qf-field > svg.i")).toMatch(/color:\s*var\(--top-find-ph\)/);
        // the base input rule (min-height var(--ctl-h)) comes first in the file and has the same weight as ".qf input": the selector must outrank it
        expect(bodyOf(field)).toMatch(/min-height:\s*0/);
        expect(bodyOf(field)).toMatch(/height:\s*var\(--ctl-h\)/); // the same height as the chip beside it and the buttons in a page
      });

      it("gives the field the border that reaches 3:1, and keeps the quieter ring for the chip and the shortcut hint beside it", () => {
        expect(tok("top-find-border")).not.toBe(tok("top-chip-border"));
        expect(bodyOf(".qf kbd")).toMatch(/border:\s*1px solid var\(--top-chip-border\)/);
        expect(bodyOf(".live")).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--top-chip-border\)/);
        expect(contrast(tok("top-chip-border"), tok("top-bg"))).toBeLessThan(NON_TEXT); // decoration: why it must not be the field's
      });

      it("draws the shortcut hint in the page's font: the browser's own kbd font is monospace", () => {
        expect(bodyOf(".qf kbd")).toMatch(/font-family:\s*inherit/);
        expect(bodyOf(".qf kbd")).toMatch(/color:\s*var\(--top-find-ph\)/);
      });

      it("floats a white popup above the bar's content, with the shared popup shadow, scrolling when the window is short", () => {
        const pop = bodyOf(".qf-pop");
        expect(pop).toMatch(/position:\s*absolute/);
        expect(zIndex(".qf-pop")).toBeGreaterThan(1);
        expect(pop).toMatch(/background:\s*var\(--bg\)/);
        expect(pop).toMatch(/color:\s*var\(--text\)/); // not the bar's light text
        expect(pop).toMatch(/box-shadow:\s*var\(--shadow-pop\)/);
        expect(pop).toMatch(/max-height:/);
        expect(pop).toMatch(/overflow-y:\s*auto/);
      });

      it("shortens a long label and a long path with an ellipsis instead of wrapping", () => {
        for (const selector of [".qf-label", ".qf-opt small"]) {
          const body = bodyOf(selector);
          expect(body, selector).toMatch(/overflow:\s*hidden/);
          expect(body, selector).toMatch(/text-overflow:\s*ellipsis/);
          expect(body, selector).toMatch(/white-space:\s*nowrap/);
          expect(body, selector).toMatch(/min-width:\s*0/);
        }
      });

      it("marks the active option with a fill and a ring, so the colour is not the only sign", () => {
        const active = bodyOf('.qf-opt[aria-selected="true"]');
        expect(active).toMatch(/background:\s*var\(--accent-tint\)/);
        expect(active).toMatch(/outline:\s*2px solid var\(--ring\)/);
        expect(bodyOf(".qf-opt:hover")).toMatch(/background:\s*var\(--accent-tint\)/);
      });

      it("is 300px wide, 220px in a narrow window, where the shortcut hint goes", () => {
        expect(tokens.get("find-w")).toBe("300px");
        const narrow = rules.filter((r) => r.at.some((a) => /max-width:\s*1179\.98px/.test(a)));
        expect(narrow.find((r) => r.selector === "#root")?.body).toMatch(/--find-w:\s*220px/);
        expect(narrow.find((r) => r.selector.includes(".qf kbd"))?.body).toMatch(/display:\s*none/);
      });

      // w14 P6. At 800px with the sidebar open the bar's content box is 520px (564 less two 22px gutters) and its fixed-size children
      // (the find at 220, the chip, the clock, the profile, five 16px gaps and two separators) add up to 560: the profile button ended
      // at 818px and the whole page scrolled sideways by 18px. Every other child is as wide as its content and cannot give, so the find
      // gives: it keeps --find-w as its wanted width, may shrink, and stops at --find-min.
      it("may shrink in the bar's row, down to a floor, so a narrow window with the sidebar open does not scroll sideways (w14 P6)", () => {
        const body = bodyOf(".qf");
        expect(body).toMatch(/flex:\s*0 1 auto/);
        expect(body).toMatch(/width:\s*var\(--find-w\)/);
        expect(body).toMatch(/min-width:\s*var\(--find-min\)/);
        const min = Number(/^(\d+)px$/.exec(tokens.get("find-min") ?? "")?.[1]);
        expect(min, "--find-min in :root, in px").toBeGreaterThan(0);
        expect(min).toBeLessThan(220); // below the narrow window's wanted width, or there would be no room to give
        // the placeholder ("Find an asset or page", about 135px at 13px) still fits beside the icon and the right padding: 34 + 135 + 10 + 2
        expect(min).toBeGreaterThanOrEqual(120);
        // a placeholder that no longer fits ends in an ellipsis, not in half a letter
        expect(bodyOf('.qf input[type="search"]')).toMatch(/text-overflow:\s*ellipsis/);
      });
    });
  });
});

describe("the brand mark (W7n)", () => {
  const marks = rules.filter((r) => /\.brand-mark(?![\w-])/.test(r.selector));
  const only = (selector: string) => {
    const found = rules.filter((r) => r.selector === selector);
    expect(found, `exactly one rule for "${selector}"`).toHaveLength(1);
    return found[0];
  };

  // The mark is an <img> of the owner's artwork: nothing here may tint, blend, fade, round or box it, or the gold would change with the theme.
  it("no rule of the mark sets a background, a border, a radius, a filter, a blend mode or an opacity", () => {
    expect(marks.map((r) => r.selector).sort()).toEqual([".brand .brand-mark", ".brand-mark"]);
    for (const rule of marks) {
      expect(rule.body, `"${rule.selector}"`).not.toMatch(/(?:^|[;\s])(?:background(?:-[\w-]+)?|border(?:-[\w-]+)?|filter|mix-blend-mode|opacity)\s*:/);
    }
  });

  it("has no rule for an svg inside the mark: the bolt is gone", () => {
    expect(rules.filter((r) => /\.brand-mark\s+svg/.test(r.selector))).toEqual([]);
  });

  it("does not shrink in the bar's flex row and is a block, so the box is the image's own", () => {
    const body = only(".brand-mark").body;
    expect(body).toMatch(/flex:\s*none/);
    expect(body).toMatch(/display:\s*block/);
    expect(inLayer(only(".brand-mark"))).toBe(true);
  });

  it("the bar's mark has a keyline in --top-brand-edge (the one bar whose colour is the mark's gold needs it)", () => {
    const rule = only(".brand .brand-mark");
    expect(inLayer(rule)).toBe(true);
    expect(rule.body).toMatch(/outline:\s*1px solid var\(--top-brand-edge\)/);
  });

  it("--top-brand-edge is the bar's own colour in the base, so the navy look shows no outline", () => {
    expect(tok("top-brand-edge")).toBe(tok("top-bg"));
  });
});

describe("the resizable asset tree column (W7a)", () => {
  const only = (selector: string) => {
    const found = rules.filter((r) => r.selector === selector);
    expect(found, `exactly one rule for "${selector}"`).toHaveLength(1);
    return found[0];
  };
  const classCount = (selector: string) => selector.match(/\./g)?.length ?? 0;

  it("the column's width is --w, which takes the user's width (--tree-user-w) and falls back to --tree-w", () => {
    const col = only(".tree-col");
    expect(inLayer(col)).toBe(true);
    expect(col.body).toMatch(/--w:\s*var\(--tree-user-w,\s*var\(--tree-w\)\)/);
    expect(col.body).toMatch(/(?:^|[;\s])width:\s*var\(--w\)/);
  });

  it("is 280px wide in a narrow window too: five header controls leave the title \"Assets Tree\" 104px, and a narrower column cuts it (W7m review I1)", () => {
    expect(tokens.get("tree-w")).toBe("280px");
    const narrow = rules.filter((r) => r.at.some((a) => /max-width:\s*1179\.98px/.test(a)));
    for (const rule of narrow) {
      for (const [, px] of rule.body.matchAll(/--tree-w:\s*(\d+)px/g)) expect(Number(px), `--tree-w in "${rule.selector}"`).toBeGreaterThanOrEqual(280);
    }
  });

  it("a window or sidebar that shrank after saving is guarded in the CSS: 220px at least, else half of the flex container, but leaving 560px to the pane", () => {
    expect(only(".tree-col").body).toMatch(/max-width:\s*max\(220px,\s*min\(50%,\s*calc\(100%\s*-\s*560px\)\)\)/);
    expect(only(".tree-col").body).not.toMatch(/50vw/); // the window is not the area right of the sidebar
  });

  it("the asset pane takes what the column leaves and may shrink below its content", () => {
    const pane = only(".assets-detail");
    expect(pane.body).toMatch(/flex:\s*1[;\s]/);
    expect(pane.body).toMatch(/min-width:\s*0/);
  });

  it("the minimized column keeps its own --w and so ignores the user's width", () => {
    const minimized = only('.tree-col[data-state="minimized"]');
    expect(minimized.body).toMatch(/--w:\s*var\(--tree-w-closed\)/);
    expect(minimized.body).not.toMatch(/--tree-user-w/);
  });

  it("while dragging the column does not animate or select text: .shell.ready .tree-col.is-resizing, after and heavier than the transition rule", () => {
    const base = only(".shell.ready .tree-col");
    expect(base.body).toMatch(/transition:\s*width/);
    const dragging = only(".shell.ready .tree-col.is-resizing");
    expect(inLayer(dragging)).toBe(true);
    expect(dragging.body).toMatch(/transition:\s*none/);
    expect(dragging.body).toMatch(/user-select:\s*none/);
    expect(classCount(dragging.selector)).toBeGreaterThan(classCount(base.selector)); // (0,4,0) against (0,3,0)
    expect(dragging.order).toBeGreaterThan(base.order);
  });

  it("the handle is a 6px strip on the column's right edge with the column-resize cursor and no touch panning", () => {
    const handle = only(".tree-resize");
    expect(inLayer(handle)).toBe(true);
    expect(handle.body).toMatch(/position:\s*absolute/);
    expect(handle.body).toMatch(/right:\s*0/);
    expect(handle.body).toMatch(/(?:^|[;\s])width:\s*6px/);
    expect(handle.body).toMatch(/cursor:\s*col-resize/);
    expect(handle.body).toMatch(/touch-action:\s*none/);
  });

  it("hover, focus and a drag show the handle in --ring", () => {
    const shown = rules.filter((r) => r.selector.split(",").map((part) => part.trim()).includes(".tree-resize:hover::after"));
    expect(shown).toHaveLength(1);
    expect(shown[0].selector).toContain(".tree-resize:focus-visible::after");
    expect(shown[0].selector).toContain(".tree-col.is-resizing .tree-resize::after");
    expect(shown[0].body).toMatch(/background:\s*var\(--ring\)/);
  });

  it("the focus ring of the handle is drawn inside it (negative offset), because the column is overflow: hidden and would clip an outside ring", () => {
    expect(only(".tree-col").body).toMatch(/overflow:\s*hidden/);
    const focus = only(".tree-resize:focus-visible");
    expect(inLayer(focus)).toBe(true);
    expect(focus.body).toMatch(/outline-offset:\s*-\d+px/);
  });
});

describe("a disabled primary button does not look like the accent", () => {
  const disabled = () => {
    const found = rules.filter((r) => r.selector === ".primary:disabled");
    expect(found, 'exactly one rule for ".primary:disabled"').toHaveLength(1);
    return found[0];
  };

  it("takes the neutral ground, border and disabled text at full opacity, in the layer", () => {
    const rule = disabled();
    expect(inLayer(rule)).toBe(true);
    expect(rule.body).toMatch(/background:\s*var\(--surface\)/);
    expect(rule.body).toMatch(/border-color:\s*var\(--border-strong\)/);
    expect(rule.body).toMatch(/color:\s*var\(--text-disabled\)/);
    expect(rule.body).toMatch(/opacity:\s*1\s*(?:;|$)/);
    expect(rule.body).not.toMatch(/--accent/);
  });

  it("outranks both the .primary fill and the base disabled rule (0,2,0 against 0,1,0 and 0,0,1)", () => {
    const base = rules.find((r) => r.selector === ".primary")!;
    expect(base.body).toMatch(/background:\s*var\(--accent\)/);
    expect(disabled().order).toBeGreaterThan(base.order);
  });
});

describe("a deep row of the asset tree keeps a readable name (review M-1)", () => {
  const unconditional = (selector: string) => {
    const found = rules.filter((r) => r.selector === selector && !r.at.some((a) => a.startsWith("@media")));
    expect(found, `exactly one unconditional rule for "${selector}"`).toHaveLength(1);
    return found[0];
  };

  it("the kind label gives way first: it shrinks (a very large shrink factor, no minimum) and ends in an ellipsis", () => {
    const kind = unconditional(".node .kind");
    expect(inLayer(kind)).toBe(true);
    expect(kind.body).toMatch(/flex:\s*0\s+100000\s+auto/);
    expect(kind.body).toMatch(/min-width:\s*0/);
    expect(kind.body).toMatch(/overflow:\s*hidden/);
    expect(kind.body).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("the kind icon is 16 px but gives way after the kind label (shrinkable, no minimum, clipped), so a deep row keeps its +", () => {
    const icon = unconditional(".node-icon");
    expect(inLayer(icon)).toBe(true);
    expect(icon.body).toMatch(/flex:\s*0\s+1\s+16px/);
    expect(icon.body).toMatch(/min-width:\s*0/);
    expect(icon.body).toMatch(/overflow:\s*hidden/);
    expect(icon.body).toMatch(/width:\s*16px/);
  });

  it("the name link keeps at least 6 characters before its ellipsis, whatever the depth", () => {
    const name = unconditional(".node a");
    expect(inLayer(name)).toBe(true);
    expect(name.body).toMatch(/min-width:\s*6ch/);
    expect(name.body).toMatch(/text-overflow:\s*ellipsis/);
  });
});

describe("the open row of the asset tree is told apart from a pick (W7s)", () => {
  // A pick has a tint and a frame (styles/tree-move.css); the open asset has the 3px bar and a bold ink name, and no tint of its own.
  const open = () => {
    const found = rules.filter((r) => r.selector === ".node.is-selected");
    expect(found, 'exactly one rule for ".node.is-selected"').toHaveLength(1);
    return found[0];
  };

  it("declares the accent bar and no background", () => {
    expect(inLayer(open())).toBe(true);
    expect(open().body).toMatch(/box-shadow:\s*inset\s+3px\s+0\s+0\s+var\(--accent\)/);
    expect(open().body).not.toMatch(/background/);
  });

  it("keeps the bold ink name and the accent kind icon", () => {
    expect(rules.find((r) => r.selector === ".node.is-selected a")?.body).toMatch(/color:\s*var\(--accent-ink\)[^}]*font-weight:\s*600/);
    expect(rules.find((r) => r.selector === ".node.is-selected .node-icon")?.body).toMatch(/color:\s*var\(--accent\)/);
  });

  it("an open row takes the hover ground (--surface), and the column's ground is --bg", () => {
    expect(rules.find((r) => r.selector === ".node:hover")?.body).toMatch(/background:\s*var\(--surface\)/);
    expect(rules.find((r) => r.selector === ".tree-col")?.body).toMatch(/background:\s*var\(--bg\)/);
  });
});

describe("the dashboard widgets are not in app.css (w13)", () => {
  // The widgets' rules (the card, the six types, the editor preview, the grid library's chrome and the wrapping of a long asset name in a table)
  // are styles/widgets.css, and their pins are styles/widgets.css.test.ts.
  const widgetSelector = /\.(widget-|stat(?![\w-])|stat-|gauge|dash-grid|dash-cell|react-grid|react-resizable|chip-(long|short))/;
  it("names no widget, stat, gauge or grid-library class in any selector", () => {
    expect(rules.filter((r) => widgetSelector.test(r.selector)).map((r) => r.selector)).toEqual([]);
  });
  it("has no `all: revert` and no light island: nothing resets an element back to the browser's default for the widgets' sake", () => {
    expect(css).not.toMatch(/all:\s*revert/);
    expect(css).not.toMatch(/:is\(\.widget-/);
  });
});

describe("the fleet summary's four tiles are two and two until all four fit in a row (W7i)", () => {
  // jsdom has no layout: the declarations are pinned, and the layout was looked at in a browser at 1440, 1024 and 800 px.
  const pages = parseRules(stripComments(readFileSync("src/styles/pages-assets.css", "utf8")));
  const tiles = pages.filter((r) => r.selector === ".tiles.fleet-tiles");
  const tile = pages.filter((r) => r.selector === ".tiles.fleet-tiles > .tile");
  const inside = (list: Rule[], query: string) => list.filter((r) => r.at.some((a) => a === query));
  const plain = (list: Rule[]) => list.filter((r) => r.at.length === 1 && r.at[0] === "@layer w6");

  it("the row is a wrapping flex row that is a container, so its own width (not the window's) decides", () => {
    expect(plain(tiles)).toHaveLength(1);
    expect(plain(tiles)[0].body).toMatch(/display:\s*flex/);
    expect(plain(tiles)[0].body).toMatch(/flex-wrap:\s*wrap/);
    expect(plain(tiles)[0].body).toMatch(/container-type:\s*inline-size/);
  });

  it("a tile takes half the row (two and two); a row that holds four 170 px tiles and their gaps gives each a quarter; a very narrow one a whole row", () => {
    expect(plain(tile)).toHaveLength(1);
    expect(plain(tile)[0].body).toMatch(/flex:\s*1 1 calc\(50% - 8px\)/);
    const wide = inside(tile, "@container (min-width: 728px)");
    expect(wide).toHaveLength(1);
    expect(wide[0].body).toMatch(/flex-basis:\s*calc\(25% - 12px\)/);
    const narrow = inside(tile, "@container (max-width: 355.98px)");
    expect(narrow).toHaveLength(1);
    expect(narrow[0].body).toMatch(/flex-basis:\s*100%/);
  });
});

describe("a very long asset kind wraps instead of widening the page (W7i)", () => {
  // A kind is free text up to 200 characters, so it may have no space to break at. jsdom has no layout: the declarations are pinned,
  // the e2e spec (w7i.spec.ts) measures the page.
  const pages = parseRules(stripComments(readFileSync("src/styles/pages-assets.css", "utf8")));
  const one = (list: Rule[], selector: string) => {
    const found = list.filter((r) => r.selector === selector && !r.at.some((a) => a.startsWith("@media")));
    expect(found, `exactly one unconditional rule for "${selector}"`).toHaveLength(1);
    expect(inLayer(found[0]), `"${selector}" is inside @layer w6`).toBe(true);
    return found[0].body;
  };

  it("the page header's sub line wraps inside its column (it may be 200 characters without a space) and never runs under the actions", () => {
    const sub = one(rules, ".page-head .sub");
    expect(sub).toMatch(/min-width:\s*0/);
    expect(sub).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("a kind of the fleet summary may shrink to the row, wraps its name anywhere and lets the count drop below it", () => {
    const li = one(pages, ".kind-list li");
    expect(li).toMatch(/min-width:\s*0/);
    expect(li).toMatch(/flex-wrap:\s*wrap/);
    const name = one(pages, ".kind-name");
    expect(name).toMatch(/min-width:\s*0/);
    expect(name).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("the glyph keeps its 16 px beside a wrapping name (svg.i is flex: none for the whole app)", () => {
    expect(one(rules, "svg.i")).toMatch(/flex:\s*none/);
    expect(one(pages, ".kind-name svg.i")).toMatch(/width:\s*16px/);
  });
});

describe("the design tokens (W6)", () => {
  it("live in one :root block, so every var() has one meaning", () => {
    expect(rootRules).toHaveLength(1);
    expect(tokens.size).toBeGreaterThan(40);
  });

  it("body and .muted are each one rule with exactly that selector (the helper above relies on it)", () => {
    expect(rules.filter((r) => r.selector === "body")).toHaveLength(1);
    expect(rules.filter((r) => r.selector === ".muted")).toHaveLength(1);
  });

  it("the page is white (never a cream or off-white ground) and the base type size is unchanged", () => {
    expect(tok("bg")).toBe("#ffffff");
    expect(declared("body", "background")).toBe("#ffffff");
    expect(rules.find((r) => r.selector === "body")!.body).toMatch(/font:\s*14px\/1\.4\s+var\(--font\)/);
  });

  it("the sidebar is quantum navy", () => {
    expect(tok("side-bg")).toBe("#283354");
  });

  // Every pair of spec section 2 "Measured contrast": text pairs at 4.5:1, the non-text ones at 3:1.
  const white = "#ffffff";
  const textPairs: Array<[string, () => string, () => string]> = [
    ["white on the accent (primary button)", () => white, () => tok("accent")],
    ["accent on white (link)", () => tok("accent"), () => tok("bg")],
    ["text on white", () => tok("text"), () => tok("bg")],
    ["text-2 on white", () => tok("text-2"), () => tok("bg")],
    ["disabled text on white", () => tok("text-disabled"), () => tok("bg")],
    ["chip ok", () => tok("ok"), () => tok("ok-tint")],
    ["chip warning", () => tok("warn"), () => tok("warn-tint")],
    ["chip critical", () => tok("crit"), () => tok("crit-tint")],
    ["chip info", () => tok("info"), () => tok("info-tint")],
    ["chip stale", () => tok("stale"), () => tok("stale-tint")],
    ["white on the danger button", () => white, () => tok("danger")],
    ["banner ink on the warning banner", () => tok("warn-ink"), () => tok("warn-bg")],
    ["info banner ink on its tint", () => tok("info-ink"), () => tok("info-tint")],
    ["accent ink on the accent tint (selected, pressed)", () => tok("accent-ink"), () => tok("accent-tint")],
    ["accent on the accent tint (quiet button hover)", () => tok("accent"), () => tok("accent-tint")],
    ["text-2 on the table head ground", () => tok("text-2"), () => tok("surface")],
    ["error text on white", () => tok("crit"), () => tok("bg")],
    ["warning text on white", () => tok("warn-ink"), () => tok("bg")],
    ["text on a conflict row", () => tok("text"), () => tok("crit-tint")],
    ["sidebar: white on the navy", () => tok("side-text-strong"), () => tok("side-bg")],
    ["sidebar: link text on the navy", () => tok("side-text"), () => tok("side-bg")],
    ["sidebar: link text on the hover fill", () => tok("side-text"), () => tok("side-bg-hover")],
    ["sidebar: hover text on the hover fill", () => tok("side-text-strong"), () => tok("side-bg-hover")],
    ["sidebar: group heading on the plain navy", () => tok("side-muted"), () => tok("side-bg")],
    ["sidebar: active item", () => tok("side-text-strong"), () => tok("side-bg-active")],
    ["sidebar: accent on the navy (focus ring, indicator)", () => tok("side-accent"), () => tok("side-bg")],
    ["sidebar: navy on the accent marker", () => tok("side-bg"), () => tok("side-accent")],
    ["sidebar: avatar", () => tok("side-avatar-text"), () => tok("side-avatar-bg")],
    ["tooltip", () => tok("tooltip-text"), () => tok("tooltip-bg")],
    ["top bar: white on the bar (brand, site time, user name)", () => tok("side-text-strong"), () => tok("top-bg")],
    ["top bar: light text on the bar (time zone, role word)", () => tok("side-text"), () => tok("top-bg")],
    ["top bar: the role word on the open profile button", () => tok("side-text"), () => tok("side-bg-active")],
    ["top bar: find text on the find ground (and the chip's word)", () => tok("top-find-text"), () => tok("top-find-bg")],
    ["top bar: placeholder on the find ground (and the chip's age)", () => tok("top-find-ph"), () => tok("top-find-bg")],
    ["quick find: text on the active option", () => tok("text"), () => tok("accent-tint")],
    ["quick find: the path and the group caption on the active option", () => tok("text-2"), () => tok("accent-tint")],
    ["quick find: the path and the group caption on the popup", () => tok("text-2"), () => tok("bg")],
  ];
  it.each(textPairs)("%s reads at 4.5:1", (_name, fg, bg) => {
    expect(contrast(fg(), bg())).toBeGreaterThanOrEqual(AA);
  });

  const nonTextPairs: Array<[string, () => string, () => string]> = [
    ["sidebar: accent on the active fill", () => tok("side-accent"), () => tok("side-bg-active")],
    ["a field's border on white", () => tok("field-border"), () => tok("bg")],
    ["a field's border on the surface ground", () => tok("field-border"), () => tok("surface")],
    ["top bar: the live dot on the chip ground", () => tok("top-live"), () => tok("top-find-bg")],
    ["top bar: the stale ring and offline diamond on the chip ground", () => tok("top-stale"), () => tok("top-find-bg")],
    ["top bar: white on the bar, as a mark rather than text", () => tok("side-text-strong"), () => tok("top-bg")],
    ["top bar: the quick find's border on the bar (its outer edge)", () => tok("top-find-border"), () => tok("top-bg")],
    ["top bar: the quick find's border on the field ground (its inner edge)", () => tok("top-find-border"), () => tok("top-find-bg")],
    ["quick find: the active option's ring on the popup", () => tok("accent"), () => tok("bg")],
  ];
  it.each(nonTextPairs)("%s reads at 3:1", (_name, fg, bg) => {
    expect(contrast(fg(), bg())).toBeGreaterThanOrEqual(NON_TEXT);
  });

  it("the content accent is 2.09:1 on the navy, which is why no sidebar rule may use it", () => {
    expect(contrast(tok("accent"), tok("side-bg"))).toBeLessThan(NON_TEXT);
    // .side covers .side-row, .side-foot, .side-tip and .side-toggle; the rest of the rail's pieces are named one by one
    const sideRules = rules.filter((r) => /\.(side|brand-mark|avatar|who|nav-heading)(?![\w-]*-page)/.test(r.selector));
    expect(sideRules.length, "the rules of the rail").toBeGreaterThan(25);
    for (const rule of sideRules) expect(rule.body, `"${rule.selector}"`).not.toMatch(/var\(--accent/);
    // once the sidebar rule exists it overrides the focus ring colour (--ring equals --accent, which the navy cannot show)
    for (const rule of rules.filter((r) => r.selector === ".side")) expect(rule.body).toMatch(/--ring:\s*var\(--side-accent\)/);
  });
});

describe("the layer and the one unlayered rule set", () => {
  // The Billing muted cell: literals on purpose (app.css.test.ts reads them, themes.css overrides them in dark), unlayered and after the layer.
  // w13: the widgets' island and frozen block are gone; their rules are styles/widgets.css, in the layer, on tokens.
  const UNLAYERED = [
    "table.billing td.muted, table.billing td.muted .muted",
    "table.billing td.muted",
  ];

  it("the layered rules of app.css hold no raw colour: the tokens in :root are the only place a colour is written", () => {
    for (const rule of rules.filter((r) => inLayer(r))) {
      expect(rule.body, `colour in "${rule.selector}"`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    }
  });

  it("has one @layer w6 block", () => {
    expect(css.match(/@layer/g) ?? []).toHaveLength(1);
    expect(css).toMatch(/@layer\s+w6\s*\{/);
    expect(rules.some(inLayer)).toBe(true);
  });

  it("holds no unlayered rule but the tokens and the Billing muted cell", () => {
    expect(rules.filter((r) => !inLayer(r)).map((r) => r.selector)).toEqual([":root", ...UNLAYERED]);
  });

  it.each(UNLAYERED)("%s stays unlayered, after the layer, so no layer rule can outrank it", (selector) => {
    const found = rules.filter((r) => r.selector === selector);
    expect(found.length, `a rule for "${selector}"`).toBeGreaterThan(0);
    const lastLayered = Math.max(...rules.filter(inLayer).map((r) => r.order));
    for (const rule of found) {
      expect(inLayer(rule), `"${selector}" is in the layer`).toBe(false);
      expect(rule.order, `"${selector}" comes before the end of the layer`).toBeGreaterThan(lastLayered);
    }
  });

  it("the old bare .chip and .chip-warn are gone (they are the layered status chips now)", () => {
    const bare = rules.filter((r) => r.selector === ".chip" || r.selector === ".chip-warn");
    for (const rule of bare) expect(inLayer(rule), `"${rule.selector}"`).toBe(true);
  });
});

describe("the page style files (src/styles/*.css)", () => {
  const STYLES = "src/styles";
  const files = existsSync(STYLES) ? readdirSync(STYLES).filter((f) => f.endsWith(".css")).sort() : [];

  it("has one file per page group", () => {
    expect(files).toEqual(
      expect.arrayContaining(["pages-admin.css", "pages-assets.css", "pages-auth.css", "pages-billing.css", "pages-sources.css"]),
    );
  });

  it.each(["pages-admin.css", "pages-assets.css", "pages-auth.css", "pages-billing.css", "pages-sources.css", "feedback-save.css", "feedback-toasts.css", "feedback-confirm.css", "role-prompt.css", "drawer.css", "icon-picker.css", "kinds-dialogs.css", "tree-move.css", "asset-move.css", "scans-drawer.css", "discovery-tidy.css", "bulk-assets.css", "scans-polish.css", "graph-nodes.css", "graph-tools.css", "graph-keys.css", "graph-source-card.css", "graph-value-tip.css", "widgets.css", "widgets-details.css", "month-check.css", "asset-picker.css", "focus-follow.css", "focus-header.css", "focus-drill.css", "templates.css", "dashboard-guide.css", "displays.css", "display-screen.css", "display-wall.css", "import-dialog.css", "taglist-dialog.css", "history-fill.css", "storage-events.css", "tags-events.css", "audit-outcome.css", "pages-events.css", "pages-shapes.css"])(
    "%s is one @layer w6 block with nothing outside it, no raw colour and no accent in a sidebar rule",
    (file) => {
      expect(existsSync(`${STYLES}/${file}`), `${STYLES}/${file} exists`).toBe(true);
      const text = stripComments(readFileSync(`${STYLES}/${file}`, "utf8"));
      expect(text.match(/@layer/g) ?? []).toHaveLength(1);
      const open = text.search(/@layer\s+w6\s*\{/);
      expect(open, "an @layer w6 block").toBeGreaterThanOrEqual(0);
      expect(text.slice(0, open).trim(), "text before the block").toBe("");
      let depth = 0;
      let close = -1;
      for (let i = text.indexOf("{", open); i < text.length && close < 0; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}" && --depth === 0) close = i;
      }
      expect(close, "the block is closed").toBeGreaterThan(open);
      expect(text.slice(close + 1).trim(), "text after the block").toBe("");
      for (const rule of parseRules(text)) {
        expect(rule.body, `colour in "${rule.selector}"`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
        if (rule.selector.includes(".side")) expect(rule.body, `"${rule.selector}"`).not.toMatch(/var\(--accent/);
      }
    },
  );

  // All five files load on every route, so a rule written for one page group can restyle another. The guard: a class that a rule
  // names on its own (no page-root class before it) belongs to one file, and no other page file may name it.
  const parsed = files.map((file) => ({ file, rules: parseRules(stripComments(readFileSync(`${STYLES}/${file}`, "utf8"))) }));

  /** A selector list split at its top-level commas (a comma inside :is(...) or [...] stays in its part). */
  const selectorParts = (selector: string) => {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of selector) {
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      if (ch === "," && depth === 0) {
        parts.push(current.trim());
        current = "";
      } else current += ch;
    }
    return [...parts, current.trim()];
  };
  /** The part of one selector before its first top-level combinator (space, >, + or ~). */
  const firstCompound = (part: string) => {
    let depth = 0;
    let end = part.length;
    for (let i = 0; i < part.length; i++) {
      const ch = part[i];
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      else if (depth === 0 && " >+~".includes(ch)) {
        end = i;
        break;
      }
    }
    return part.slice(0, end);
  };
  const classesIn = (text: string) => [...text.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]);
  /** The classes a file's rules name on their own: the first compound is one class, with at most pseudo-classes after it. */
  const bareClasses = (list: Rule[]) =>
    new Set(
      list.flatMap((r) =>
        selectorParts(r.selector).flatMap((part) => {
          const m = /^\.([A-Za-z_][\w-]*)(?::{1,2}[\w-]+(?:\([^)]*\))?|\[[^\]]*\])*$/.exec(firstCompound(part));
          return m ? [m[1]] : [];
        }),
      ),
    );

  it("no class is written on its own in one page file and named in another (one page group cannot restyle another)", () => {
    expect(parsed.length).toBeGreaterThanOrEqual(5);
    // The one deliberate cross-file rule (W7l, review C2): while a drawer is open, drawer.css lifts the toast stack above the drawer's footer
    // (`body:has(.drawer) .toast-stack`). The stack is feedback-toasts.css's; the lift can only be written where the drawer's footer height is.
    // And w29 (display wall): display-wall.css raises the type of four card lines (the stat's comparison figure and its note lines) to what reads from across a room, only inside
    // `.wall-canvas`, which exists on the wall alone. They are widgets.css's bare classes; the wall page cannot be styled anywhere else.
    const SANCTIONED = new Set([
      ".toast-stack: bare in feedback-toasts.css, named in drawer.css",
      ".stat-last-fig: bare in widgets.css, named in display-wall.css",
      ".stat-window: bare in widgets.css, named in display-wall.css",
      ".stat-note: bare in widgets.css, named in display-wall.css",
      ".bars-note: bare in widgets.css, named in display-wall.css",
    ]);
    const clashes: string[] = [];
    for (const a of parsed) {
      for (const cls of bareClasses(a.rules)) {
        for (const b of parsed.filter((other) => other.file !== a.file)) {
          if (b.rules.some((r) => classesIn(r.selector).includes(cls))) clashes.push(`.${cls}: bare in ${a.file}, named in ${b.file}`);
        }
      }
    }
    expect(clashes.filter((clash) => !SANCTIONED.has(clash))).toEqual([]);
    for (const clash of SANCTIONED) expect(clashes, "the sanctioned exception is still in use (else delete it)").toContain(clash);
  });

  it("no selector is written in two page files, and no plain class rule is written in both a page file and app.css", () => {
    // (app.css and pages-billing.css split the billing table between them on purpose: a selector there is compared only when it is a plain class)
    const owners = new Map<string, Set<string>>();
    const note = (file: string, list: Rule[], keep: (part: string) => boolean) => {
      for (const r of list) for (const part of selectorParts(r.selector).filter(keep)) owners.set(part, (owners.get(part) ?? new Set()).add(file));
    };
    note("app.css", rules, (part) => /^\.[\w-]+$/.test(part));
    // The steps of an animation ("from", "to", "50%") are not selectors of a page: two files may each have an animation that starts at `from`.
    for (const p of parsed) note(p.file, p.rules.filter((r) => !r.at.some((a) => a.startsWith("@keyframes"))), () => true);
    const twice = [...owners].filter(([, files]) => files.size > 1).map(([selector, files]) => `${selector}: ${[...files].join(", ")}`);
    expect(twice).toEqual([]);
  });

  it("every selector of a page file names a class (a bare element rule such as td would reach every table)", () => {
    const bare: string[] = [];
    for (const p of parsed) {
      for (const r of p.rules) {
        if (r.at.some((a) => a.startsWith("@keyframes"))) continue; // the frames of an animation ("from", "to", "50%") are not selectors of the page
        for (const part of selectorParts(r.selector)) {
          if (classesIn(part).length === 0) bare.push(`${p.file}: ${part}`);
        }
      }
    }
    expect(bare).toEqual([]);
  });

  it("the Tariffs form bars leave the size of their Save and Add buttons to the base button (W18: --ctl-h, like the fields beside them), and any rule that does size one spares the ? tips (a 34px tip would sit 10px below its label line)", () => {
    const billing = parsed.find((p) => p.file === "pages-billing.css")!;
    const onButtons = billing.rules.flatMap((r) => selectorParts(r.selector).filter((part) => /\.inline-form button/.test(part)).map((part) => ({ part, body: r.body })));
    expect(rules.find((r) => r.selector === "button")!.body, "the base button the bar's buttons take their height from").toMatch(/min-height:\s*var\(--ctl-h\)/);
    for (const { part, body } of onButtons) {
      if (/(min-)?(height|width)\s*:/.test(body)) expect(part, "spares the icon buttons").toContain(":not(.icon-btn)");
    }
  });

  it("the checks above can see a clash (the helpers are exercised on a small example)", () => {
    const sample = parseRules(".row-actions { display: flex; } td.row-actions, .users-page .row-actions :is(a, b), .x:hover, .y::before { color: red; }");
    expect([...bareClasses(sample)].sort()).toEqual(["row-actions", "users-page", "x", "y"]); // a page root is "bare" too; only it is named in no other file
    expect(selectorParts(".a :is(b, c), d")).toEqual([".a :is(b, c)", "d"]);
    expect(firstCompound(".users-page .row-actions")).toBe(".users-page");
  });
});

describe("the row menu, the trash button and the info tip (W7b)", () => {
  const SHARED = /\.(row-menu-btn|row-menu-panel|trash-btn|tip|tip-btn|tip-bubble|has-tip)(?![\w-])/;
  const mine = rules.filter((r) => SHARED.test(r.selector));
  const only = (selector: string) => {
    const found = rules.filter((r) => r.selector === selector);
    expect(found, `exactly one rule for "${selector}"`).toHaveLength(1);
    return found[0];
  };
  const zIndex = (selector: string) => Number(/z-index:\s*(\d+)/.exec(only(selector).body)?.[1]);
  const parts = (selector: string) => selector.split(",").map((part) => part.trim());

  it("every rule is inside the layer and uses tokens only, no raw colour", () => {
    expect(mine.length, "the rules of the three pieces").toBeGreaterThan(12);
    for (const rule of mine) {
      expect(inLayer(rule), `"${rule.selector}" in @layer w6`).toBe(true);
      expect(rule.body, `colour in "${rule.selector}"`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    }
  });

  it("the menu panel is a fixed, scrolling, white popup above the top bar and below the dialogs", () => {
    const panel = only(".row-menu-panel").body;
    expect(panel).toMatch(/position:\s*fixed/);
    expect(panel).toMatch(/min-width:\s*168px/);
    expect(panel).toMatch(/max-height:\s*calc\(100vh - 16px\)/);
    expect(panel).toMatch(/overflow-y:\s*auto/);
    expect(panel).toMatch(/background:\s*var\(--bg\)/);
    expect(panel).toMatch(/box-shadow:\s*var\(--shadow-pop\)/);
    expect(panel).toMatch(/border-radius:\s*var\(--radius\)/);
    expect(zIndex(".row-menu-panel")).toBeGreaterThan(zIndex(".navbar"));
    expect(zIndex(".row-menu-panel")).toBeLessThan(zIndex(".dialog-backdrop"));
  });

  it("the tip bubble sits above the page chrome (sidebar, bar) AND above the dialogs: it is a portal on the body, so a tip in a dialog's own grid (the Roles editor) is outside the dialog's stacking context", () => {
    expect(zIndex(".tip-bubble")).toBeGreaterThan(zIndex(".navbar"));
    expect(zIndex(".tip-bubble")).toBeGreaterThan(zIndex(".dialog-backdrop"));
  });

  it("a menu item is a flat, left-aligned, 34px row that undoes the base button (no border, no centring), ringed inside the panel", () => {
    const item = only('.row-menu-panel [role="menuitem"]').body;
    expect(item).toMatch(/width:\s*100%/);
    expect(item).toMatch(/min-height:\s*34px/);
    expect(item).toMatch(/border:\s*0/);
    expect(item).toMatch(/justify-content:\s*flex-start/);
    expect(item).toMatch(/text-align:\s*left/);
    expect(item).toMatch(/text-decoration:\s*none/); // a link item
    // inside the panel: it scrolls, so an outside ring would be clipped
    const ring = only('.row-menu-panel [role="menuitem"]:focus-visible').body;
    expect(ring).toMatch(/outline:\s*2px solid var\(--ring\)/);
    expect(ring).toMatch(/outline-offset:\s*-\d+px/);
    expect(only('.row-menu-panel [role="menuitem"]:disabled').body).toMatch(/color:\s*var\(--text-disabled\)/);
    expect(only(".row-menu-panel .danger-item").body).toMatch(/color:\s*var\(--crit\)/);
  });

  it("the trash button turns critical on hover and focus, later in the file than the icon button's accent hover it must beat", () => {
    const hover = rules.find((r) => parts(r.selector).includes(".trash-btn:hover:not(:disabled)"))!;
    expect(parts(hover.selector)).toContain(".trash-btn:focus-visible");
    expect(hover.body).toMatch(/background:\s*var\(--crit-tint\)/);
    expect(hover.body).toMatch(/color:\s*var\(--crit\)/);
    expect(hover.order).toBeGreaterThan(only(".icon-btn:hover:not(:disabled)").order);
    expect(contrast(tok("crit"), tok("crit-tint"))).toBeGreaterThanOrEqual(AA);
  });

  it("the lid turns about its left end (its hinge), lifting and tilting, over the motion token", () => {
    const lid = only(".trash-btn .lid").body;
    expect(lid).toMatch(/transform-box:\s*fill-box/); // otherwise the SVG would turn it about its own 0,0
    expect(lid).toMatch(/transform-origin:\s*0% 100%/);
    expect(lid).toMatch(/transition:\s*transform var\(--motion\)/);
    const lifted = rules.find((r) => parts(r.selector).includes(".trash-btn:hover:not(:disabled) .lid"))!;
    expect(parts(lifted.selector)).toContain(".trash-btn:focus-visible .lid");
    expect(lifted.body).toMatch(/transform:\s*translateY\(-1\.5px\) rotate\(-16deg\)/);
  });

  it("the bin's icon does not clip: a lifted lid swings past the icon's own box (with the default hidden overflow the handle lost its top edge and its slot closed)", () => {
    expect(only(".trash-btn svg").body).toMatch(/overflow:\s*visible/);
  });

  it("with reduced motion the lid does not move: the hover and focus selectors are repeated, because the plain one would lose on specificity", () => {
    const calm = rules.filter((r) => r.at.some((a) => a.includes("prefers-reduced-motion: reduce")) && parts(r.selector).includes(".trash-btn .lid"));
    expect(calm, "a reduced-motion rule for .trash-btn .lid").toHaveLength(1);
    expect(parts(calm[0].selector)).toEqual(expect.arrayContaining([".trash-btn:hover:not(:disabled) .lid", ".trash-btn:focus-visible .lid"]));
    expect(calm[0].body).toMatch(/transform:\s*none/);
    expect(calm[0].body).toMatch(/transition:\s*none/);
    const lifted = rules.find((r) => parts(r.selector).includes(".trash-btn:hover:not(:disabled) .lid"))!;
    expect(calm[0].order).toBeGreaterThan(lifted.order);
  });

  it("the tip bubble is white on the tooltip navy, wraps at 320px (80vw on a small window), and is fixed (placed in window coordinates by placeTip, so no scrolling box clips it)", () => {
    const bubble = only(".tip-bubble").body;
    expect(bubble).toMatch(/max-width:\s*min\(320px,\s*80vw\)/);
    expect(bubble).toMatch(/position:\s*fixed/);
    expect(bubble).toMatch(/box-shadow:\s*var\(--shadow-tip\)/);
    expect(bubble).toMatch(/white-space:\s*normal/);
    expect(contrast(tok("tooltip-text"), tok("tooltip-bg"))).toBeGreaterThanOrEqual(AA);
    expect(css).not.toContain('.tip-bubble[data-align="end"]'); // the old leftwards rule: placeTip aligns the edges now
  });

  it("a tip sits at the end of a label line without being inside the label: .has-tip anchors it", () => {
    expect(only(".tip").body).toMatch(/position:\s*relative/);
    expect(only(".has-tip").body).toMatch(/position:\s*relative/);
    const placed = only(".has-tip > .tip").body;
    expect(placed).toMatch(/position:\s*absolute/);
    expect(placed).toMatch(/top:\s*0/);
    expect(placed).toMatch(/right:\s*0/);
  });

  it("a tip never covers its label and sits on the label's first line: the label keeps 28px free, the field gives them back, the tip box is one label line high", () => {
    const reserved = /padding-right:\s*(\d+)px/.exec(only(".has-tip > label").body)?.[1];
    expect(Number(reserved), "room reserved at the right of the label").toBeGreaterThanOrEqual(24 + 4); // the 24px button and a 4px gap
    expect(only(".has-tip > label:not(.inline) > :is(input, select, textarea)").body).toMatch(new RegExp(`margin-right:\\s*-${reserved}px`));
    expect(only(".has-tip > .tip").body).toMatch(/height:\s*calc\(var\(--fs-sm\)\s*\*\s*1\.4\)/); // the label's font size at the 1.4 line height of the page
    expect(only("label").body).toMatch(/font-size:\s*var\(--fs-sm\)/);
  });

  it("a label.inline (a checkbox beside its words) never takes the field's negative margin: it would pull the words under the box (w24 whole-wave review I-1)", () => {
    expect(css).not.toMatch(/\.has-tip\s*>\s*label\s*>\s*:is\(input, select, textarea\)/); // the rule names the label it leaves out
    expect(only(".has-tip > label:not(.inline) > :is(input, select, textarea)").selector).toContain(":not(.inline)");
    expect(only(".dialog label.inline").body).toMatch(/display:\s*flex;\s*gap:\s*6px/); // the box and its words side by side, 6px apart
    expect(only(".editor-cols .compare-field").body).toMatch(/width:\s*fit-content/); // the compare box's tip follows its words
  });

  it("Whole site in the widget editor, when the whole site is chosen, looks disabled (its own class: the picker's Clear all keeps its own look) and takes the hover wash back, and is never a native :disabled", () => {
    const look = only('.editor-cols .whole-site[aria-disabled="true"]').body;
    expect(look).toMatch(/opacity:\s*0\.55/);
    expect(look).toMatch(/cursor:\s*not-allowed/);
    expect(only('.editor-cols .whole-site[aria-disabled="true"]:hover').body).toMatch(/background:\s*none/);
  });

  it("the tip and menu buttons keep a hit area of 24px or more", () => {
    expect(only(".tip-btn").body).toMatch(/width:\s*24px;\s*height:\s*24px/);
    expect(only(".icon-btn").body).toMatch(/width:\s*var\(--ctl-h-xs\);\s*height:\s*var\(--ctl-h-xs\)/);
  });
});

describe("the loading bar (W7e)", () => {
  const mine = rules.filter((r) => r.selector.includes(".top-progress"));
  const only = (selector: string) => {
    const found = mine.filter((r) => r.selector === selector);
    expect(found, `exactly one rule for "${selector}"`).toHaveLength(1);
    return found[0];
  };
  const fill = (phase: string) => only(`.top-progress[data-phase="${phase}"] > span`).body;
  const zIndex = (selector: string) => Number(/z-index:\s*(\d+)/.exec(rules.find((r) => r.selector === selector)?.body ?? "")?.[1]);

  it("every rule is inside the layer, uses tokens only, and the marker colour is the sidebar's (no accent: it never touches .navbar or .side)", () => {
    expect(mine.length, "the rules of the bar").toBeGreaterThan(5);
    for (const rule of mine) {
      expect(inLayer(rule), `"${rule.selector}" in @layer w6`).toBe(true);
      expect(rule.body, `colour in "${rule.selector}"`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
      expect(rule.selector, "a bar rule that reaches into the shell").not.toMatch(/\.navbar|\.side/);
    }
    expect(only(".top-progress > span").body).toMatch(/background:\s*var\(--side-accent\)/);
  });

  it("is a 3px line fixed to the top edge, above the top bar (45), below the sidebar tip (50) and the dialogs, and never takes a click", () => {
    const bar = only(".top-progress").body;
    expect(bar).toMatch(/position:\s*fixed/);
    expect(bar).toMatch(/inset:\s*0 0 auto 0/);
    expect(bar).toMatch(/height:\s*3px/);
    expect(bar).toMatch(/pointer-events:\s*none/);
    expect(zIndex(".top-progress")).toBeGreaterThan(zIndex(".navbar"));
    expect(zIndex(".top-progress")).toBeLessThan(zIndex(".side-tip"));
    expect(zIndex(".top-progress")).toBeLessThan(zIndex(".dialog-backdrop"));
  });

  it("draws each phase: hidden at rest, zero with no transition on reset, a slow sweep to 85 percent on run, the rest and the fade after", () => {
    expect(only(".top-progress > span").body).toMatch(/width:\s*0\b/);
    expect(only(".top-progress > span").body).toMatch(/opacity:\s*0\b/);
    expect(only(".top-progress > span").body).not.toMatch(/transition/);
    expect(fill("reset")).toMatch(/width:\s*0\b/);
    expect(fill("reset")).toMatch(/opacity:\s*1\b/);
    expect(fill("reset")).not.toMatch(/transition/); // or a restart would sweep backwards
    expect(fill("run")).toMatch(/width:\s*85%/);
    expect(fill("run")).toMatch(/transition:\s*width 30s cubic-bezier\(/);
    expect(fill("finish")).toMatch(/width:\s*100%/);
    expect(fill("finish")).toMatch(/transition:\s*width 150ms/);
    expect(fill("fade")).toMatch(/width:\s*100%/);
    expect(fill("fade")).toMatch(/opacity:\s*0\b/);
    expect(fill("fade")).toMatch(/transition:\s*opacity 200ms/);
  });

  it("reduced motion shows a full line with no width movement", () => {
    const calm = rules.filter((r) => r.at.some((a) => a.includes("prefers-reduced-motion: reduce")) && r.selector.includes(".top-progress"));
    expect(calm).toHaveLength(1);
    expect(calm[0].body).toMatch(/width:\s*100%/);
    expect(calm[0].body).toMatch(/transition:\s*none/);
    const specificity = (selector: string) => [...selector.matchAll(/\[[^\]]+\]|\.[\w-]+/g)].length; // classes and attributes: enough for these selectors
    for (const phase of ["reset", "run", "finish", "fade"]) {
      expect(specificity(calm[0].selector), `reduced motion beats the ${phase} rule`).toBeGreaterThanOrEqual(specificity(`.top-progress[data-phase="${phase}"] > span`));
      expect(css.indexOf(calm[0].selector), "after the phase rules").toBeGreaterThan(css.indexOf(`.top-progress[data-phase="${phase}"] > span`));
    }
  });
});

describe("the loading skeletons (W7f)", () => {
  // every rule that styles a skeleton piece: .sk, .sk-region, .sk-line, ... (not .skip-link)
  const SK = /\.sk(-[\w-]+)?(?![\w-])/;
  const mine = rules.filter((r) => SK.test(r.selector));
  const only = (selector: string) => {
    const found = mine.filter((r) => r.selector === selector && !r.at.some((a) => a.startsWith("@media"))); // the reduced-motion rule is checked on its own
    expect(found, `exactly one rule for "${selector}"`).toHaveLength(1);
    return found[0];
  };
  const keyframes = (name: string) => rules.filter((r) => r.at.some((a) => a === `@keyframes ${name}`));
  const reduced = (r: Rule) => r.at.some((a) => a.includes("prefers-reduced-motion: reduce"));

  it("has two tokens in :root, both hex colours (the dark values are themes.css's)", () => {
    expect(tok("skeleton")).toMatch(HEX);
    expect(tok("skeleton-shine")).toMatch(HEX);
    expect(tok("skeleton")).not.toBe(tok("skeleton-shine"));
  });

  it("every rule is inside the layer, holds no colour, no shadow, no blur, and never reaches for the accent", () => {
    expect(mine.length, "the skeleton rules").toBeGreaterThan(8);
    for (const rule of mine) {
      expect(inLayer(rule), `"${rule.selector}" in @layer w6`).toBe(true);
      expect(rule.body, `colour in "${rule.selector}"`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
      expect(rule.body, `shadow or blur in "${rule.selector}"`).not.toMatch(/box-shadow|text-shadow|filter|backdrop-filter/);
      expect(rule.body, `accent in "${rule.selector}"`).not.toMatch(/var\(--accent|var\(--ring/);
    }
    for (const frame of [...keyframes("sk-in"), ...keyframes("sk-sweep")]) expect(inLayer(frame), `keyframe "${frame.selector}" in the layer`).toBe(true);
  });

  it("rounds with the radius tokens (4 to 8px) and 50% for circles only: no pill", () => {
    for (const rule of mine) {
      const radius = /border-radius:\s*([^;]+)/.exec(rule.body)?.[1].trim();
      if (radius) expect(radius, `radius of "${rule.selector}"`).toMatch(/^(var\(--radius(-sm|-lg)?\)|50%)$/);
    }
    expect(only(".sk-circle").body).toMatch(/border-radius:\s*50%/);
    expect(only(".sk-line").body).toMatch(/border-radius:\s*var\(--radius-sm\)/);
    expect(only(".sk-block").body).toMatch(/border-radius:\s*var\(--radius\)/);
  });

  it("the shape is the base token on a clipped, positioned box (so the sweep stays inside it)", () => {
    const base = only(".sk").body;
    expect(base).toMatch(/background:\s*var\(--skeleton\)/);
    expect(base).toMatch(/position:\s*relative/);
    expect(base).toMatch(/overflow:\s*hidden/);
    expect(base).not.toMatch(/animation/);
  });

  it("fades the region in after 150 ms, in pure CSS: opacity 0 to 1, the delayed state held at 0 by fill-mode both", () => {
    expect(only(".sk-region").body).toMatch(/animation:\s*sk-in\s+120ms\s+linear\s+150ms\s+both\b/);
    const [from, to] = [keyframes("sk-in").find((r) => r.selector === "from")!, keyframes("sk-in").find((r) => r.selector === "to")!];
    expect(from.body).toMatch(/opacity:\s*0\b/);
    expect(to.body).toMatch(/opacity:\s*1\b/);
  });

  it("sweeps on a ::after of each shape, a theme-neutral gradient from the shine token, 1.4s, not on the box itself", () => {
    const sweep = only(".sk::after").body;
    expect(sweep).toMatch(/animation:\s*sk-sweep\s+1\.4s\s+linear\s+infinite/);
    expect(sweep).toMatch(/linear-gradient\([^)]*var\(--skeleton-shine\)/);
    expect(sweep).toMatch(/position:\s*absolute/);
    const [from, to] = [keyframes("sk-sweep").find((r) => r.selector === "from")!, keyframes("sk-sweep").find((r) => r.selector === "to")!];
    expect(from.body).toMatch(/translateX\(-100%\)/);
    expect(to.body).toMatch(/translateX\(100%\)/);
  });

  it("reduced motion stops the sweep and hides it, and leaves the region's delayed fade alone (without the delay the flash would be back)", () => {
    const calm = mine.filter(reduced);
    expect(calm.map((r) => r.selector)).toEqual([".sk::after"]);
    expect(calm[0].body).toMatch(/animation:\s*none/);
    expect(calm[0].body).toMatch(/display:\s*none/);
    expect(rules.filter((r) => reduced(r) && r.selector.includes("sk-region"))).toEqual([]);
    expect(calm[0].order, "after the rule it overrides").toBeGreaterThan(only(".sk::after").order);
    expect(only(".sk-region").body).not.toMatch(/animation:\s*none/);
  });

  it("[data-instant] switches the region's fade off and nothing else: it follows the region rule at the same or a higher weight", () => {
    const withAttr = mine.filter((r) => r.selector.includes("data-instant"));
    expect(withAttr.map((r) => r.selector)).toEqual([".sk-region[data-instant]"]);
    expect(withAttr[0].body).toMatch(/animation:\s*none/);
    expect(withAttr[0].order).toBeGreaterThan(only(".sk-region").order);
  });

  it("the shapes keep their size in a flex row (blocks and circles never shrink)", () => {
    expect(only(".sk-block").body).toMatch(/flex:\s*none/);
    expect(only(".sk-circle").body).toMatch(/flex:\s*none/);
  });

  it("the dashboard skeleton's trail has the margin the real one has directly under main, and its widgets sit in two columns, one on a narrow window", () => {
    const margin = (body: string) => /margin:\s*([^;]+)/.exec(body)?.[1].trim();
    const real = rules.find((r) => r.selector === "main > .crumbs")!;
    expect(margin(only(".sk-dash > .crumbs").body)).toBe(margin(real.body));
    expect(only(".sk-quad").body).toMatch(/grid-template-columns:\s*repeat\(2,/);
    const narrow = mine.filter((r) => r.selector === ".sk-quad" && r.at.some((a) => a.startsWith("@media (max-width: 700px)")));
    expect(narrow).toHaveLength(1);
    expect(narrow[0].body).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
  });
});

describe("the app-shell skeleton (W7h)", () => {
  // every rule written for it: the placeholder sizes, the .sk-shell scope and the find box
  const mine = rules.filter((r) => /\.sk-(shell|find|[wh]-\d+)(?![\w-])/.test(r.selector));
  const narrow = (r: Rule) => r.at.some((a) => a.startsWith("@media (max-width: 1179.98px)"));
  const only = (selector: string) => {
    const found = mine.filter((r) => r.selector === selector && !narrow(r)); // the narrow window's rules are checked on their own
    expect(found, `exactly one rule for "${selector}"`).toHaveLength(1);
    return found[0];
  };
  const markup = renderToStaticMarkup(createElement(AppShellSkeleton, { sidebar: "expanded" }));
  const used = [...new Set(markup.match(/\bsk-[wh]-\d+\b/g) ?? [])].sort();

  it("every rule is inside the layer and uses tokens for its colours", () => {
    expect(mine.length, "the skeleton shell rules").toBeGreaterThan(8);
    for (const rule of mine) {
      expect(inLayer(rule), `"${rule.selector}" in @layer w6`).toBe(true);
      expect(rule.body, `raw colour in "${rule.selector}"`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    }
  });

  it("no rule in a .navbar or .side selector reaches for the accent (the accent is 2.09:1 on the navy)", () => {
    const onNavy = mine.filter((r) => r.selector.includes(".navbar") || r.selector.includes(".side"));
    expect(onNavy.length, "rules on the navy").toBeGreaterThan(3);
    for (const rule of onNavy) expect(rule.body, `"${rule.selector}"`).not.toMatch(/var\(--accent/);
  });

  it("has a class for every placeholder size the component uses, and none it does not", () => {
    expect(used.length, "size classes in the markup").toBeGreaterThan(3);
    const declared = mine.filter((r) => /^\.sk-[wh]-\d+$/.test(r.selector)).map((r) => r.selector.slice(1)).sort();
    expect(declared).toEqual(used);
    for (const name of used) {
      const [, axis, size] = /^sk-([wh])-(\d+)$/.exec(name)!;
      expect(only(`.${name}`).body, `"${name}"`).toMatch(axis === "w" ? new RegExp(`^\\s*width:\\s*${size}ch;\\s*$`) : new RegExp(`^\\s*height:\\s*${size}px;\\s*$`));
    }
  });

  // The hover fill was 1.17:1 on the navy and could vanish over a remote desktop's colour depth; the active fill is the next step up the same
  // ramp (about 1.3:1): quiet, but there. Still one token, never a colour of its own.
  it("the placeholders on the navy are the sidebar's active colour (one step above the hover fill) and do not shine (a hand-over would restart the sweep)", () => {
    expect(tok("side-bg-active")).not.toBe(tok("side-bg"));
    expect(tok("side-bg-active")).not.toBe(tok("side-bg-hover"));
    expect(tok("side-bg-active")).not.toBe(tok("top-bg"));
    expect(contrast(tok("side-bg-active"), tok("side-bg"))).toBeGreaterThan(contrast(tok("side-bg-hover"), tok("side-bg")));
    expect(contrast(tok("side-bg-active"), tok("top-bg"))).toBeGreaterThan(contrast(tok("side-bg-hover"), tok("top-bg")));
    expect(only(".sk-shell .navbar .sk, .sk-shell .side .sk").body).toMatch(/background:\s*var\(--side-bg-active\)/);
    expect(only(".sk-shell .navbar .sk::after, .sk-shell .side .sk::after").body).toMatch(/display:\s*none/);
  });

  it("the find box has the real field's size, border and ground, drawn after the navy placeholder rule so it wins", () => {
    const find = only(".sk-shell .navbar .sk-find");
    expect(find.body).toMatch(/height:\s*var\(--ctl-h\)/);
    expect(find.body).toMatch(/border:\s*1px solid var\(--top-find-border\)/);
    expect(find.body).toMatch(/background:\s*var\(--top-find-bg\)/);
    expect(find.body).toMatch(/border-radius:\s*var\(--radius\)/);
    expect(find.order).toBeGreaterThan(only(".sk-shell .navbar .sk, .sk-shell .side .sk").order);
  });

  it("a placeholder row takes no pointer and shows no hover colour", () => {
    expect(only(".sk-shell .side-row").body).toMatch(/pointer-events:\s*none/);
    expect(only(".sk-shell .side-row").body).toMatch(/cursor:\s*default/);
  });

  // The bar's right side is empty (the real chip, clock and user block are as wide as their content, so no placeholder width fits every
  // account): the rules that drew a chip, a caret and an avatar are gone, and so is the user block's pointer rule.
  it("has no rule left for a chip, a caret, an avatar or the user block", () => {
    expect(rules.filter((r) => /\.sk-(chip|caret|avatar)(?![\w-])|\.sk-shell\s+\.who(?![\w-])/.test(r.selector))).toEqual([]);
  });

  it("draws the brand name in CSS, so the markup holds no word of it", () => {
    expect(only(".sk-shell .brand .lbl::before").body).toMatch(/content:\s*"DC Dashboard"/);
    expect(markup).not.toContain("DC Dashboard");
  });

  // The static copy in index.html is `hidden`; the stylesheet shows it (an author `display` beats the UA's [hidden]) and hides it again where
  // theme-init.js left <html> without data-shell (the sign-in and setup pages). Every rule below is scoped to `.sk-shell[hidden]`, which
  // React's skeleton never carries, so the two can never disagree on screen.
  describe("the static copy", () => {
    const decls = (body: string) => body.split(";").map((d) => d.trim().replace(/\s+/g, " ")).filter(Boolean).sort();
    const MIN = '.shell[data-sidebar="minimized"]';
    const TWIN = ':root[data-shell="minimized"] .sk-shell[hidden]';

    it("is shown by the shell's own display and hidden again where <html> has no data-shell", () => {
      expect(rules.find((r) => r.selector === ".shell")!.body).toMatch(/display:\s*flex/);
      const hide = only(":root:not([data-shell]) .sk-shell[hidden]");
      expect(hide.body).toMatch(/^\s*display:\s*none;?\s*$/);
      expect(inLayer(hide)).toBe(true);
    });

    // The minimized state is `.shell[data-sidebar="minimized"] <rest>`. The static copy is always data-sidebar="expanded" and takes its
    // state from <html data-shell> instead, so each of those rules the skeleton's classes use has a twin with the same declarations.
    // Not used by the skeleton: the current-page marker and the collapse button.
    const unused = /aria-current|\.side-toggle/;
    const sources = rules.filter((r) => r.selector.split(", ").every((part) => part.startsWith(MIN)) && !unused.test(r.selector));
    const twinOf = (selector: string) => selector.split(", ").map((part) => TWIN + part.slice(MIN.length)).join(", ");

    it("the skeleton uses none of what the twins leave out", () => {
      expect(markup).not.toContain("aria-current");
      expect(markup).not.toContain("side-toggle");
    });

    // If the app's script never runs (a blocked or missing chunk, a stale cached page) the copy would stay for ever and read as a slow load.
    // The hint is CSS content of the copy's main, scoped to `[hidden]` (React's skeleton has none, so it can never show it), invisible for
    // 15 s: an animation delay with `both` holds the first keyframe through the delay. Reduced motion keeps it: a delay is not motion.
    it("says after 15 s that the page is still loading, in CSS content of the static copy's main only", () => {
      const hint = only(".sk-shell[hidden] main::after");
      expect(inLayer(hint)).toBe(true);
      expect(hint.body).toMatch(/content:\s*"Still loading\. If this stays, reload the page\."/);
      expect(hint.body).toMatch(/display:\s*block/);
      expect(hint.body).toMatch(/padding-top:\s*var\(--gutter\)/);
      expect(hint.body).toMatch(/color:\s*var\(--text-2\)/);
      expect(hint.body).toMatch(/font-size:\s*var\(--fs-sm\)/);
      expect(hint.body).toMatch(/opacity:\s*0\s*;/);
      expect(hint.body).toMatch(/animation:\s*sk-hint-in\s+200ms\s+linear\s+15s\s+both\s*;?\s*$/);
      expect(hint.body).not.toMatch(/var\(--accent|var\(--ring/);
      const frames = rules.filter((r) => r.at.some((a) => a === "@keyframes sk-hint-in"));
      expect(frames.map((r) => r.selector).sort()).toEqual(["from", "to"]);
      expect(frames.find((r) => r.selector === "from")!.body).toMatch(/opacity:\s*0/);
      expect(frames.find((r) => r.selector === "to")!.body).toMatch(/opacity:\s*1/);
      for (const frame of frames) expect(inLayer(frame), "keyframe in the layer").toBe(true);
    });

    it("the hint is not in the DOM (the markup holds no sentence) and no other rule can show it", () => {
      expect(markup).not.toContain("Still loading");
      expect(readFileSync("index.html", "utf8")).not.toContain("Still loading");
      expect(rules.filter((r) => r.selector.includes("::after") && r.selector.includes("main") && r.selector.includes("sk-shell")).map((r) => r.selector)).toEqual([".sk-shell[hidden] main::after"]);
      const calm = rules.filter((r) => r.at.some((a) => a.includes("prefers-reduced-motion")) && r.selector.includes("sk-shell"));
      expect(calm, "reduced motion keeps the delay").toEqual([]);
    });

    // The twin guard below only sees rules whose every selector part starts with MIN, in app.css. A minimized rule written any other way
    // (`[data-sidebar="minimized"] .side`, a part of a list that does not start with MIN) or put in another stylesheet would escape it.
    it("every selector that names data-sidebar starts with the form the twin guard reads", () => {
      const named = rules.filter((r) => r.selector.includes("data-sidebar"));
      expect(named.length, "rules that name data-sidebar").toBeGreaterThanOrEqual(7);
      expect(named.filter((r) => !r.selector.split(", ").every((part) => part.startsWith(MIN))).map((r) => r.selector)).toEqual([]);
    });

    it("no other stylesheet under src names data-sidebar (a minimized rule there would have no twin)", () => {
      const sheets: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const path = `${dir}/${name}`;
          if (statSync(path).isDirectory()) walk(path);
          else if (name.endsWith(".css")) sheets.push(path);
        }
      };
      walk("src");
      expect(sheets, "the walk finds the stylesheets").toEqual(expect.arrayContaining(["src/app.css", "src/themes.css"]));
      const naming = sheets.filter((path) => path !== "src/app.css" && stripComments(readFileSync(path, "utf8")).includes("data-sidebar"));
      expect(naming).toEqual([]);
    });

    it("every minimized rule the skeleton uses has a twin with the same declarations", () => {
      expect(sources.length, "the minimized rules").toBeGreaterThanOrEqual(7); // --side-w, the three hides, .brand, .nav-groups, .nav-group + .nav-group, .side-row, .side-foot
      for (const source of sources) {
        const twin = twinOf(source.selector);
        expect(inLayer(source), `"${source.selector}" sits in the layer`).toBe(true);
        const found = rules.filter((r) => r.selector === twin);
        expect(found, `a twin "${twin}"`).toHaveLength(1);
        expect(decls(found[0].body), `declarations of "${twin}"`).toEqual(decls(source.body));
        expect(inLayer(found[0])).toBe(true);
        expect(found[0].order, `"${twin}" after its source`).toBeGreaterThan(source.order);
      }
    });

    it("and there is no twin without a source", () => {
      const twins = rules.filter((r) => r.selector.startsWith(TWIN)).map((r) => r.selector).sort();
      expect(twins).toEqual(sources.map((r) => twinOf(r.selector)).sort());
    });
  });
});

describe("the page card and the page grid (W7j)", () => {
  // jsdom has no layout: the declarations are pinned, the pages were looked at in a browser at 1920, 1440, 1280 and 1024 px.
  it("a form in a card has no 480 px cap and no outer margin (the global form rule would bring both back the moment a form leaves .form-card)", () => {
    const found = rules.filter((r) => r.selector === ".page-card form");
    expect(found, 'exactly one rule for ".page-card form"').toHaveLength(1);
    expect(inLayer(found[0])).toBe(true);
    expect(found[0].body).toMatch(/max-width:\s*none/);
    expect(found[0].body).toMatch(/margin:\s*0\b/);
    const globalForm = rules.find((r) => r.selector === "form")!;
    expect(globalForm.body).toMatch(/max-width:\s*480px/); // what the rule above has to undo
  });

  it("the card and the grid make no containing block and no stacking context: a fixed dialog inside a card and a tip bubble at its edge must not be trapped or clipped", () => {
    const own = rules.filter((r) => ["page-card", "page-grid"].some((cls) => new RegExp(`(^|[\\s,>+~])\\.${cls}(?![\\w-])`).test(r.selector)));
    expect(own.length, "rules for the card and the grid").toBeGreaterThan(3);
    for (const rule of own) {
      expect(rule.body, `"${rule.selector}"`).not.toMatch(/(^|[;\s])(transform|filter|backdrop-filter|contain|will-change|perspective|clip-path|mask|z-index|position)\s*:/);
      expect(rule.body, `"${rule.selector}"`).not.toMatch(/overflow(-[xy])?\s*:\s*(hidden|clip|auto|scroll)/);
    }
  });

  it("the grid is one column, and two equal columns from a viewport of 1280 px", () => {
    const grid = rules.filter((r) => r.selector === ".page-grid");
    const base = grid.filter((r) => r.at.length === 1 && r.at[0] === "@layer w6");
    expect(base).toHaveLength(1);
    expect(base[0].body).toMatch(/display:\s*grid/);
    expect(base[0].body).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    const wide = grid.filter((r) => r.at.includes("@media (min-width: 1280px)"));
    expect(wide).toHaveLength(1);
    expect(wide[0].body).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(wide[0].body).toMatch(/align-items:\s*stretch/);
    expect(rules.find((r) => r.selector === ".page-grid > .span-all")?.body).toMatch(/grid-column:\s*1 \/ -1/);
  });
});
