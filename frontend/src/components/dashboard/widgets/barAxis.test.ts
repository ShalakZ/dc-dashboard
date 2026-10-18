// P1 (w14): the category axis of a bar chart wraps its labels instead of letting neighbours collide. The module is pure, so everything here
// runs without a canvas; barAxis.ssr.test.ts then draws the same layouts with the real chart library.
import { chartLabels, shortLabels } from "../../../lib/widgetFormat";
import { valueRow } from "../../../test/dashboardFixtures";
import {
  AXIS_CHARS, barAxisLayout, DEFAULT_CHART_WIDTH, GRID_SIDES_PX, LABEL_LINE_PX, LABEL_LINES, MIN_SLOT_PX, SLOT_GAP_PX, steppedWidth, textPx, wrapLabel,
} from "./barAxis";

// The names of the w13 showcase (e2e/w13Showcase.ts SIX), as chartLabels builds them: the second is estimated.
const SIX = chartLabels([
  valueRow({ name: "Rack A01" }), valueRow({ name: "Rack A02", estimated: true }), valueRow({ name: "UPS-1 output" }),
  valueRow({ name: "CRAH-3 supply fan" }), valueRow({ name: "Chiller plant 2 condenser loop" }), valueRow({ name: "PDU B07" }),
]);
const lines = (text: string) => text.split("\n");
const slotOf = (count: number, width: number) => (width - GRID_SIDES_PX) / count;

describe("textPx, the deliberately wide width estimate of a 12 px label", () => {
  it("is 0 for nothing and adds 5 percent to the sum of its classes", () => {
    expect(textPx("")).toBe(0);
    expect(textPx("a")).toBeCloseTo(7 * 1.05, 5); // lower case
    expect(textPx("A")).toBeCloseTo(8.6 * 1.05, 5); // upper case
    expect(textPx("7")).toBeCloseTo(8.6 * 1.05, 5); // digit
    expect(textPx("#()~*")).toBeCloseTo(5 * 8.6 * 1.05, 5); // the marks of a suffix
    expect(textPx("iljtf.,:;'|!")).toBeCloseTo(12 * 3.8 * 1.05, 5); // narrow
    expect(textPx("mwMW%GOQ")).toBeCloseTo(8 * 11 * 1.05, 5); // wide, also when upper case
    expect(textPx("@")).toBeCloseTo(12 * 1.05, 5);
    expect(textPx(" ")).toBeCloseTo(3.6 * 1.05, 5);
    expect(textPx("-é")).toBeCloseTo(2 * 8.6 * 1.05, 5); // anything else is counted wide
  });

  it("counts a code point once, so an emoji is one wide character and not two", () => {
    expect(textPx("😀")).toBeCloseTo(8.6 * 1.05, 5);
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
    expect(wrapLabel("MV2-R2-LV-PANEL-02", 90, LABEL_LINES)).toEqual(["MV2-R2-", "LV-PANEL-", "02"]);
    expect(wrapLabel("pump_room/east_wing", 70, LABEL_LINES).join("")).toBe("pump_room/east_wing");
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

  it("goes to rotate mode when even the full texts (4 lines) are equal", () => {
    // Two names equal at the start and at the end: only the middle differs, and it does not fit even in four lines.
    const long = (digit: string) => `${"Q".repeat(10)}-${"a".repeat(100)}${digit}${"a".repeat(100)}-${"R".repeat(10)}`;
    const labels = [long("1"), long("2")];
    const layout = barAxisLayout(labels, DEFAULT_CHART_WIDTH);
    expect(layout.mode).toBe("rotate");
    expect(layout.labels).toEqual(shortLabels(labels, AXIS_CHARS));
    expect(layout.labels.get(labels[0])).not.toBe(layout.labels.get(labels[1]));
  });

  it("one asset: the slot is the whole plot and the label is one line", () => {
    const layout = barAxisLayout(["Chiller plant 2 condenser loop"], DEFAULT_CHART_WIDTH);
    expect(layout.mode).toBe("wrap");
    expect(layout.slot).toBeCloseTo(DEFAULT_CHART_WIDTH - GRID_SIDES_PX, 5);
    expect(layout.lines).toBe(1);
    expect(layout.labels.get("Chiller plant 2 condenser loop")).toBe("Chiller plant 2 condenser loop");
  });

  it("twenty assets on 480 px: mode rotate, labels from shortLabels at 18, bottom 84", () => {
    const names = Array.from({ length: 20 }, (_, i) => `Distribution panel number ${i + 1}`);
    const layout = barAxisLayout(names, DEFAULT_CHART_WIDTH);
    expect(layout.slot).toBeLessThan(MIN_SLOT_PX);
    expect(layout.mode).toBe("rotate");
    expect(layout.bottom).toBe(84);
    expect(layout.labels).toEqual(shortLabels(names, AXIS_CHARS));
    for (const label of layout.labels.values()) expect(Array.from(label).length).toBeLessThanOrEqual(AXIS_CHARS);
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
    const wide = barAxisLayout(SIX, DEFAULT_CHART_WIDTH);
    const most = Math.max(...SIX.map((label) => lines(wide.labels.get(label)!).length));
    expect(wide.lines).toBe(most);
    expect(wide.bottom).toBe(16 + most * LABEL_LINE_PX);
    expect(most).toBeGreaterThan(1);
  });

  it("an empty list and a width of 0 do not crash", () => {
    expect(barAxisLayout([], DEFAULT_CHART_WIDTH).labels.size).toBe(0);
    expect(barAxisLayout(["A"], 0).mode).toBe("rotate");
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
