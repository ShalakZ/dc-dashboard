import { readFileSync } from "node:fs";
import { THEMES } from "./lib/appearance";
import { AA, NON_TEXT, contrast, customProperties, parseRules, stripComments } from "./test/cssTools";

// vitest runs from the frontend directory and reads the stylesheets as text (css: false).
const app = stripComments(readFileSync("src/app.css", "utf8"));
const raw = readFileSync("src/themes.css", "utf8");
const css = stripComments(raw);
const rules = parseRules(css);
const base = customProperties(parseRules(app).filter((r) => r.selector === ":root")[0].body);
const HEX = /^#[0-9a-fA-F]{6}$/;

/** A colour token of app.css: its value is a hex colour, an rgb()/rgba() or a shadow that contains one. */
const colourTokens = [...base].filter(([, value]) => /#|rgb/.test(value)).map(([name]) => name);
const sorted = (names: Iterable<string>) => [...names].sort();

const only = (selector: string) => {
  const found = rules.filter((r) => r.selector === selector);
  expect(found, `exactly one rule for "${selector}"`).toHaveLength(1);
  return found[0];
};
const presetRule = (id: string) => only(`:root[data-theme="${id}"]`);
const darkRule = () => only(':root[data-mode="dark"]');
const comboRule = (id: string, mode: "light" | "dark") => only(`:root[data-theme="${id}"][data-mode="${mode}"]`);
/** The five tokens the content accent is made of. */
const ACCENT_SET = ["accent", "accent-hover", "accent-ink", "accent-tint", "ring"];
// the accent in app.css's :root, and the values the dark block set before W7e (graphite's two looks are these, unchanged)
const GRAPHITE_DARK = new Map([["accent", "#7ea7ff"], ["accent-hover", "#a3c0ff"], ["accent-tint", "#1e2a45"], ["accent-ink", "#b8ceff"], ["ring", "#7ea7ff"]]);
/** CSS specificity of a selector without combinators or pseudo-functions: [ids, classes + attributes + pseudo-classes, types]. */
const specificity = (selector: string): [number, number, number] => [
  (selector.match(/#[\w-]+/g) ?? []).length,
  (selector.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) ?? []).length,
  0,
];
const ISLAND = ":is(.widget-frame, .widget-preview)";
const BILLING_INK = ':root[data-mode="dark"] table.billing td.muted, :root[data-mode="dark"] table.billing td.muted .muted';
const BILLING_GROUND = ':root[data-mode="dark"] table.billing td.muted';
const PLACEHOLDER = ':root[data-mode="dark"] .dash-grid-edit .react-grid-item.react-grid-placeholder';
const AVATAR = ':root[data-mode="dark"] .prof-head .avatar';
const CARD = ':root[data-mode="dark"] .widget-frame';
const ATTRIBUTION = ".graph-canvas .react-flow__attribution a";

/** The tokens the cascade gives an element under <html data-mode data-theme>: the base, the preset, the dark block (dark only), then the look's accent. */
function cascade(themeId: string, mode: "light" | "dark") {
  const map = new Map(base);
  for (const [name, value] of customProperties(presetRule(themeId).body)) map.set(name, value);
  if (mode === "dark") for (const [name, value] of customProperties(darkRule().body)) map.set(name, value);
  for (const [name, value] of customProperties(comboRule(themeId, mode).body)) map.set(name, value);
  return map;
}

const combos = THEMES.flatMap((t) => (["light", "dark"] as const).map((mode) => ({ id: t.id, mode })));

describe.each(combos)("$id, $mode", ({ id, mode }) => {
  const map = cascade(id, mode);
  const tok = (name: string) => {
    const value = map.get(name);
    expect(value, `--${name}`).toMatch(HEX);
    return value!;
  };
  // the text on a primary or danger button is --bg (white in light, the dark page in dark)
  const textPairs: Array<[string, () => string, () => string]> = [
    ["the bg on the accent (primary button)", () => tok("bg"), () => tok("accent")],
    ["accent on bg (link)", () => tok("accent"), () => tok("bg")],
    ["accent on the surface ground (link in a card or a table head)", () => tok("accent"), () => tok("surface")],
    ["the bg on the hovered accent (primary button hover)", () => tok("bg"), () => tok("accent-hover")],
    ["text on bg", () => tok("text"), () => tok("bg")],
    ["text-2 on bg", () => tok("text-2"), () => tok("bg")],
    ["disabled text and a placeholder on bg", () => tok("text-disabled"), () => tok("bg")],
    ["chip ok", () => tok("ok"), () => tok("ok-tint")],
    ["chip warning", () => tok("warn"), () => tok("warn-tint")],
    ["chip critical", () => tok("crit"), () => tok("crit-tint")],
    ["chip info", () => tok("info"), () => tok("info-tint")],
    ["chip stale", () => tok("stale"), () => tok("stale-tint")],
    ["the bg on the danger button", () => tok("bg"), () => tok("danger")],
    ["banner ink on the warning banner", () => tok("warn-ink"), () => tok("warn-bg")],
    ["info banner ink on its tint", () => tok("info-ink"), () => tok("info-tint")],
    ["accent ink on the accent tint (selected, pressed)", () => tok("accent-ink"), () => tok("accent-tint")],
    ["accent on the accent tint (quiet button hover)", () => tok("accent"), () => tok("accent-tint")],
    // W7s: the open tree row has no tint any more, its bold name is on the tree column's ground (--bg) and, hovered, on --surface
    ["accent ink on bg (open tree row)", () => tok("accent-ink"), () => tok("bg")],
    ["accent ink on the surface ground (open tree row, hovered)", () => tok("accent-ink"), () => tok("surface")],
    ["text-2 on the table head ground", () => tok("text-2"), () => tok("surface")],
    ["error text on bg", () => tok("crit"), () => tok("bg")],
    ["warning text on bg", () => tok("warn-ink"), () => tok("bg")],
    ["text on a conflict row", () => tok("text"), () => tok("crit-tint")],
    ["sidebar: strong text on the bar", () => tok("side-text-strong"), () => tok("side-bg")],
    ["sidebar: link text on the bar", () => tok("side-text"), () => tok("side-bg")],
    ["sidebar: link text on the hover fill", () => tok("side-text"), () => tok("side-bg-hover")],
    ["sidebar: hover text on the hover fill", () => tok("side-text-strong"), () => tok("side-bg-hover")],
    ["sidebar: group heading on the plain bar", () => tok("side-muted"), () => tok("side-bg")],
    ["sidebar: active item", () => tok("side-text-strong"), () => tok("side-bg-active")],
    ["sidebar: marker on the bar (focus ring, indicator)", () => tok("side-accent"), () => tok("side-bg")],
    ["sidebar: the bar's colour on the marker", () => tok("side-bg"), () => tok("side-accent")],
    ["sidebar: avatar", () => tok("side-avatar-text"), () => tok("side-avatar-bg")],
    ["tooltip", () => tok("tooltip-text"), () => tok("tooltip-bg")],
    ["top bar: strong text on the bar (brand, site time, user name)", () => tok("side-text-strong"), () => tok("top-bg")],
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

  // A placeholder sits on a field's own ground (bg); only a disabled field has the surface under it, and WCAG exempts the text of an inactive
  // control. In light that pair is 4.43:1 (today's token, kept as it is), so it is held for the dark block, where the review measured it.
  if (mode === "dark") {
    it("a placeholder in a disabled field (on the surface) reads at 4.5:1", () => {
      expect(contrast(tok("text-disabled"), tok("surface"))).toBeGreaterThanOrEqual(AA);
    });
  }

  const nonTextPairs: Array<[string, () => string, () => string]> = [
    ["sidebar: marker on the active fill", () => tok("side-accent"), () => tok("side-bg-active")],
    ["a field's border on bg", () => tok("field-border"), () => tok("bg")],
    ["a field's border on the surface ground", () => tok("field-border"), () => tok("surface")],
    ["top bar: the live dot on the chip ground", () => tok("top-live"), () => tok("top-find-bg")],
    ["top bar: the stale ring and offline diamond on the chip ground", () => tok("top-stale"), () => tok("top-find-bg")],
    ["top bar: strong text on the bar, as a mark rather than text", () => tok("side-text-strong"), () => tok("top-bg")],
    ["top bar: the quick find's border on the bar (its outer edge)", () => tok("top-find-border"), () => tok("top-bg")],
    ["top bar: the quick find's border on the field ground (its inner edge)", () => tok("top-find-border"), () => tok("top-find-bg")],
    ["quick find: the active option's ring on the popup", () => tok("accent"), () => tok("bg")],
    ["the ring on bg (focus ring)", () => tok("ring"), () => tok("bg")],
    ["the ring on the accent tint (focus ring on a selected row, the active quick-find option)", () => tok("ring"), () => tok("accent-tint")],
    ["the frame on the accent tint (a picked tree row; the open row has no tint)", () => tok("accent"), () => tok("accent-tint")],
    ["the top bar's loading bar on the bar (its marker colour)", () => tok("side-accent"), () => tok("top-bg")],
  ];
  it.each(nonTextPairs)("%s reads at 3:1", (_name, fg, bg) => {
    expect(contrast(fg(), bg())).toBeGreaterThanOrEqual(NON_TEXT);
  });

  it("the skeleton shows against the page and against the surface (1.15:1 at least) and is no accent", () => {
    for (const ground of ["bg", "surface"]) expect(contrast(tok("skeleton"), tok(ground)), `--skeleton on --${ground}`).toBeGreaterThanOrEqual(1.15);
    const accents = ACCENT_SET.map((name) => tok(name).toLowerCase());
    for (const name of ["skeleton", "skeleton-shine"]) expect(accents, `--${name} is not an accent value`).not.toContain(tok(name).toLowerCase());
    expect(tok("skeleton-shine")).not.toBe(tok("skeleton"));
  });

  it("the tooltip is told apart from the page (1.5:1 at least)", () => {
    expect(contrast(tok("tooltip-bg"), tok("bg"))).toBeGreaterThanOrEqual(1.5);
  });

  it("the top bar is the sidebar's colour, so the two form one L", () => {
    expect(tok("top-bg")).toBe(tok("side-bg"));
  });
});

describe("the presets", () => {
  // every base token that is a colour and belongs to the bars, the avatar or the tooltip
  const PRESET_SET = sorted(colourTokens.filter((name) => /^(side|top|tooltip)-/.test(name)));

  it("sets exactly the colours of the sidebar, the top bar and the tooltip, the same set in every preset", () => {
    expect(PRESET_SET).toHaveLength(21);
    for (const { id } of THEMES) expect(sorted(customProperties(presetRule(id).body).keys()), id).toEqual(PRESET_SET);
  });

  // W7n: the owner's mark is a fixed gold image on the bar. Where the bar's colour is too close to it the square's edge would vanish
  // (desert-gold's bar is 1.23:1 against it), so the bar draws a keyline in --top-brand-edge; the other bars need none, and their
  // keyline is the bar's own colour (invisible).
  describe("the brand mark's gold against each bar", () => {
    const GOLD = "#D29E12";
    it.each(THEMES.map((t) => t.id))("%s: the square reads at 3:1 on the bar, or its keyline does", (id) => {
      const preset = customProperties(presetRule(id).body);
      const bar = preset.get("top-bg")!;
      expect(preset.get("top-brand-edge"), `--top-brand-edge of ${id}`).toMatch(HEX);
      expect(contrast(GOLD, bar) >= NON_TEXT || contrast(preset.get("top-brand-edge")!, bar) >= NON_TEXT, `${id}: gold ${contrast(GOLD, bar).toFixed(2)}:1, keyline ${contrast(preset.get("top-brand-edge")!, bar).toFixed(2)}:1`).toBe(true);
    });

    it("desert-gold's keyline is #6e5700 and the other three equal their bar", () => {
      expect(customProperties(presetRule("desert-gold").body).get("top-brand-edge")).toBe("#6e5700");
      for (const id of ["navy-gold", "maroon-gold", "graphite"]) {
        const preset = customProperties(presetRule(id).body);
        expect(preset.get("top-brand-edge"), id).toBe(preset.get("top-bg"));
      }
    });
  });

  it("writes only hex colours", () => {
    for (const { id } of THEMES) {
      for (const [name, value] of customProperties(presetRule(id).body)) expect(value, `--${name} of ${id}`).toMatch(HEX);
    }
  });

  it("sets no accent token (the look's own block does, at a higher weight)", () => {
    for (const { id } of THEMES) {
      const names = [...customProperties(presetRule(id).body).keys()];
      expect(names.filter((name) => ACCENT_SET.includes(name)), id).toEqual([]);
    }
  });

  it("navy and gold is today's navy with gold markers: only the marker, the brand mark and the avatar differ from app.css", () => {
    const navy = customProperties(presetRule("navy-gold").body);
    const changed = [...navy].filter(([name, value]) => base.get(name) !== value).map(([name]) => name);
    expect(sorted(changed)).toEqual(["side-accent", "side-avatar-bg", "side-avatar-text"]);
    expect(navy.get("side-accent")).toBe("#deb406");
  });

  it("each theme's swatch is the preset's panel colour with its marker colour as the dot", () => {
    for (const theme of THEMES) {
      const preset = customProperties(presetRule(theme.id).body);
      expect(theme.swatch.bg, theme.id).toBe(preset.get("side-bg"));
      expect(theme.swatch.dot, theme.id).toBe(preset.get("side-accent"));
    }
  });
});

describe("the accent blocks (one per theme and mode)", () => {
  it("each sets exactly the five accent tokens, as hex colours, with --ring equal to --accent", () => {
    for (const { id, mode } of combos) {
      const tokens = customProperties(comboRule(id, mode).body);
      expect(sorted(tokens.keys()), `${id} ${mode}`).toEqual(ACCENT_SET);
      for (const [name, value] of tokens) expect(value, `--${name} of ${id} ${mode}`).toMatch(HEX);
      expect(tokens.get("ring"), `${id} ${mode}`).toBe(tokens.get("accent"));
    }
  });

  it("graphite keeps today's blue: app.css's values in light, the dark block's old values in dark", () => {
    const light = customProperties(comboRule("graphite", "light").body);
    for (const name of ACCENT_SET) expect(light.get(name), `--${name}`).toBe(base.get(name));
    const dark = customProperties(comboRule("graphite", "dark").body);
    for (const [name, value] of GRAPHITE_DARK) expect(dark.get(name), `--${name}`).toBe(value);
  });

  it("outweigh the presets and the dark block, so no two blocks set the same accent token at equal weight", () => {
    const weight = (selector: string) => specificity(selector).join(".");
    expect(weight(darkRule().selector)).toBe("0.2.0");
    for (const { id } of THEMES) expect(weight(presetRule(id).selector), id).toBe("0.2.0");
    for (const { id, mode } of combos) expect(weight(comboRule(id, mode).selector), `${id} ${mode}`).toBe("0.3.0");
  });

  it("leave the bars and the tooltip to the preset (no side-, top- or tooltip- token)", () => {
    for (const { id, mode } of combos) {
      const names = [...customProperties(comboRule(id, mode).body).keys()];
      expect(names.filter((name) => /^(side|top|tooltip)-/.test(name)), `${id} ${mode}`).toEqual([]);
    }
  });

  it("come after the dark block", () => {
    for (const { id, mode } of combos) expect(comboRule(id, mode).order, `${id} ${mode}`).toBeGreaterThan(darkRule().order);
  });
});

describe("the dark block", () => {
  const DARK_SET = sorted(colourTokens.filter((name) => !/^(side-|top-)/.test(name) && name !== "tooltip-text" && !ACCENT_SET.includes(name)));

  it("sets every colour token of app.css except the bars', the tooltip text and the accent (the accent blocks set that), and nothing else", () => {
    expect(sorted(customProperties(darkRule().body).keys())).toEqual(DARK_SET);
  });

  it("sets both skeleton tokens, as hex colours that differ from app.css's light ones", () => {
    const tokens = customProperties(darkRule().body);
    for (const name of ["skeleton", "skeleton-shine"]) {
      expect(tokens.get(name), `--${name}`).toMatch(HEX);
      expect(tokens.get(name), `--${name}`).not.toBe(base.get(name));
    }
  });

  it("asks for dark scroll bars, date pickers and selects", () => {
    expect(darkRule().body).toMatch(/(?:^|[;\s])color-scheme:\s*dark\s*;/);
  });

  it("the page is a dark grey: never pure black, never a tint that leans warm", () => {
    const bg = customProperties(darkRule().body).get("bg")!;
    expect(bg).toMatch(HEX);
    expect(bg).not.toBe("#000000");
    const [r, , b] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
    expect(b).toBeGreaterThanOrEqual(r);
  });

  it("the tooltip ground is the only token a preset and the dark block both set, and dark comes after every preset so it wins", () => {
    const dark = darkRule();
    const darkNames = new Set(customProperties(dark.body).keys());
    for (const { id } of THEMES) {
      const preset = presetRule(id);
      expect(sorted([...customProperties(preset.body).keys()].filter((name) => darkNames.has(name))), id).toEqual(["tooltip-bg"]);
      expect(dark.order, `dark after ${id}`).toBeGreaterThan(preset.order);
    }
  });

  it("is lighter than the page for the tooltip, and the tooltip text still reads on it", () => {
    const tooltipBg = customProperties(darkRule().body).get("tooltip-bg")!;
    expect(contrast(tooltipBg, customProperties(darkRule().body).get("bg")!)).toBeGreaterThanOrEqual(1.5);
    expect(contrast(base.get("tooltip-text")!, tooltipBg)).toBeGreaterThanOrEqual(AA);
  });
});

describe("the widget island", () => {
  const dark = () => customProperties(darkRule().body);
  // the dark block's content tokens plus the five accent tokens, which the look's accent block sets on <html> and the island must undo
  const ISLAND_SET = () => sorted([...[...dark().keys()].filter((name) => !["backdrop", "shadow-dialog", "shadow-tip", "shadow-pop", "tooltip-bg"].includes(name)), ...ACCENT_SET]);

  it("re-pins every content token the dark block sets and the five accent tokens, each to its light value in app.css, and asks for light controls", () => {
    const island = only(ISLAND);
    const pinned = customProperties(island.body);
    expect(sorted(pinned.keys())).toEqual(ISLAND_SET());
    for (const [name, value] of pinned) expect(value, `--${name}`).toBe(base.get(name));
    expect(island.body).toMatch(/(?:^|[;\s])color-scheme:\s*light\s*;/);
  });

  it("re-pins both skeleton tokens to their light values (a widget keeps a light card, and a skeleton inside it a light grey)", () => {
    const pinned = customProperties(only(ISLAND).body);
    for (const name of ["skeleton", "skeleton-shine"]) {
      expect(pinned.get(name), `--${name}`).toMatch(HEX);
      expect(pinned.get(name), `--${name}`).toBe(base.get(name));
    }
  });

  it("comes after the dark block, so it wins on an element inside a widget", () => {
    expect(only(ISLAND).order).toBeGreaterThan(darkRule().order);
  });
});

describe("the Billing muted cell", () => {
  const colourOf = (selector: string, property: string) => {
    const value = new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+)`).exec(only(selector).body)?.[1].trim();
    expect(value, `${property} of "${selector}"`).toMatch(HEX);
    return value!;
  };

  it("reads at 4.5:1 in dark, where app.css's grey literals (a light cell) would not be told from the page", () => {
    expect(contrast(colourOf(BILLING_INK, "color"), colourOf(BILLING_GROUND, "background"))).toBeGreaterThanOrEqual(AA);
  });

  it("is still shaded against the dark page", () => {
    const page = customProperties(darkRule().body).get("bg")!;
    expect(contrast(colourOf(BILLING_GROUND, "background"), page)).toBeGreaterThanOrEqual(1.1);
  });

  it("outranks app.css's rule for the cell (more specific, and later)", () => {
    expect(only(BILLING_GROUND).order).toBeGreaterThan(only(ISLAND).order);
  });
});

describe("the editor's drag placeholder", () => {
  it("is white in dark (app.css freezes it black, 1.18:1 on the dark page), well apart from the page", () => {
    const fill = /(?:^|;|\s)background:\s*([^;]+)/.exec(only(PLACEHOLDER).body)?.[1].trim();
    expect(fill).toBe("#fff");
    expect(contrast("#ffffff", customProperties(darkRule().body).get("bg")!)).toBeGreaterThanOrEqual(NON_TEXT);
  });

  it("outranks app.css's rule for it (more specific, and later)", () => {
    expect(only(PLACEHOLDER).order).toBeGreaterThan(darkRule().order);
    expect(only(PLACEHOLDER).order).toBeGreaterThan(only(ISLAND).order);
  });
});

describe("the avatar in the open profile panel", () => {
  it("gets a hairline in dark, for the presets whose avatar ground is the page's own (desert gold 1.05:1, graphite 1.87:1)", () => {
    expect(only(AVATAR).body).toMatch(/box-shadow:\s*0 0 0 1px var\(--border-strong\)/);
    expect(only(AVATAR).order).toBeGreaterThan(darkRule().order);
  });
});

describe("the widget cards in dark", () => {
  it("lose the frozen black border (invisible on the dark page) and get rounded corners, without clipping the resize handles", () => {
    const body = only(CARD).body;
    expect(body).toMatch(/border-color:\s*transparent/);
    expect(body).toMatch(/border-radius:\s*var\(--radius\)/);
    expect(body).not.toMatch(/overflow/);
  });

  it("comes after the island and outranks app.css's .widget-frame (more specific, and later)", () => {
    expect(only(CARD).order).toBeGreaterThan(only(ISLAND).order);
  });
});

describe("the graph's credit link", () => {
  it("reads in --text-2 (React Flow's own #999 is 2.68:1 on the surface), set here because its stylesheet is unlayered and would beat a layered rule", () => {
    expect(only(ATTRIBUTION).body).toMatch(/color:\s*var\(--text-2\)/);
  });
});

describe("the file", () => {
  it("is ordered: the four presets, then dark, the eight accent blocks, the avatar, the island, the cards, then Billing, then the placeholder", () => {
    const order = [
      ...THEMES.map((t) => presetRule(t.id).order), darkRule().order, ...combos.map(({ id, mode }) => comboRule(id, mode).order), only(AVATAR).order, only(ISLAND).order, only(CARD).order,
      only(BILLING_INK).order, only(BILLING_GROUND).order, only(PLACEHOLDER).order, only(ATTRIBUTION).order,
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(rules).toHaveLength(order.length);
  });

  it("is unlayered and has no !important (the layer's rules lose to it by being layered; nothing here needs more)", () => {
    expect(css).not.toContain("@layer");
    expect(css).not.toContain("!important");
  });

  it("opens with a comment that names its role and says it is the one place for raw colours", () => {
    expect(raw.trimStart().startsWith("/*")).toBe(true);
    expect(raw.slice(0, raw.indexOf("*/"))).toMatch(/raw colours/i);
  });

  it("is imported after app.css, so it comes after the frozen Billing rule it overrides", () => {
    const main = readFileSync("src/main.tsx", "utf8");
    expect(main.indexOf('import "./themes.css"')).toBeGreaterThan(main.indexOf('import "./app.css"'));
    expect(main).toContain('import "./themes.css"');
  });

  it("uses no hard-banned look: no italic, no monospace, no gradient", () => {
    expect(css).not.toMatch(/font-style:\s*italic|monospace|gradient\(/);
  });
});
