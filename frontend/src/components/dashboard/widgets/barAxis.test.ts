// P1 (w14): the category axis of a bar chart wraps its labels instead of letting neighbours collide. The module is pure, so everything here
// runs without a canvas; barAxis.ssr.test.ts then draws the same layouts with the real chart library.
import { chartLabels, shortLabels } from "../../../lib/widgetFormat";
import { valueRow } from "../../../test/dashboardFixtures";
import {
  AXIS_CHARS, barAxisLayout, DEFAULT_CHART_HEIGHT, DEFAULT_CHART_WIDTH, GRID_SIDES_PX, LABEL_LINE_PX, LABEL_LINES, MIN_SLOT_PX, MIN_TURNED_CHARS, nameGapFor, PLOT_MIN_PX, PLOT_SHARE,
  SLOT_GAP_PX, steppedHeight, steppedWidth, textPx, TOP_PX, wrapLabel,
} from "./barAxis";

// The names of the w13 showcase (e2e/w13Showcase.ts SIX), as chartLabels builds them: the second is estimated.
const SIX = chartLabels([
  valueRow({ name: "Rack A01" }), valueRow({ name: "Rack A02", estimated: true }), valueRow({ name: "UPS-1 output" }),
  valueRow({ name: "CRAH-3 supply fan" }), valueRow({ name: "Chiller plant 2 condenser loop" }), valueRow({ name: "PDU B07" }),
]);
const lines = (text: string) => text.split("\n");
const slotOf = (count: number, width: number) => (width - GRID_SIDES_PX) / count;
// Measured in Chromium (canvas measureText, "12px sans-serif", the font ECharts draws labels in; .waves/w14/f1/corpus.mjs), to 0.01 px.
// Every printable ASCII character:
const REAL_CHAR_PX: Record<string, number> = {
  "0": 6.67, "1": 6.67, "2": 6.67, "3": 6.67, "4": 6.67, "5": 6.67, "6": 6.67, "7": 6.67,
  "8": 6.67, "9": 6.67, " ": 3.33, "!": 3.33, "\"": 4.26, "#": 6.67, "$": 6.67, "%": 10.67,
  "&": 8.00, "'": 2.29, "(": 4.00, ")": 4.00, "*": 4.67, "+": 7.01, ",": 3.33, "-": 4.00,
  ".": 3.33, "/": 3.33, ":": 3.33, ";": 3.33, "<": 7.01, "=": 7.01, ">": 7.01, "?": 6.67,
  "@": 12.18, "A": 8.00, "B": 8.00, "C": 8.67, "D": 8.67, "E": 8.00, "F": 7.33, "G": 9.33,
  "H": 8.67, "I": 3.33, "J": 6.00, "K": 8.00, "L": 6.67, "M": 10.00, "N": 8.67, "O": 9.33,
  "P": 8.00, "Q": 9.33, "R": 8.67, "S": 8.00, "T": 7.33, "U": 8.67, "V": 8.00, "W": 11.33,
  "X": 8.00, "Y": 8.00, "Z": 7.33, "[": 3.33, "\\": 3.33, "]": 3.33, "^": 5.63, "_": 6.67,
  "`": 4.00, "a": 6.67, "b": 6.67, "c": 6.00, "d": 6.67, "e": 6.67, "f": 3.33, "g": 6.67,
  "h": 6.67, "i": 2.67, "j": 2.67, "k": 6.00, "l": 2.67, "m": 10.00, "n": 6.67, "o": 6.67,
  "p": 6.67, "q": 6.67, "r": 4.00, "s": 6.00, "t": 3.33, "u": 6.67, "v": 6.00, "w": 8.67,
  "x": 6.00, "y": 6.00, "z": 6.00, "{": 4.01, "|": 3.12, "}": 4.01, "~": 7.01,
};
// Names, words and the pieces a name breaks into (after - _ /), as the wrap tries them:
const REAL_TEXT_PX: Record<string, number> = {
  "CRAH-3": 44.67,
  "CRAH-3 supply fan": 102.71,
  "CRAH-3 SUPPLY FAN": 121.14,
  "Rack A01": 52.03,
  "Rack": 27.34,
  "A01": 21.35,
  "PDU B07": 50.02,
  "UPS-1": 35.34,
  "UPS-1 output": 72.04,
  "output": 33.36,
  "supply": 34.69,
  "Chiller": 34.01,
  "condenser": 56.04,
  "Switchboard": 66.04,
  "MV2-R2-LV-PANEL-02": 120.93,
  "MV2-": 28.67,
  "PANEL-": 42.46,
  "Distribution panel number 12": 153.42,
  "Main feeder room A01 east hall": 166.76,
  "Zone 1 West Wing": 98.48,
  "Transformer T1 (11kV)": 120.02,
  "Rack A01 (#7) ~ *": 95.04,
  "ATS-1 *": 41.12,
  "Server room # 4 ~": 96.38,
  "Chiller_01_supply": 95.39,
  "Rack_B07_PDU_1": 100.72,
  "Illinois Ill": 45.35,
  "WWWW MMMM": 88.62,
  "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG": 315.36,
  "The quick brown fox jumps over the lazy dog": 237.45,
  "Hall B / Row 4 / Rack 12": 130.05,
  "Busbar BB/3": 67.37,
  "Cold aisle containment 2B": 139.41,
  "AB12-CD34/EF56_GH78": 134.07,
  "Pump house": 67.38,
  "Gen-set 2": 52.69,
  "Level 2 / Zone C": 88.05,
};

describe("textPx, the calibrated width estimate of a 12 px label", () => {
  it("is 0 for nothing and adds 3 percent to the sum of its classes", () => {
    expect(textPx("")).toBe(0);
    expect(textPx("a")).toBeCloseTo(6.68 * 1.03, 5); // lower case
    expect(textPx("A")).toBeCloseTo(8.01 * 1.03, 5); // upper case
    expect(textPx("7")).toBeCloseTo(6.68 * 1.03, 5); // digit
    expect(textPx("-")).toBeCloseTo(4.01 * 1.03, 5); // a hyphen is a narrow mark, not a letter
    expect(textPx("ijl'")).toBeCloseTo(4 * 2.67 * 1.03, 5); // narrow
    expect(textPx("mM")).toBeCloseTo(2 * 10 * 1.03, 5); // wide
    expect(textPx("W")).toBeCloseTo(11.33 * 1.03, 5);
    expect(textPx("@")).toBeCloseTo(12.19 * 1.03, 5);
    expect(textPx(" ")).toBeCloseTo(3.34 * 1.03, 5);
    expect(textPx("#()~*")).toBeCloseTo((6.68 + 4.01 + 4.01 + 7.01 + 4.67) * 1.03, 5); // the marks of a suffix
    expect(textPx("é")).toBeCloseTo(8.6 * 1.03, 5); // a character no class knows is counted wide
  });

  it("counts a code point once, so an emoji is one wide character and not two", () => {
    expect(textPx("😀")).toBeCloseTo(8.6 * 1.03, 5);
  });

  it("knows every printable ASCII character, and is never narrower than the real width of one (so never narrower than a text made of them)", () => {
    for (const [char, px] of Object.entries(REAL_CHAR_PX)) {
      expect(textPx(char), `width of "${char}"`).toBeGreaterThanOrEqual(px);
      expect(textPx(char), `"${char}" is in a class of its own, not the fallback`).not.toBeCloseTo(8.6 * 1.03, 5);
    }
  });

  it("is within 12 percent above the real width of a letter, digit, space or hyphen (the old estimate was 30 percent above for a digit and 115 for a hyphen)", () => {
    for (const char of Array.from("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -")) {
      expect(textPx(char) / REAL_CHAR_PX[char], `"${char}"`).toBeLessThanOrEqual(1.12);
    }
  });

  it("is never narrower than the real width of a name, a word or a break piece, and at most 8 percent above it", () => {
    for (const [text, px] of Object.entries(REAL_TEXT_PX)) {
      expect(textPx(text), `"${text}" is ${px} px`).toBeGreaterThanOrEqual(px);
      expect(textPx(text) / px, `"${text}"`).toBeLessThanOrEqual(1.08);
    }
  });

  it("is never narrower than the widest character of its class in the width table ECharts itself measures with (zrender's, as a share of 12 px)", () => {
    // The widest of each class in that table: W M m w, the round capitals, the other capitals, the digits, @ % and the marks of a suffix.
    const widest: Record<string, number> = { W: 0.94, M: 0.83, m: 0.83, w: 0.72, G: 0.78, O: 0.78, Q: 0.78, C: 0.72, D: 0.72, H: 0.72, a: 0.56, e: 0.56, "0": 0.56, "@": 1.02, "%": 0.89, "&": 0.67, "~": 0.58, "#": 0.56, "-": 0.33 };
    for (const [char, em] of Object.entries(widest)) expect(textPx(char), `width of ${char}`).toBeGreaterThanOrEqual(em * 12);
  });
});

describe("wrapLabel", () => {
  const PX = 58;

  it("keeps a name that fits as one line, words and all", () => {
    expect(wrapLabel("PDU B07", 80, LABEL_LINES)).toEqual(["PDU B07"]);
  });

  it("breaks between words, a line holding as many words as fit", () => {
    expect(wrapLabel("UPS-1 output", PX, LABEL_LINES)).toEqual(["UPS-1", "output"]);
  });

  it("cuts a word that is wider than a line by characters, with no space invented inside it", () => {
    const out = wrapLabel("Switchboard", 40, LABEL_LINES);
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((line) => textPx(line) <= 40)).toBe(true);
    expect(out.join("")).toBe("Switchboard");
  });

  it("cuts the part that does not fit in the middle of the last line, with the ellipsis, and ends with the end of the name", () => {
    const name = "Main-Switchboard-Feeder-Room-East-Hall-3-Distribution-Panel-Block";
    expect(Array.from(name).length).toBeGreaterThanOrEqual(60);
    const out = wrapLabel(name, PX, LABEL_LINES);
    expect(out).toHaveLength(LABEL_LINES);
    expect(out[LABEL_LINES - 1]).toContain("…");
    expect(out[LABEL_LINES - 1].endsWith("k")).toBe(true); // the end of the name is kept
    expect(out.every((line) => textPx(line) <= PX)).toBe(true);
  });

  it("breaks after a hyphen, underscore or slash when the word does not fit, and keeps what comes before the break whole", () => {
    expect(wrapLabel("MV2-R2-LV-PANEL-02", 70, LABEL_LINES)).toEqual(["MV2-R2-LV-", "PANEL-02"]);
    expect(wrapLabel("MV2-R2-LV-PANEL-02", 64, LABEL_LINES)).toEqual(["MV2-R2-", "LV-", "PANEL-02"]);
    expect(wrapLabel("pump_room/east_wing", 70, LABEL_LINES).join("")).toBe("pump_room/east_wing");
  });

  it("does not break 'CRAH-3' where the width estimate once did: the name fits a 58 px line, and so does 'Rack A01'", () => {
    expect(wrapLabel("CRAH-3 supply fan", PX, LABEL_LINES)).toEqual(["CRAH-3", "supply fan"]);
    expect(wrapLabel("Rack A01", PX, LABEL_LINES)).toEqual(["Rack A01"]);
    expect(wrapLabel("PDU B07", PX, LABEL_LINES)).toEqual(["PDU B07"]);
  });

  it("never leaves a lone one- or two-character piece under a line that ends in a hyphen: it joins the piece before it on the next line", () => {
    // "Chiller CRAH-" fits 80 px, "Chiller CRAH-3" does not: the 3 does not stay behind alone, "CRAH-3" moves down whole.
    expect(wrapLabel("Chiller CRAH-3", 80, LABEL_LINES)).toEqual(["Chiller", "CRAH-3"]);
    expect(wrapLabel("Chiller CRAH-12", 80, LABEL_LINES)).toEqual(["Chiller", "CRAH-12"]);
    // Three characters after the hyphen are a piece of their own again.
    expect(wrapLabel("Chiller CRAH-123", 80, LABEL_LINES)).toEqual(["Chiller CRAH-", "123"]);
    // The joined piece must fit a line by itself; otherwise the break after the hyphen stays (the old behaviour).
    expect(wrapLabel("Switchboard-7", 40, LABEL_LINES).join("")).toBe("Switchboard-7");
  });

  it("keeps the '~' suffix whole on the last line when the name is cut", () => {
    const out = wrapLabel("Main-Switchboard-Feeder-Room-East-Hall-3-Distribution-Panel-Block ~", PX, LABEL_LINES);
    expect(out).toHaveLength(LABEL_LINES);
    expect(out[LABEL_LINES - 1]).toContain("…");
    expect(out[LABEL_LINES - 1].endsWith(" ~")).toBe(true);
    expect(out.every((line) => textPx(line) <= PX)).toBe(true);
  });

  it("keeps '(#id) ~ *' whole too, and gives it a line of its own when it does not share one", () => {
    const out = wrapLabel("Main-Switchboard-Feeder-Room-East-Hall-3-Distribution-Panel-Block (#12345) ~ *", 70, LABEL_LINES);
    expect(out).toHaveLength(LABEL_LINES);
    expect(out[LABEL_LINES - 1]).toBe("(#12345) ~ *");
    expect(out[LABEL_LINES - 2]).toContain("…");
  });

  it("a suffix wider than the line takes its own last line whole, uncut", () => {
    const out = wrapLabel("Chiller plant 2 condenser loop (#123456789) ~ *", PX, LABEL_LINES);
    expect(out[out.length - 1]).toBe("(#123456789) ~ *");
    expect(out.length).toBeLessThanOrEqual(LABEL_LINES);
  });

  it("puts the suffix on the same line as the end of a short name when there is room", () => {
    expect(wrapLabel("UPS-1 output ~", 105, LABEL_LINES)).toEqual(["UPS-1 output ~"]);
    expect(wrapLabel("UPS-1 output ~", PX, LABEL_LINES)).toEqual(["UPS-1", "output ~"]);
  });

  it("never returns more lines than it was given", () => {
    for (const max of [1, 2, 3, 4]) {
      for (const name of ["Chiller plant 2 condenser loop", "A".repeat(80), "word ".repeat(30).trim(), "x"]) {
        expect(wrapLabel(name, PX, max).length).toBeLessThanOrEqual(Math.max(max, 1));
      }
    }
  });
});

describe("barAxisLayout", () => {
  it("six assets on 480 px: every label wrapped to at most 3 lines, each line within the slot, none empty", () => {
    const layout = barAxisLayout(SIX, DEFAULT_CHART_WIDTH);
    const slot = slotOf(6, DEFAULT_CHART_WIDTH);
    expect(layout.mode).toBe("wrap");
    expect(layout.slot).toBeCloseTo(slot, 5);
    expect(layout.labels.size).toBe(6);
    for (const label of SIX) {
      const rows = lines(layout.labels.get(label)!);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.length).toBeLessThanOrEqual(LABEL_LINES);
      for (const row of rows) {
        expect(row.trim()).not.toBe("");
        expect(textPx(row)).toBeLessThanOrEqual(slot - SLOT_GAP_PX);
      }
    }
    expect(lines(layout.labels.get(SIX[3])!).join(" ")).toContain("CRAH-3"); // the name w13's picture lost
    expect(lines(layout.labels.get(SIX[1])!).join(" ").endsWith("~")).toBe(true);
  });

  it("a name that fits keeps its words and gets one line", () => {
    const layout = barAxisLayout(["PDU B07", "UPS A"], 880);
    expect(layout.labels.get("PDU B07")).toBe("PDU B07");
    expect(layout.lines).toBe(1);
  });

  it("a 60-character name is cut in the middle in its last line with the ellipsis, the '~' suffix stays whole", () => {
    const name = "Main-Switchboard-Feeder-Room-East-Hall-3-Distribution-Panel-Block";
    const labels = [`${name} ~`, "Hall A", "Hall B", "Hall C", "Hall D", "Hall E"];
    const layout = barAxisLayout(labels, DEFAULT_CHART_WIDTH + 60);
    const rows = lines(layout.labels.get(labels[0])!);
    expect(rows.length).toBeLessThanOrEqual(LABEL_LINES);
    expect(rows[rows.length - 1]).toContain("…");
    expect(rows[rows.length - 1].endsWith(" ~")).toBe(true);
    expect(layout.labels.get("Hall A")).toBe("Hall A");
  });

  it("two long names that differ only in the middle keep their FULL text: no two labels are equal", () => {
    const a = "Main-Switchboard-Feeder-01-Room-East";
    const b = "Main-Switchboard-Feeder-02-Room-East";
    const layout = barAxisLayout([a, b], DEFAULT_CHART_WIDTH);
    expect(layout.mode).toBe("wrap");
    const [ta, tb] = [layout.labels.get(a)!, layout.labels.get(b)!];
    expect(ta).not.toBe(tb);
    expect(ta.replace(/\n/g, "")).toBe(a); // the whole name, only broken into lines
    expect(tb.replace(/\n/g, "")).toBe(b);
    expect(lines(ta).length).toBeLessThanOrEqual(LABEL_LINES + 1);
  });

  it("goes to rotate mode when even the full texts (4 lines) are equal, and then keeps the whole text of two names that differ only in the middle", () => {
    // Two names equal at the start and at the end: only the middle differs, and it does not fit even in four lines (a slot of 50 px: a chart of 180 px for two).
    const long = (digit: string) => `${"Q".repeat(5)}-aaaaaaaaa${digit}aaaaaaaaa-${"R".repeat(5)}`; // 31 characters, about 190 px
    const labels = [long("1"), long("2")];
    const layout = barAxisLayout(labels, GRID_SIDES_PX + 100, 600);
    expect(layout.mode).toBe("rotate");
    expect(layout.labels).toEqual(shortLabels(labels, AXIS_CHARS));
    expect(layout.labels.get(labels[0])).not.toBe(layout.labels.get(labels[1]));
  });

  it("draws no names rather than two equal ones when the whole texts do not fit the height under the plot", () => {
    const long = (digit: string) => `${"Q".repeat(10)}-${"a".repeat(100)}${digit}${"a".repeat(100)}-${"R".repeat(10)}`;
    const labels = [long("1"), long("2")];
    const layout = barAxisLayout(labels, DEFAULT_CHART_WIDTH);
    expect(layout.mode).toBe("none"); // the cuts are equal and the whole names are far taller than what is left under the plot
    expect(layout.labels.size).toBe(0);
  });

  it("one asset: the slot is the whole plot and the label is one line", () => {
    const layout = barAxisLayout(["Chiller plant 2 condenser loop"], DEFAULT_CHART_WIDTH);
    expect(layout.mode).toBe("wrap");
    expect(layout.slot).toBeCloseTo(DEFAULT_CHART_WIDTH - GRID_SIDES_PX, 5);
    expect(layout.lines).toBe(1);
    expect(layout.labels.get("Chiller plant 2 condenser loop")).toBe("Chiller plant 2 condenser loop");
  });

  it("twenty assets on 480 px: mode rotate, labels from shortLabels at 18, margins of 8 below and 12 left (containLabel gives the names their room)", () => {
    const names = Array.from({ length: 20 }, (_, i) => `Distribution panel number ${i + 1}`);
    const layout = barAxisLayout(names, DEFAULT_CHART_WIDTH);
    expect(layout.slot).toBeLessThan(MIN_SLOT_PX);
    expect(layout.mode).toBe("rotate");
    expect(layout.bottom).toBe(8);
    expect(layout.left).toBeGreaterThan(12); // grows with the first name: containLabel takes only the HEIGHT of the turned names, and the first name ends at its tick, so its width must be in `left`
    expect(layout.left).toBeLessThanOrEqual(Math.floor(DEFAULT_CHART_WIDTH * 0.4)); // never more than two fifths of the chart
    expect(layout.labels).toEqual(shortLabels(names, AXIS_CHARS));
    for (const label of layout.labels.values()) expect(Array.from(label).length).toBeLessThanOrEqual(AXIS_CHARS);
  });

  it("the left margin of a rotated axis follows the first name: 12 px for a short one, more for a long one, never above two fifths of the chart", () => {
    const rest = Array.from({ length: 11 }, (_, i) => `H${i + 2}`);
    const short = barAxisLayout(["H1", ...rest], 480);
    const long = barAxisLayout(["Distribution panel number 1", ...rest], 480);
    const wide = barAxisLayout(["WWWWWWWWWWWWWWWWWW", ...rest], 200);
    for (const layout of [short, long, wide]) expect(layout.mode).toBe("rotate");
    expect(short.left).toBe(12);
    expect(long.left).toBeGreaterThan(40);
    expect(wide.left).toBe(Math.floor(200 * 0.4)); // 18 of the widest letter would take more than that of a 200 px chart: the cap holds
    expect(barAxisLayout(["H1", ...rest], 0).left).toBe(12); // an unmeasured chart does not turn the margin negative
  });

  it("switches at a slot of MIN_SLOT_PX", () => {
    const names = ["Rack A01", "Rack A02", "Rack A03", "Rack A04"];
    expect(barAxisLayout(names, GRID_SIDES_PX + MIN_SLOT_PX * 4).mode).toBe("wrap");
    expect(barAxisLayout(names, GRID_SIDES_PX + MIN_SLOT_PX * 4 - 1).mode).toBe("rotate");
  });

  it("bottom grows with the longest label: 16 + lines * 14", () => {
    const one = barAxisLayout(["PDU B07", "UPS A"], 880);
    expect(one.lines).toBe(1);
    expect(one.bottom).toBe(16 + 1 * LABEL_LINE_PX);
    expect(one.left).toBe(60); // wrapped: the slots are counted from the grid's left edge
    const wide = barAxisLayout(SIX, DEFAULT_CHART_WIDTH);
    const most = Math.max(...SIX.map((label) => lines(wide.labels.get(label)!).length));
    expect(wide.lines).toBe(most);
    expect(wide.bottom).toBe(16 + most * LABEL_LINE_PX);
    expect(most).toBeGreaterThan(1);
  });

  it("turns the axis instead of cutting a word in two: 'Electrical' in a 48 px line was drawn 'Electrica' over 'l' (w27 R5)", () => {
    const names = ["Hall 1", "Hall 2 ~", "Electrical"];
    const slot = 56; // a 3x3 card at 1440: the chart is about 248 px, three slots of 56 px, lines of 48 px
    expect(textPx("Electrical")).toBeGreaterThan(slot - SLOT_GAP_PX);
    const tight = barAxisLayout(names, GRID_SIDES_PX + slot * 3);
    expect(tight.mode).toBe("rotate");
    expect(tight.labels.get("Electrical")).toBe("Electrical"); // the turned label is the whole word (AXIS_CHARS is 18)
    // the same names in wider slots keep their wrapped, whole-word labels
    expect(barAxisLayout(names, GRID_SIDES_PX + 80 * 3).mode).toBe("wrap");
  });

  it("still breaks a long name after a hyphen, underscore or slash, and between words, when every piece fits its line", () => {
    const names = ["MV2-R2-LV-PANEL-02", "Hall 1 / Feed A"];
    const layout = barAxisLayout(names, GRID_SIDES_PX + 80 * 2);
    expect(layout.mode).toBe("wrap");
    for (const name of names) for (const row of lines(layout.labels.get(name)!)) expect(textPx(row)).toBeLessThanOrEqual(80 - SLOT_GAP_PX);
  });

  it("a word wider than its line turns the axis, whatever else the name holds; the suffix never counts as a word", () => {
    expect(barAxisLayout(["Distribution panel 1", "Hall 2"], GRID_SIDES_PX + 56 * 2).mode).toBe("rotate"); // "Distribution" is wider than 48 px
    expect(barAxisLayout(["Hall 1 ~", "Hall 2 *"], GRID_SIDES_PX + 56 * 2).mode).toBe("wrap");
  });

  it("an empty list and a width of 0 do not crash", () => {
    expect(barAxisLayout([], DEFAULT_CHART_WIDTH).labels.size).toBe(0);
    expect(barAxisLayout(["A"], 0).mode).toBe("rotate");
  });
});

// w27 P1: the plot keeps its share of the chart's height, and the names are cut to what is left.
describe("barAxisLayout and the height of the chart", () => {
  const RACKS = [
    "Rack 35 / Feed A", "Rack 14 / Feed A", "Rack 19 / Feed A", "Rack 04 / Feed B (#16)", "Rack 03 / Feed B", "Rack 22 / Feed A", "Rack 12 / Feed B",
    "Rack 38 / Feed A", "Rack 04 / Feed B (#198)", "Rack 24 / Feed A",
  ];
  const TWENTY = Array.from({ length: 20 }, (_, i) => `Distribution panel number ${i + 1}`);
  const plotMin = (height: number) => Math.max(PLOT_MIN_PX, Math.ceil(height * PLOT_SHARE));
  /** The plot's height by the layout's own estimates: wrapped, what `bottom` leaves; turned, what is left after the margin, the tick, the gap and the widest turned name. */
  function plotOf(layout: ReturnType<typeof barAxisLayout>, height: number): number {
    if (layout.mode === "wrap") return height - layout.top - layout.bottom;
    if (layout.mode === "none") return height - layout.top - layout.bottom;
    const widest = Math.max(...[...layout.labels.values()].map(textPx));
    const turned = widest * Math.sin((40 * Math.PI) / 180) + LABEL_LINE_PX * Math.cos((40 * Math.PI) / 180);
    return height - layout.top - layout.bottom - 13 - turned;
  }

  it("lays out for the unmeasured height as it did before the height was passed: the same layout, the roomy top", () => {
    for (const names of [SIX, RACKS, TWENTY]) {
      const same = barAxisLayout(names, DEFAULT_CHART_WIDTH);
      expect(barAxisLayout(names, DEFAULT_CHART_WIDTH, DEFAULT_CHART_HEIGHT)).toEqual(same);
      expect(same.top).toBe(TOP_PX);
    }
    expect(barAxisLayout(SIX, DEFAULT_CHART_WIDTH).mode).toBe("wrap");
    expect(barAxisLayout(TWENTY, DEFAULT_CHART_WIDTH).mode).toBe("rotate");
  });

  it("keeps the plot's share at every height from the minimum card up, for wrapped, turned and unlabelled axes alike", () => {
    const modes = new Set<string>();
    for (const height of [120, 124, 140, 160, 180, 214, 260, 304, 360, 480]) {
      for (const width of [330, 427, 543, 783, 880]) {
        for (const names of [SIX, RACKS, TWENTY]) {
          const layout = barAxisLayout(names, width, height);
          modes.add(layout.mode);
          expect(plotOf(layout, height), `${layout.mode} ${names.length} names in ${width} x ${height}`).toBeGreaterThanOrEqual(plotMin(height) - 1);
          expect(layout.top).toBeGreaterThanOrEqual(24);
          if (layout.mode === "rotate") for (const [label, text] of layout.labels) expect(text === label || Array.from(text).length >= MIN_TURNED_CHARS).toBe(true);
        }
      }
    }
    expect([...modes].sort()).toEqual(["none", "rotate", "wrap"]); // the sweep really meets all three
  });

  it("at the minimum card (a 124 px chart) wrapped names get one line and are cut in the middle, with the plot at 60 px or more", () => {
    const layout = barAxisLayout(SIX, 880, 124);
    expect(layout.mode).toBe("wrap");
    expect(layout.lines).toBe(1);
    expect(layout.top).toBe(24); // the unit's name stands in 24 px (nameGapFor)
    expect(124 - layout.top - layout.bottom).toBeGreaterThanOrEqual(60);
    const cut = layout.labels.get(SIX[4])!; // "Chiller plant 2 condenser loop" does not fit one line of its slot
    expect(cut).toContain("…");
    expect(cut).not.toContain("\n");
    expect(textPx(cut)).toBeLessThanOrEqual(slotOf(SIX.length, 880) - SLOT_GAP_PX);
  });

  it("at the minimum card ten long names in a narrow chart are not drawn at all: eight characters do not fit under a plot of 60 px", () => {
    for (const width of [427, 543]) {
      const layout = barAxisLayout(RACKS, width, 124);
      expect(layout.mode).toBe("none");
      expect(layout.bottom).toBe(8); // only the margin: the plot takes the rest
      expect(layout.left).toBe(12);
    }
  });

  it("does not wrap names into one line where that cuts a name to '…' or 'Ro…' beside its suffix: the axis turns instead (and, in a short box, is left off)", () => {
    const layout = barAxisLayout(RACKS, 783, 124); // slots of 70 px: one line of 62 px, and "Rack 04 / Feed B (#198)" keeps nothing of itself beside "(#198)"
    expect(layout.mode).toBe("none");
    const roomy = barAxisLayout(RACKS, 783, 214); // three lines: every name keeps its words
    expect(roomy.mode).toBe("wrap");
    for (const text of roomy.labels.values()) expect(text).not.toMatch(/^…|^Ro…/);
  });

  it("with more height the same names are turned and cut to what is left, never below eight characters, and the cut is the one shortLabels makes", () => {
    const small = barAxisLayout(RACKS, 427, 200);
    const medium = barAxisLayout(RACKS, 427, 240);
    const large = barAxisLayout(RACKS, 427, 304);
    for (const layout of [small, medium, large]) expect(layout.mode).toBe("rotate");
    const shown = (layout: typeof small) => Math.max(...[...layout.labels.values()].map((text) => Array.from(text).length));
    expect(shown(small)).toBeLessThan(shown(medium));
    expect(shown(medium)).toBeLessThan(shown(large));
    expect(shown(large)).toBeLessThanOrEqual(AXIS_CHARS);
    for (const layout of [small, medium]) {
      for (const label of RACKS) {
        const text = layout.labels.get(label)!;
        expect(text === label || text.includes("…")).toBe(true); // whole or cut in the middle with the ellipsis
        expect(Array.from(text).length).toBeLessThanOrEqual(Array.from(label).length);
      }
    }
  });

  it("the unit's name never needs more than the top: 30 px in a roomy chart, 24 px (with a smaller gap) in a short one, 12 px with no name", () => {
    expect(barAxisLayout(RACKS, 427, 304).top).toBe(30);
    expect(barAxisLayout(RACKS, 427, 124).top).toBe(24);
    expect(barAxisLayout(RACKS, 427, 124, false).top).toBe(12);
    expect(nameGapFor(24)).toBe(6);
    expect(nameGapFor(24) + 14).toBeLessThanOrEqual(24); // the text (about 14 px) fits between the picture's top and the plot
    expect(nameGapFor(0)).toBeGreaterThan(0);
  });
});

describe("steppedHeight", () => {
  it("rounds a measured height down to a step of 4 px", () => {
    expect(steppedHeight(124)).toBe(124);
    expect(steppedHeight(126.9)).toBe(124);
    expect(steppedHeight(214)).toBe(212);
  });

  it("ignores a height that is no real chart (not laid out: 0, NaN): the default stays", () => {
    expect(steppedHeight(0)).toBe(DEFAULT_CHART_HEIGHT);
    expect(steppedHeight(PLOT_MIN_PX)).toBe(DEFAULT_CHART_HEIGHT);
    expect(steppedHeight(Number.NaN)).toBe(DEFAULT_CHART_HEIGHT);
    expect(steppedHeight(PLOT_MIN_PX + 4)).toBe(PLOT_MIN_PX + 4);
  });
});

describe("steppedWidth", () => {
  it("rounds a measured width down to a step of 8 px, so a label never gets more room than it has", () => {
    expect(steppedWidth(541)).toBe(536);
    expect(steppedWidth(544)).toBe(544);
    expect(steppedWidth(879.9)).toBe(872);
  });

  it("ignores a width at or below the grid's sides plus one slot (a box that has not been laid out): the default stays", () => {
    expect(steppedWidth(0)).toBe(DEFAULT_CHART_WIDTH);
    expect(steppedWidth(GRID_SIDES_PX + MIN_SLOT_PX)).toBe(DEFAULT_CHART_WIDTH);
    expect(steppedWidth(GRID_SIDES_PX + MIN_SLOT_PX + 8)).toBe(GRID_SIDES_PX + MIN_SLOT_PX + 8);
    expect(steppedWidth(Number.NaN)).toBe(DEFAULT_CHART_WIDTH);
  });
});
