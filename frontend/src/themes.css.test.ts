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
const ISLAND = ":is(.widget-frame, .widget-preview)";
const BILLING_INK = ':root[data-mode="dark"] table.billing td.muted, :root[data-mode="dark"] table.billing td.muted .muted';
const BILLING_GROUND = ':root[data-mode="dark"] table.billing td.muted';
const PLACEHOLDER = ':root[data-mode="dark"] .dash-grid-edit .react-grid-item.react-grid-placeholder';

/** The tokens the cascade gives an element under <html data-mode data-theme>: the base, the preset, then (dark only) the dark block. */
function cascade(themeId: string, mode: "light" | "dark") {
  const map = new Map(base);
  for (const [name, value] of customProperties(presetRule(themeId).body)) map.set(name, value);
  if (mode === "dark") for (const [name, value] of customProperties(darkRule().body)) map.set(name, value);
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
    ["text on bg", () => tok("text"), () => tok("bg")],
    ["text-2 on bg", () => tok("text-2"), () => tok("bg")],
    ["disabled text on bg", () => tok("text-disabled"), () => tok("bg")],
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
    ["sidebar: the bar's colour on the marker (brand mark)", () => tok("side-bg"), () => tok("side-accent")],
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
  ];
  it.each(nonTextPairs)("%s reads at 3:1", (_name, fg, bg) => {
    expect(contrast(fg(), bg())).toBeGreaterThanOrEqual(NON_TEXT);
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
    expect(PRESET_SET).toHaveLength(20);
    for (const { id } of THEMES) expect(sorted(customProperties(presetRule(id).body).keys()), id).toEqual(PRESET_SET);
  });

  it("writes only hex colours", () => {
    for (const { id } of THEMES) {
      for (const [name, value] of customProperties(presetRule(id).body)) expect(value, `--${name} of ${id}`).toMatch(HEX);
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

describe("the dark block", () => {
  const DARK_SET = sorted(colourTokens.filter((name) => !/^(side-|top-)/.test(name) && name !== "tooltip-text"));

  it("sets every colour token of app.css except the bars' and the tooltip text, and nothing else", () => {
    expect(sorted(customProperties(darkRule().body).keys())).toEqual(DARK_SET);
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
  const ISLAND_SET = () => sorted([...dark().keys()].filter((name) => !["backdrop", "shadow-dialog", "shadow-tip", "shadow-pop", "tooltip-bg"].includes(name)));

  it("re-pins every content token the dark block sets, each to its light value in app.css, and asks for light controls", () => {
    const island = only(ISLAND);
    const pinned = customProperties(island.body);
    expect(sorted(pinned.keys())).toEqual(ISLAND_SET());
    for (const [name, value] of pinned) expect(value, `--${name}`).toBe(base.get(name));
    expect(island.body).toMatch(/(?:^|[;\s])color-scheme:\s*light\s*;/);
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

describe("the file", () => {
  it("is ordered: the four presets, then dark, then the island, then Billing, then the placeholder", () => {
    const order = [...THEMES.map((t) => presetRule(t.id).order), darkRule().order, only(ISLAND).order, only(BILLING_INK).order, only(BILLING_GROUND).order, only(PLACEHOLDER).order];
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
