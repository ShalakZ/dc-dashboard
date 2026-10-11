import { existsSync, readdirSync, readFileSync } from "node:fs";
import { MUTED_FIGURE } from "./lib/widgetFormat";

// vitest is configured with `css: false`, which empties a CSS import, so the stylesheets are read as text.
// Comments go first: one in front of a rule would otherwise become part of its selector.
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const css = stripComments(readFileSync("src/app.css", "utf8")); // vitest runs from the frontend directory

type Rule = { selector: string; body: string; at: string[]; order: number };

/**
 * The style rules of a stylesheet, each with the at-rules it sits in (`@layer w6`, `@media (...)`) and its position.
 * CSS nesting is not used: a `{` after an at-rule header opens a block of rules, any other `{` a declaration block.
 */
function parseRules(text: string): Rule[] {
  const rules: Rule[] = [];
  const at: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      const prelude = text.slice(start, i).trim().replace(/\s+/g, " ");
      if (prelude.startsWith("@")) {
        at.push(prelude);
        start = i + 1;
      } else {
        const end = text.indexOf("}", i);
        rules.push({ selector: prelude, body: text.slice(i + 1, end), at: [...at], order: rules.length });
        i = end;
        start = end + 1;
      }
    } else if (text[i] === "}") {
      at.pop();
      start = i + 1;
    }
  }
  return rules;
}

const rules = parseRules(css);
const inLayer = (rule: Rule) => rule.at.some((a) => a.startsWith("@layer"));

// The tokens: one `:root` block, so a `var(--name)` has one meaning.
const rootRules = rules.filter((r) => r.selector === ":root");
const tokens = new Map<string, string>(
  [...(rootRules[0]?.body ?? "").matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()] as [string, string]),
);
const resolve = (value: string) => value.replace(/var\(--([\w-]+)\)/g, (_, name: string) => tokens.get(name) ?? `<missing --${name}>`);
const HEX = /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/;

// The muted greys are the only text on a tinted or white ground that is meant to look faded; WCAG AA asks 4.5:1 for it.
const AA = 4.5;
const NON_TEXT = 3; // WCAG 1.4.11: the boundary of a control, a focus ring, an indicator

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const full = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex; // #999 is #999999
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (fg: string, bg: string) => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
};

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

  it("a dimmed stat figure reads at 4.5:1 on the white widget", () => {
    expect(contrast(declared(".stat .big.muted", "color"), declared(".widget-frame", "background"))).toBeGreaterThanOrEqual(AA);
  });

  it("the gauge's dimmed figure is the stat's, so it reads at 4.5:1 on the white widget too", () => {
    expect(MUTED_FIGURE).toBe(declared(".stat .big.muted", "color"));
    expect(contrast(MUTED_FIGURE, declared(".widget-frame", "background"))).toBeGreaterThanOrEqual(AA);
  });

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
        // the base input rule (min-height 38px) comes first in the file and has the same weight as ".qf input": the selector must outrank it
        expect(bodyOf(field)).toMatch(/min-height:\s*0/);
        expect(bodyOf(field)).toMatch(/height:\s*34px/);
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
    });
  });
});

describe("long asset names wrap, figures do not", () => {
  /** The selector list of the rule that sets `overflow-wrap: anywhere` in the widget block. */
  const wrapping = [...css.matchAll(/([^{}]+)\{([^{}]*overflow-wrap:\s*anywhere[^{}]*)\}/g)].map((m) => m[1].trim()).join(" | ");
  it("wraps the asset name under a stat figure and the first column of a table widget", () => {
    expect(wrapping).toContain(".stat > .muted:not(.big)");
    expect(wrapping).toContain(".widget-body td:first-child");
  });
  it("does not wrap the dimmed stat figure or the other table cells", () => {
    expect(wrapping).not.toMatch(/\.stat \.muted(?!:)/); // the old rule matched .big.muted too
    expect(wrapping).not.toMatch(/\.widget-body td(?!:first-child)/); // and every cell, including the number column
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
    ["sidebar: navy on the accent brand mark", () => tok("side-bg"), () => tok("side-accent")],
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

describe("the layer and the frozen island", () => {
  const W = ":is(.widget-frame, .widget-preview)";
  // spec section 5 "F" plus the island that keeps the widgets looking as before: unlayered, after the layer block
  const FROZEN = [
    "table.billing td.muted, table.billing td.muted .muted",
    "table.billing td.muted",
    ".dash-grid",
    ".dash-cell",
    ".widget-frame",
    ".widget-head",
    ".widget-head h3",
    ".widget-notes",
    ".widget-body",
    ".widget-body table",
    ".stat .big",
    ".stat .big small",
    ".stat .big.muted",
    ".stat > .muted:not(.big), .widget-body td:first-child",
    ".gauge",
    `${W} .chip`,
    `${W} .chip-warn`,
    ".dash-grid-edit",
    ".dash-grid-edit .widget-drag-handle",
    ".dash-grid-edit .react-grid-item > .react-resizable-handle",
    ".dash-grid-edit .react-grid-item.react-grid-placeholder",
    ".widget-actions",
    ".widget-actions button",
    ".widget-preview",
    W,
    `${W} table`,
    `${W} th, ${W} td`,
    `${W} td.muted`,
    `${W} button`,
    `${W} .widget-actions button`,
    `${W} .chip::before`,
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

  it.each(FROZEN)("%s stays unlayered, after the layer, so no layer rule can outrank it", (selector) => {
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

  it.each(["pages-admin.css", "pages-assets.css", "pages-auth.css", "pages-billing.css", "pages-sources.css"])(
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
    const clashes: string[] = [];
    for (const a of parsed) {
      for (const cls of bareClasses(a.rules)) {
        for (const b of parsed.filter((other) => other.file !== a.file)) {
          if (b.rules.some((r) => classesIn(r.selector).includes(cls))) clashes.push(`.${cls}: bare in ${a.file}, named in ${b.file}`);
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  it("no selector is written in two page files, and no plain class rule is written in both a page file and app.css", () => {
    // (app.css and pages-billing.css split the billing table between them on purpose: a selector there is compared only when it is a plain class)
    const owners = new Map<string, Set<string>>();
    const note = (file: string, list: Rule[], keep: (part: string) => boolean) => {
      for (const r of list) for (const part of selectorParts(r.selector).filter(keep)) owners.set(part, (owners.get(part) ?? new Set()).add(file));
    };
    note("app.css", rules, (part) => /^\.[\w-]+$/.test(part));
    for (const p of parsed) note(p.file, p.rules, () => true);
    const twice = [...owners].filter(([, files]) => files.size > 1).map(([selector, files]) => `${selector}: ${[...files].join(", ")}`);
    expect(twice).toEqual([]);
  });

  it("every selector of a page file names a class (a bare element rule such as td would reach every table)", () => {
    const bare: string[] = [];
    for (const p of parsed) {
      for (const r of p.rules) {
        for (const part of selectorParts(r.selector)) {
          if (classesIn(part).length === 0) bare.push(`${p.file}: ${part}`);
        }
      }
    }
    expect(bare).toEqual([]);
  });

  it("the checks above can see a clash (the helpers are exercised on a small example)", () => {
    const sample = parseRules(".row-actions { display: flex; } td.row-actions, .users-page .row-actions :is(a, b), .x:hover, .y::before { color: red; }");
    expect([...bareClasses(sample)].sort()).toEqual(["row-actions", "users-page", "x", "y"]); // a page root is "bare" too; only it is named in no other file
    expect(selectorParts(".a :is(b, c), d")).toEqual([".a :is(b, c)", "d"]);
    expect(firstCompound(".users-page .row-actions")).toBe(".users-page");
  });
});
