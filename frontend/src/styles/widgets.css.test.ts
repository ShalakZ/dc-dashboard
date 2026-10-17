import { readFileSync } from "node:fs";
import { THEMES } from "../lib/appearance";
import { AA, NON_TEXT, contrast, parseRules, stripComments, type Rule } from "../test/cssTools";
import { baseTokens, cascade, resolveVar } from "../test/themeTools";

// w13: the dashboard widgets follow the theme. Their colours, sizes and corners are the --widget-*, --chart-* and --gauge-* tokens of
// app.css (light) and themes.css (dark); the rules that use them are the one @layer w6 block of styles/widgets.css. vitest runs from the
// frontend directory with `css: false`, so the stylesheets are read as text.
const raw = readFileSync("src/styles/widgets.css", "utf8");
const css = stripComments(raw);
const rules = parseRules(css);
const detailsCss = stripComments(readFileSync("src/styles/widgets-details.css", "utf8"));
const HEX = /^#[0-9a-f]{6}$/;

/** The body of every rule whose selector list is exactly `selector` (joined; a rule may be split by an at-rule). */
const bodyOf = (selector: string, within?: (rule: Rule) => boolean) => rules.filter((r) => r.selector === selector && (!within || within(r))).map((r) => r.body).join(" ");
const layerRules = rules.filter((r) => r.at.every((a) => a.startsWith("@layer")));
const inContainer = (query: string) => (r: Rule) => r.at.some((a) => a.startsWith("@container") && a.includes(query));

// ---------------------------------------------------------------------------------------------------------------------------------
// The Token list of .waves/w13/design-note.md: name, light value, dark value, what the cascade must give <html> in each mode.
// `accent` stands for the look's own accent (the gauge fill follows it).
const SERIES_LIGHT = ["#2563eb", "#c2570c", "#0f8a5f", "#c2307a", "#0e7f9a", "#7c5cd6", "#a16207", "#64748b"];
const SERIES_DARK = ["#6ea8fe", "#f59a52", "#3ecf8e", "#f38bb8", "#4cc9dc", "#b49bff", "#e9c046", "#a3adbd"];
const TOKENS: Array<[name: string, light: string, dark: string]> = [
  ["widget-bg", "#ffffff", "#1c2027"],
  ["widget-border", "#e1e5ec", "#2b313b"],
  ["widget-radius", "6px", "6px"],
  ["widget-shadow", "0 1px 2px rgba(16, 24, 40, 0.06)", "none"],
  ["widget-pad", "12px", "12px"],
  ["widget-head-h", "36px", "36px"],
  ["widget-head-row", "#f6f8fb", "#232830"],
  ["widget-row-h", "32px", "32px"],
  ["widget-figure", "28px", "28px"],
  ["widget-figure-sm", "20px", "20px"],
  ["widget-unit-fs", "13px", "13px"],
  ["widget-handle", "#868fa0", "#6f7888"],
  ["widget-preview-h", "260px", "260px"],
  ...SERIES_LIGHT.map((light, i): [string, string, string] => [`chart-${i + 1}`, light, SERIES_DARK[i]]),
  ["chart-band-opacity", "0.14", "0.22"],
  ["chart-axis-text", "#596579", "#a3abb8"],
  ["chart-axis-line", "#cdd3dd", "#3a414d"],
  ["chart-grid", "#e1e5ec", "#2b313b"],
  ["chart-tip-bg", "#ffffff", "#262b33"],
  ["chart-tip-text", "#172033", "#e4e7ed"],
  ["chart-tip-border", "#cdd3dd", "#4a5261"],
  ["gauge-track", "#e1e5ec", "#2f3541"],
  ["gauge-fill", "accent", "accent"],
  ["gauge-width", "10px", "10px"],
];
const COLOUR_TOKENS = TOKENS.filter(([, light]) => light === "accent" || HEX.test(light)).map(([name]) => name);
const combos = THEMES.flatMap((t) => (["light", "dark"] as const).map((mode) => ({ id: t.id, mode })));

/** The colour `fg` gives when painted at `alpha` over `bg` (the min-max band is the series colour at a low opacity). */
function blend(fg: string, bg: string, alpha: number): string {
  const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [f, b] = [channels(fg), channels(bg)];
  return `#${f.map((c, i) => Math.round(c * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`;
}

describe("the widget tokens (w13)", () => {
  it("the Token list has no angle tokens: the arc is a 180 degree SVG path, its shape a code constant", () => {
    for (const text of [raw, readFileSync("src/app.css", "utf8"), readFileSync("src/themes.css", "utf8")]) expect(text).not.toMatch(/gauge-(start|end)-angle/);
    expect(TOKENS.map(([name]) => name)).not.toContain("gauge-start-angle");
  });

  it("app.css's one :root block defines every token of the list, and the presets (21 tokens each) are untouched", () => {
    for (const [name] of TOKENS) expect(baseTokens.has(name), `--${name} in :root`).toBe(true);
  });

  describe.each(combos)("$id, $mode", ({ id, mode }) => {
    const map = cascade(id, mode);
    const value = (name: string) => resolveVar(map, name);
    const colour = (name: string) => {
      const found = value(name).toLowerCase();
      expect(found, `--${name}`).toMatch(HEX);
      return found;
    };

    it("every token of the list resolves, through its var() chain, to the value the design note gives", () => {
      for (const [name, light, dark] of TOKENS) {
        const expected = mode === "light" ? light : dark;
        const found = value(name).replace(/\s+/g, " ").toLowerCase();
        expect(found, `--${name}`).toBe(expected === "accent" ? value("accent").toLowerCase() : expected);
      }
    });

    it("every colour token resolves to a hex colour", () => {
      for (const name of COLOUR_TOKENS) expect(colour(name), `--${name}`).toMatch(HEX);
    });

    // Text pairs: 4.5:1 (WCAG 1.4.3). The ground of a card is --widget-bg; a tooltip has its own.
    const textPairs: Array<[string, string, string]> = [
      ["the title and the figures (text) on the card", "text", "widget-bg"],
      ["the unit, the asset name, the footer and the age (text-2) on the card", "text-2", "widget-bg"],
      ["the axis labels, the unit name and the legend on the card", "chart-axis-text", "widget-bg"],
      ["the table head (text-2) on its ground", "text-2", "widget-head-row"],
      ["a table row (text) under the pointer", "text", "row-hover"],
      ["a table age (text-2) under the pointer", "text-2", "row-hover"],
      ["the error message on the card", "crit", "widget-bg"],
      ["a stale figure on the card", "stale", "widget-bg"],
      ["a state chip (warning) on its tint", "warn", "warn-tint"],
      ["the tooltip text on the tooltip", "chart-tip-text", "chart-tip-bg"],
      ["the tooltip's secondary line (text-2) on the tooltip", "text-2", "chart-tip-bg"],
    ];
    it.each(textPairs)("%s reads at 4.5:1", (_name, fg, bg) => {
      expect(contrast(colour(fg), colour(bg))).toBeGreaterThanOrEqual(AA);
    });

    // Graphic pairs: 3:1 (WCAG 1.4.11). The words carry the meaning too (the legend, the tooltip), but a mark must still be seen.
    const graphicPairs: Array<[string, string, string]> = [
      ...Array.from({ length: 8 }, (_, i): [string, string, string] => [`series ${i + 1} on the card`, `chart-${i + 1}`, "widget-bg"]),
      ...Array.from({ length: 8 }, (_, i): [string, string, string] => [`series ${i + 1}'s marker on the tooltip`, `chart-${i + 1}`, "chart-tip-bg"]),
      ["the accent on the card (a chart with one series, the hovered edge handle)", "accent", "widget-bg"],
      ["the accent's marker on the tooltip", "accent", "chart-tip-bg"],
      ["the accent on the page (the drop placeholder's dashed edge)", "accent", "bg"],
      ["the gauge's fill on its track", "gauge-fill", "gauge-track"],
      ["the gauge's fill on the card", "gauge-fill", "widget-bg"],
      ["an edge resize handle on the card", "widget-handle", "widget-bg"],
    ];
    it.each(graphicPairs)("%s reads at 3:1", (_name, fg, bg) => {
      expect(contrast(colour(fg), colour(bg))).toBeGreaterThanOrEqual(NON_TEXT);
    });

    it.each(Array.from({ length: 8 }, (_, i) => i + 1))("series %i keeps 3:1 on its own min-max band (the colour at the band opacity over the card)", (n) => {
      const opacity = Number(value("chart-band-opacity"));
      expect(opacity).toBeGreaterThan(0);
      expect(opacity).toBeLessThanOrEqual(0.5);
      const line = colour(`chart-${n}`);
      expect(contrast(line, blend(line, colour("widget-bg"), opacity))).toBeGreaterThanOrEqual(NON_TEXT);
    });

    // Decoration (the value is in the labels, the words and the figures): visible, not asked for 3:1. A line stays a line.
    it("the decorative strokes are visible against the card without being loud (1.2:1 at least)", () => {
      for (const name of ["widget-border", "chart-grid", "chart-axis-line", "gauge-track"]) {
        expect(contrast(colour(name), colour("widget-bg")), `--${name} on the card`).toBeGreaterThanOrEqual(name === "widget-border" ? 1.1 : 1.2);
      }
      expect(colour("chart-axis-line"), "the axis is drawn heavier than the grid").not.toBe(colour("chart-grid"));
    });

    it("the card is told apart from the page by its edge in dark (1.3:1 at least) and is the page's own white in light", () => {
      if (mode === "dark") expect(contrast(colour("widget-border"), colour("bg"))).toBeGreaterThanOrEqual(1.3);
      else expect(colour("widget-bg")).toBe(colour("bg"));
    });

    it("the eight series are eight different colours and none is a status red", () => {
      const series = Array.from({ length: 8 }, (_, i) => colour(`chart-${i + 1}`));
      expect(new Set(series).size).toBe(8);
      for (const status of ["crit", "danger"]) expect(series, `--${status}`).not.toContain(colour(status));
    });

    it("a skeleton inside a card shows against it (1.15:1 at least)", () => {
      expect(contrast(colour("skeleton"), colour("widget-bg"))).toBeGreaterThanOrEqual(1.15);
    });
  });
});

describe("styles/widgets.css", () => {
  it("is one @layer w6 block with nothing outside it and no raw colour (the tokens are the only place a colour is written)", () => {
    expect(css.match(/@layer/g) ?? []).toHaveLength(1);
    const open = css.search(/@layer\s+w6\s*\{/);
    expect(css.slice(0, open).trim(), "text before the block").toBe("");
    expect(css.trimEnd().endsWith("}"), "closed at the end").toBe(true);
    expect(css, "colour literal").not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(css, "no gradient, no italic, no monospace").not.toMatch(/gradient\(|font-style:\s*italic|monospace/);
  });

  it("styles every class of the contract (the TSX tasks write markup only)", () => {
    const named = new Set(rules.flatMap((r) => [...r.selector.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1])));
    for (const cls of [
      "dash-grid", "dash-cell", "dash-grid-edit",
      "widget-frame", "widget-head", "widget-drag-handle", "widget-grip", "widget-title", "widget-chips", "chip-long", "chip-short", "spacer", "widget-tools", "widget-csv-btn", "widget-actions",
      "widget-body", "widget-foot", "widget-since", "widget-hint", "widget-error", "widget-empty", "widget-sk",
      "stat", "big", "stat-num", "stat-unit", "stat-name", "stat-age",
      "widget-table", "num", "cell-age",
      "gauge", "gauge-arc", "gauge-svg", "gauge-track", "gauge-fill", "gauge-scale", "gauge-figure", "gauge-name",
      "widget-chart", "widget-preview",
    ]) expect(named.has(cls), `.${cls}`).toBe(true);
  });

  it("names no class that is gone (.widget-notes, the old h3 title) and writes none of the shared names bare (review M3)", () => {
    expect(css).not.toMatch(/\.widget-notes|\.widget-head h3/);
    for (const rule of rules) {
      for (const part of rule.selector.split(",").map((p) => p.trim())) {
        expect(part, `"${part}" starts with a shared name`).not.toMatch(/^\.(big|num|muted|kv)(?![\w-])|^\.chip/);
        expect(part, `"${part}" is a bare element rule`).toMatch(/\.[A-Za-z_]/);
      }
    }
  });

  describe("the card", () => {
    it("is a size container named widget (the narrow rules are @container rules, never JavaScript), on tokens", () => {
      const body = bodyOf(".widget-frame");
      expect(body).toMatch(/container-type:\s*inline-size/);
      expect(body).toMatch(/container-name:\s*widget/);
      expect(body).toMatch(/background:\s*var\(--widget-bg\)/);
      expect(body).toMatch(/border:\s*1px solid var\(--widget-border\)/);
      expect(body).toMatch(/border-radius:\s*var\(--widget-radius\)/);
      expect(body).toMatch(/box-shadow:\s*var\(--widget-shadow\)/);
      expect(body).toMatch(/height:\s*100%/);
      expect(body, "the resize handles sit on the card's edge").not.toMatch(/overflow/);
    });

    it("the header is 36px of tokens, the title 13px / 600 and an h2 rule that beats .dialog h2 (0,2,0 against 0,1,1, review I6)", () => {
      expect(bodyOf(".widget-head")).toMatch(/height:\s*var\(--widget-head-h\)/);
      const title = rules.filter((r) => /\.widget-title/.test(r.selector));
      expect(title.map((r) => r.selector)).toEqual([".widget-frame .widget-title"]);
      expect(title[0].body).toMatch(/font-size:\s*var\(--fs-sm\)/);
      expect(title[0].body).toMatch(/font-weight:\s*600/);
      expect(title[0].body).toMatch(/text-overflow:\s*ellipsis/);
      expect(title[0].body).toMatch(/margin:\s*0/);
    });

    it("the body takes the card's padding token, the table body none, and the footer is one 22px line", () => {
      expect(bodyOf(".widget-body")).toMatch(/padding:\s*var\(--widget-pad\)/);
      expect(bodyOf(".widget-body")).toMatch(/flex:\s*1/);
      expect(bodyOf(".widget-body")).toMatch(/min-height:\s*0/);
      expect(bodyOf(".widget-body:has(.widget-table)")).toMatch(/padding:\s*0/);
      const foot = bodyOf(".widget-foot");
      expect(foot).toMatch(/min-height:\s*22px/);
      expect(foot).toMatch(/font-size:\s*var\(--fs-xs\)/);
      expect(foot).toMatch(/color:\s*var\(--text-2\)/);
      expect(foot).toMatch(/white-space:\s*nowrap/);
      expect(foot).toMatch(/text-overflow:\s*ellipsis/);
    });

    it("under 200px the CSV button leaves the header and the grip goes; under 280px a chip keeps its count and clips (not hides) its words (review I11)", () => {
      expect(bodyOf(".widget-tools .widget-csv-btn", inContainer("max-width: 199.98px"))).toMatch(/display:\s*none/);
      expect(bodyOf(".widget-grip", inContainer("max-width: 199.98px"))).toMatch(/display:\s*none/);
      const long = bodyOf(".widget-chips .chip-long", inContainer("max-width: 279.98px"));
      expect(long).toMatch(/position:\s*absolute/);
      expect(long).toMatch(/clip:\s*rect\(0 0 0 0\)/);
      expect(long).toMatch(/width:\s*1px/);
      expect(long).not.toMatch(/display:\s*none|visibility:\s*hidden/);
      expect(bodyOf(".widget-chips .chip-short", inContainer("max-width: 279.98px"))).toMatch(/display:\s*(inline|inline-flex)/);
      expect(bodyOf(".widget-chips .chip-short"), "the count shows only on a narrow card").toMatch(/display:\s*none/);
      for (const rule of rules) expect(rule.body, `"${rule.selector}"`).not.toMatch(/visibility:\s*hidden/);
    });

    it("under 280px the footer's 'since' and its dot give way to the marker hint, but only when there is a hint to make room for (whole-wave review, Minor 1)", () => {
      const gone = bodyOf(".widget-foot:has(.widget-hint) :is(.widget-since, .widget-dot)", inContainer("max-width: 279.98px"));
      expect(gone).toMatch(/display:\s*none/);
      expect(bodyOf(".widget-foot .widget-since, .widget-foot .widget-dot"), "outside the container rule they keep their text whole").toMatch(/flex:\s*none/);
      expect(bodyOf(".widget-foot .widget-hint")).toMatch(/flex:\s*0 1 auto/);
    });

    it("a waiting icon button looks disabled and takes the hover wash back, and is never a native :disabled (it may hold the focus the click gave it)", () => {
      expect(bodyOf('.widget-tools .icon-btn[aria-disabled="true"]')).toMatch(/opacity:\s*0\.55/);
      expect(bodyOf('.widget-tools .icon-btn[aria-disabled="true"]')).toMatch(/cursor:\s*not-allowed/);
      expect(bodyOf('.widget-tools .icon-btn[aria-disabled="true"]:hover')).toMatch(/background:\s*none/);
      expect(css).not.toMatch(/:disabled/);
    });

    it("every @container rule uses the container's own name and one of the two thresholds", () => {
      const queries = new Set(rules.flatMap((r) => r.at.filter((a) => a.startsWith("@container"))));
      expect([...queries].sort()).toEqual(["@container widget (max-width: 199.98px)", "@container widget (max-width: 279.98px)"]);
    });

    it("an unknown width never decides a size: the figure is 28px and 20px under 200px, the arc's stroke a fifth thinner (10px and 8px)", () => {
      expect(bodyOf(".stat .big")).toMatch(/font-size:\s*var\(--widget-figure\)/);
      expect(bodyOf(".stat .big", inContainer("max-width: 199.98px"))).toMatch(/font-size:\s*var\(--widget-figure-sm\)/);
      expect(bodyOf(".gauge-figure")).toMatch(/font-size:\s*var\(--widget-figure\)/);
      expect(bodyOf(".gauge-figure", inContainer("max-width: 199.98px"))).toMatch(/font-size:\s*var\(--widget-figure-sm\)/);
      expect(bodyOf(".gauge-track, .gauge-fill")).toMatch(/stroke-width:\s*var\(--gauge-width\)/);
      expect(bodyOf(".gauge-track, .gauge-fill", inContainer("max-width: 199.98px"))).toMatch(/stroke-width:\s*calc\(var\(--gauge-width\) \* 0\.8\)/);
    });
  });

  describe("the figures", () => {
    it("the stat's and the gauge's figure are tabular numbers on a 1.15 line (28px at 1.4 is 39px and breaks the 2-row budget, review M1), never monospace", () => {
      for (const selector of [".stat .big", ".gauge-figure"]) {
        const body = bodyOf(selector);
        expect(body, selector).toMatch(/line-height:\s*1\.15/);
        expect(body, selector).toMatch(/font-variant-numeric:\s*tabular-nums/);
        expect(body, selector).toMatch(/font-weight:\s*600/);
        expect(body, selector).toMatch(/flex-wrap:\s*wrap/);
        expect(body, selector).toMatch(/align-items:\s*baseline/);
      }
    });

    it("a stale figure is --stale, the unit --text-2 at the unit size, and a reading with no data is words, not a figure", () => {
      expect(bodyOf(".stat .big.muted")).toMatch(/color:\s*var\(--stale\)/);
      expect(bodyOf(".stat .stat-unit, .gauge-figure .stat-unit")).toMatch(/font-size:\s*var\(--widget-unit-fs\)/);
      expect(bodyOf(".stat .stat-unit, .gauge-figure .stat-unit")).toMatch(/color:\s*var\(--text-2\)/);
      const none = bodyOf(".stat .big.none, .stat .big[title]");
      expect(none).toMatch(/font-size:\s*var\(--fs-sm\)/);
      expect(none).toMatch(/font-weight:\s*400/);
      expect(none).toMatch(/color:\s*var\(--text-2\)/);
    });

    it("the asset name is one line with an ellipsis (the whole name is in the tooltip and in Details)", () => {
      for (const selector of [".stat-name", ".gauge-name"]) {
        const body = bodyOf(selector);
        expect(body, selector).toMatch(/text-overflow:\s*ellipsis/);
        expect(body, selector).toMatch(/white-space:\s*nowrap/);
        expect(body, selector).toMatch(/color:\s*var\(--text-2\)/);
      }
    });
  });

  describe("the table", () => {
    it("is edge to edge: 7px 12px cells under a row of the row token, the head wraps (review M15) and the value column is right aligned", () => {
      expect(bodyOf(".widget-table td")).toMatch(/padding:\s*7px 12px/);
      expect(bodyOf(".widget-table td")).toMatch(/height:\s*var\(--widget-row-h\)/);
      expect(bodyOf(".widget-table th")).toMatch(/padding:\s*[^;]*12px/);
      expect(bodyOf(".widget-table th")).toMatch(/white-space:\s*normal/);
      expect(bodyOf(".widget-table th")).toMatch(/background:\s*var\(--widget-head-row\)/);
      expect(bodyOf(".widget-table th")).toMatch(/position:\s*sticky/);
      expect(bodyOf(".widget-table :is(th, td).num")).toMatch(/text-align:\s*right/);
      expect(bodyOf(".widget-table :is(th, td).num")).toMatch(/font-variant-numeric:\s*tabular-nums/);
    });

    it("only the first column wraps a long name; the figure never splits and the age may drop under it", () => {
      const wrapping = rules.filter((r) => /overflow-wrap:\s*anywhere/.test(r.body)).map((r) => r.selector);
      expect(wrapping).toEqual([".widget-table td:first-child"]);
      expect(bodyOf(".widget-table .cell-age")).toMatch(/display:\s*inline-block/);
      expect(bodyOf(".widget-table .cell-age")).toMatch(/white-space:\s*nowrap/);
    });
  });

  describe("the gauge", () => {
    it("is a flex column; the arc box fills what is left (a 32px dial and the 16px scale row at least) and the SVG scales with it, its round caps never clipped (review M2)", () => {
      expect(bodyOf(".gauge")).toMatch(/display:\s*flex/);
      expect(bodyOf(".gauge")).toMatch(/flex-direction:\s*column/);
      expect(bodyOf(".gauge-arc")).toMatch(/flex:\s*1/);
      expect(bodyOf(".gauge-arc")).toMatch(/min-height:\s*48px/);
      expect(bodyOf(".gauge-svg")).toMatch(/overflow:\s*visible/);
    });

    it("the scale row is as wide as the DRAWN arc, so 0 and the max sit under its feet at every card size (whole-wave review I1)", () => {
      // The svg is viewBox 0 0 100 52, xMidYMax meet, feet at x = 6 and 94: its drawn width is min(box width, dial height * 100 / 52). The arc box is a size container holding both the dial
      // and the row, and the row is the 88 of those 100 between the feet.
      const arc = bodyOf(".gauge-arc");
      expect(arc).toMatch(/container-type:\s*size/);
      expect(arc, "the row's height is one custom property, shared by the dial's inset and the row").toMatch(/--gauge-scale-h:\s*16px/);
      const svg = bodyOf(".gauge-svg");
      expect(svg).toMatch(/position:\s*absolute/);
      expect(svg, "the dial fills the box above the row").toMatch(/height:\s*calc\(100% - var\(--gauge-scale-h\)\)/);
      const scale = bodyOf(".gauge-scale");
      expect(scale).toMatch(/position:\s*absolute/);
      expect(scale).toMatch(/bottom:\s*0/);
      expect(scale, "centred under the dial").toMatch(/left:\s*50%/);
      expect(scale).toMatch(/transform:\s*translateX\(-50%\)/);
      expect(scale, "a long max grows the row about its centre instead of being cut (re-review m1)").toMatch(/min-width:\s*max-content/);
      expect(scale, "foot to foot: 88% (94 - 6) of the drawn width").toMatch(/width:\s*min\(88cqw, calc\(\(100cqh - var\(--gauge-scale-h\)\) \* 88 \/ 52\)\)/);
      expect(scale).toMatch(/justify-content:\s*space-between/);
    });

    it("draws the track and the fill with the tokens, round caps and a stroke that does not scale with the viewBox", () => {
      const both = bodyOf(".gauge-track, .gauge-fill");
      expect(both).toMatch(/fill:\s*none/);
      expect(both).toMatch(/stroke-linecap:\s*round/);
      expect(both).toMatch(/vector-effect:\s*non-scaling-stroke/);
      expect(bodyOf(".gauge-track")).toMatch(/stroke:\s*var\(--gauge-track\)/);
      expect(bodyOf(".gauge-fill")).toMatch(/stroke:\s*var\(--gauge-fill\)/);
    });
  });

  describe("the chart box", () => {
    it("fills the body and keeps 140px", () => {
      expect(bodyOf(".widget-chart")).toMatch(/height:\s*100%/);
      expect(bodyOf(".widget-chart")).toMatch(/min-height:\s*140px/);
    });
  });

  describe("the editor", () => {
    it("the preview is a stretched block of the preview token, stat and gauge capped at 360px, never fit-content or inline (review M13)", () => {
      const preview = bodyOf(".widget-preview");
      expect(preview).toMatch(/height:\s*var\(--widget-preview-h\)/);
      expect(preview).not.toMatch(/fit-content|inline/);
      const capped = rules.find((r) => r.selector === '.widget-preview[data-type="stat"], .widget-preview[data-type="gauge"]');
      expect(capped?.body).toMatch(/max-width:\s*360px/);
    });

    it("the library's drop placeholder is the accent tint with a 2px dashed accent edge, fully opaque, whatever the sheet's load order (!important in the layer, review I7)", () => {
      const placeholder = bodyOf(".dash-grid-edit .react-grid-item.react-grid-placeholder");
      expect(placeholder).toMatch(/background:\s*var\(--accent-tint\)\s*!important/);
      expect(placeholder).toMatch(/opacity:\s*1\s*!important/);
      expect(placeholder).toMatch(/outline:\s*2px dashed var\(--accent\)\s*!important/);
      expect(placeholder).toMatch(/border-radius:\s*var\(--widget-radius\)\s*!important/);
    });

    it("the resize handles lose the library's arrow image, rotations, margins and black borders, and are drawn with tokens", () => {
      const handle = bodyOf(".dash-grid-edit .react-grid-item > .react-resizable-handle");
      expect(handle).toMatch(/background-image:\s*none\s*!important/);
      expect(handle).toMatch(/transform:\s*none\s*!important/);
      expect(handle).toMatch(/opacity:\s*1\s*!important/);
      const mark = bodyOf(".dash-grid-edit .react-grid-item > .react-resizable-handle::after");
      expect(mark).toMatch(/border:\s*0\s*!important/);
      const corner = bodyOf(".dash-grid-edit .react-grid-item > .react-resizable-handle.react-resizable-handle-se::after");
      expect(corner).toMatch(/width:\s*10px\s*!important/);
      expect(corner).toMatch(/height:\s*10px\s*!important/);
      expect(corner).toMatch(/border-right:\s*2px solid var\(--text-2\)\s*!important/);
      expect(corner).toMatch(/border-bottom:\s*2px solid var\(--text-2\)\s*!important/);
      for (const edge of ["e", "s"]) {
        const bar = bodyOf(`.dash-grid-edit .react-grid-item > .react-resizable-handle.react-resizable-handle-${edge}::after`);
        expect(bar, `${edge} edge`).toMatch(/background:\s*var\(--widget-handle\)\s*!important/);
        expect(bodyOf(`.dash-grid-edit .react-grid-item > .react-resizable-handle.react-resizable-handle-${edge}:hover::after`), `${edge} hover`).toMatch(/background:\s*var\(--accent\)\s*!important/);
      }
      expect(bodyOf(".dash-grid-edit .react-grid-item > .react-resizable-handle.react-resizable-handle-se:hover::after")).toMatch(/border-color:\s*var\(--accent\)\s*!important/);
    });

    it("every declaration that overrides the library is !important (an unlayered sheet beats a layered rule otherwise), and the rest of the file has none", () => {
      const library = layerRules.filter((r) => /react-(grid|resizable)/.test(r.selector));
      expect(library.length, "rules for the library's classes").toBeGreaterThan(5);
      for (const rule of library) {
        const declarations = rule.body.split(";").map((d) => d.trim()).filter(Boolean);
        for (const d of declarations) expect(d, `"${rule.selector}"`).toMatch(/!important$/);
      }
      for (const rule of layerRules.filter((r) => !library.includes(r))) expect(rule.body, `"${rule.selector}"`).not.toContain("!important");
    });

    it("the narrow window's stacked cells beat the inline grid placement (the one other !important)", () => {
      const cell = rules.find((r) => r.selector === ".dash-cell" && r.at.some((a) => a.startsWith("@media")));
      expect(cell?.body).toMatch(/grid-column:\s*auto\s*!important/);
      expect(cell?.body).toMatch(/grid-row:\s*auto\s*!important/);
      expect(cell?.at.join(" ")).toContain("max-width: 700px");
    });
  });

  describe("the grid", () => {
    it("is twelve equal columns that may shrink, and the read-only cells may shrink too", () => {
      expect(bodyOf(".dash-grid")).toMatch(/grid-template-columns:\s*repeat\(12, minmax\(0, 1fr\)\)/);
      expect(bodyOf(".dash-cell")).toMatch(/min-width:\s*0/);
    });

    it("the edit header is the grab area", () => {
      expect(bodyOf(".dash-grid-edit .widget-drag-handle")).toMatch(/cursor:\s*grab/);
    });
  });

  describe("the loading skeleton", () => {
    it("keeps the card's size: a flex column that never scrolls, with the chart shape filling the body", () => {
      const sk = bodyOf(".widget-sk");
      expect(sk).toMatch(/display:\s*flex/);
      expect(sk).toMatch(/flex-direction:\s*column/);
      expect(sk).toMatch(/overflow:\s*hidden/);
      expect(bodyOf('.widget-sk[data-type="timeseries"] .sk-block, .widget-sk[data-type="bar"] .sk-block')).toMatch(/flex:\s*1/);
      expect(bodyOf('.widget-sk[data-type="gauge"] .sk-block')).toMatch(/border-radius:\s*999px 999px 0 0/);
    });
  });
});

describe("styles/widgets-details.css", () => {
  it("is a stub of one @layer w6 block that names only wd-* classes (Task 5b fills it; .kv is pages-admin.css's, review M3)", () => {
    expect(detailsCss.match(/@layer/g) ?? []).toHaveLength(1);
    expect(detailsCss).toMatch(/@layer\s+w6\s*\{/);
    for (const rule of parseRules(detailsCss)) {
      for (const cls of [...rule.selector.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1])) expect(cls, `.${cls} in "${rule.selector}"`).toMatch(/^wd-/);
    }
    expect(detailsCss).not.toMatch(/\.kv(?![\w-])/);
  });
});

describe("the files that load the stylesheet", () => {
  it("main.tsx imports both widget files after app.css and themes.css, so the layer's order is the file order", () => {
    const main = readFileSync("src/main.tsx", "utf8");
    for (const file of ["./styles/widgets.css", "./styles/widgets-details.css"]) {
      expect(main, file).toContain(`import "${file}"`);
      expect(main.indexOf(`import "${file}"`), file).toBeGreaterThan(main.indexOf('import "./themes.css"'));
    }
  });
});
