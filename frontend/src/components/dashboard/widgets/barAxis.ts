// P1 (w14): the category axis of a bar chart of one value per asset. Six assets on a 480 px card leave an 80 px slot for each name, and a name
// cut to 18 characters is about 105 px wide, so neighbours collided and `hideOverlap` dropped one of them. The names now WRAP inside their slot
// (up to three lines) and only a crowded axis turns them by 40 degrees. This file is pure (no canvas, no DOM): it decides the text of each label
// and the room under the plot; BarWidget measures the chart's width and height and barOption puts the result into the axis.
// w27 P1: the plot comes first. A card at its minimum height is 124 px of chart, and names that are turned or wrapped took all of it (the plot was a
// 3 px sliver). The plot now keeps PLOT_SHARE of the box (at least PLOT_MIN_PX) and the names are CUT to the height that is left, or left off when
// not even a few characters fit (the full name is in the tooltip and in the chart's text alternative).
import { shortLabels } from "../../../lib/widgetFormat";

/** Characters a rotated label shows (the full name is in the tooltip and in the Details panel). */
export const AXIS_CHARS = 18;
/** Lines a wrapped label may take; two names that wrap to the same text may take one more (LABEL_LINES + 1) before the axis rotates. */
export const LABEL_LINES = 3;
export const LABEL_LINE_PX = 14;
/** A slot narrower than this cannot hold a wrapped name: the axis rotates. */
export const MIN_SLOT_PX = 56;
/** The grid's `left: 60` plus `right: 20` (the plot is the chart's width minus these). */
export const GRID_SIDES_PX = 80;
/** The chart's width when it has not been measured (a server render, jsdom): a 480 px card. */
export const DEFAULT_CHART_WIDTH = 480;
/** The chart's height when it has not been measured: a card of the default 6 x 5 size (a 3 row card is 124 px). */
export const DEFAULT_CHART_HEIGHT = 280;
/** What the plot keeps of the chart box's height at least: this share of it, and never less than PLOT_MIN_PX (w27 P1). */
export const PLOT_SHARE = 0.45;
export const PLOT_MIN_PX = 60;
/** `grid.top` of a roomy chart: the unit's name stands in it, above the plot. */
export const TOP_PX = 30;
/** `grid.top` of a chart without room to spare: just the unit's name (12 px text, 15 px from the axis end by default), or nothing without a name. */
const TOP_NAMED_TIGHT_PX = 24;
const TOP_BARE_TIGHT_PX = 12;
/** A box with less than this under its plot (once the plot has its share) takes the tight top: names then get a little more room. */
const COMFORT_PX = 48;
/** The tick and the gap before a label (ECharts' 5 and 8). */
const TICK_AND_GAP_PX = 13;
/** Fewest characters (the ellipsis counts) a turned name may be cut to: below that the names are left off, "Rac…A" says nothing the tooltip does not say better. */
export const MIN_TURNED_CHARS = 8;
/**
 * `nameGap` of the value axis's unit name when `top` is the tight one: ECharts' default 15 px between the name and the axis end would cut the name off at the
 * top of a 24 px margin (its text is about 14 px tall), so the gap is what is left of `top` under the name, which keeps 4 px above it.
 */
export const nameGapFor = (top: number): number => Math.max(2, top - 18);
/** Room kept between a line of text and the edge of its slot: 4 px each side. */
export const SLOT_GAP_PX = 8;
/**
 * `grid.bottom` and `grid.left` of a rotated axis. They are only margins: the grid uses `containLabel` there, which fits the turned names (and the y
 * axis's numbers) INSIDE the rectangle these two describe, so a big value would count their room twice (the plot kept a third of a narrow card).
 */
export const ROTATED_BOTTOM_PX = 8;
export const ROTATED_LEFT_PX = 12;
/** `grid.left` of a wrapped axis (no containLabel there: the slots are counted from this edge, GRID_SIDES_PX is this plus the 20 on the right). */
export const WRAPPED_LEFT_PX = 60;
/** The tick and the margin under the plot, before the first line of text. */
const BOTTOM_BASE_PX = 16;
/** The last line must keep at least this much for the name when the suffix shares it; below it the suffix takes a line of its own. */
const MIN_TAIL_PX = 30;
const STEP_PX = 8;

/**
 * The width of each character of a label at 12 px, in the class its width falls in, as the browser draws it (canvas measureText with "12px sans-serif",
 * the font ECharts labels use; Arial's widths, measured in Chromium). A class holds the widest of its members, rounded up to 0.01 px.
 * Calibrated for w14 F1: the old classes (capitals, digits and every mark 8.6 px, then 5 percent) made "CRAH-3" 54 px wide where it is 44.
 */
const CLASS_PX: ReadonlyArray<readonly [string, number]> = [
  ["ijl'", 2.67],
  [" !|.,:;/\\[]ftI", 3.34],
  ["()-r`{}", 4.01],
  ['*"', 4.67],
  ["ckvxyszJ^", 6.0],
  ["0123456789abdeghnopquL#?_$", 6.68],
  ["+<=>~", 7.01],
  ["FTZ", 7.33],
  ["ABEKPSVXY&", 8.01],
  ["CDHNRUw", 8.67],
  ["GOQ", 9.34],
  ["Mm", 10.0],
  ["%", 10.67],
  ["W", 11.33],
  ["@", 12.19],
];
const CHAR_PX = new Map(CLASS_PX.flatMap(([chars, px]) => Array.from(chars, (char) => [char, px] as const)));
/** A character no class knows (another script, an emoji, an accent): counted wide. A line too narrow for it is cut by the chart's own truncation. */
const OTHER_PX = 8.6;
/** The small margin over the sum: kerning and rounding differences between the platforms' text engines. */
const MARGIN = 1.03;

/**
 * An estimate of the width of `text` at 12 px: the sum of CLASS_PX over its characters, plus 3 percent. It is never below the real width of any
 * text made of the known characters (barAxis.test.ts compares it with the measured widths), and is within a few percent above it, so a name that fits
 * its slot is not broken or cut for nothing.
 */
export function textPx(text: string): number {
  let sum = 0;
  for (const char of text) sum += CHAR_PX.get(char) ?? OTHER_PX;
  return sum * MARGIN;
}

/** The identifying tail `chartLabels` appends (" (#12)", then " ~", then " *"); the same pattern `shortLabel` keeps whole (lib/widgetFormat.ts). */
const SUFFIX = / \(#\d+\)(?: ~)?(?: \*)?$| ~(?: \*)?$| \*$/;

function splitSuffix(label: string): { body: string; suffix: string } {
  const found = SUFFIX.exec(label);
  return found ? { body: label.slice(0, found.index), suffix: found[0].trim() } : { body: label, suffix: "" };
}

/** The characters of a label's name that are drawn: what is before the identifying suffix, without the ellipsis and the spaces. */
const nameChars = (label: string): number => Array.from(splitSuffix(label).body).filter((char) => char !== "…" && char !== " ").length;
/** A wrapped name that is cut keeps at least this many characters of itself ("Rack…", not "Ro…"). */
const MIN_CUT_NAME_CHARS = 4;

/** A row of the greedy wrap and the offset in the body where it ends (what is left over is `body.slice(end)`). */
interface Row { text: string; end: number }

/** A word's pieces: it may also be broken after a hyphen, underscore or slash ("MV2-R2-LV-PANEL-02" is one word to a space but five to a label). */
const PIECES = /[^-_/]+[-_/]*|[-_/]+/g;

/**
 * A word's pieces with a last piece of one or two characters joined to the piece before it, when the two fit a line together: "CRAH-" and "3"
 * stay "CRAH-3", so a line that ends in a hyphen never leaves a lone "3" behind (it would be drawn as "CRAH-" over "3"); the pair moves to the next
 * line whole. A pair wider than a line keeps its break after the hyphen.
 */
function withTail(pieces: string[], linePx: number): string[] {
  if (pieces.length < 2 || Array.from(pieces[pieces.length - 1]).length > 2) return pieces;
  const joined = `${pieces[pieces.length - 2]}${pieces[pieces.length - 1]}`;
  return textPx(joined) <= linePx ? [...pieces.slice(0, -2), joined] : pieces;
}

/**
 * The body in rows no wider than `linePx`: words stay whole where they fit, a word is broken after a hyphen, underscore or slash when it
 * does not, and a piece still wider than a row is cut by characters.
 */
function wrapBody(body: string, linePx: number): Row[] {
  const rows: Row[] = [];
  let text = "";
  let end = 0;
  const flush = () => {
    if (text) rows.push({ text, end });
    text = "";
  };
  for (const found of body.matchAll(/\S+/g)) {
    let glue = " "; // the first piece of a word is set off from the row's text by a space, the others join it
    let at = found.index;
    for (const piece of withTail(found[0].match(PIECES) ?? [found[0]], linePx)) {
      const pieceEnd = at + piece.length;
      at = pieceEnd;
      if (text && textPx(`${text}${glue}${piece}`) <= linePx) {
        text += `${glue}${piece}`;
        end = pieceEnd;
        glue = "";
        continue;
      }
      glue = "";
      flush();
      let rest = Array.from(piece);
      let consumed = pieceEnd - piece.length;
      while (rest.length > 1 && textPx(rest.join("")) > linePx) {
        let count = rest.length - 1;
        while (count > 1 && textPx(rest.slice(0, count).join("")) > linePx) count--;
        const chunk = rest.slice(0, count).join("");
        consumed += chunk.length;
        rows.push({ text: chunk, end: consumed });
        rest = rest.slice(count);
      }
      text = rest.join("");
      end = pieceEnd;
    }
  }
  flush();
  return rows;
}

/** `text` cut in the middle so that it fits `maxPx`: "head…tail", the tail a third of what is kept (at most 10 characters). */
function middlePx(text: string, maxPx: number): string {
  if (textPx(text) <= maxPx) return text;
  const chars = Array.from(text);
  for (let kept = chars.length - 1; kept >= 2; kept--) {
    const tail = Math.min(10, Math.floor(kept / 3));
    const candidate = `${chars.slice(0, kept - tail).join("").trimEnd()}…${chars.slice(chars.length - tail).join("").trimStart()}`;
    if (textPx(candidate) <= maxPx) return candidate;
  }
  return "…";
}

/**
 * `label` as lines no wider than `linePx` and at most `maxLines` of them. A name that fits is one line. Longer, it is broken between words;
 * what does not fit in the last line is cut in the middle ("head…tail", so the end of the name, often the part that tells two assets apart,
 * stays visible). The identifying suffix (" ~", " *", " (#id)") is never cut: it shares the last line when it fits there, else takes a line
 * of its own, even when it is wider than a line (the chart's own truncation is the net for that).
 */
export function wrapLabel(label: string, linePx: number, maxLines: number): string[] {
  if (textPx(label) <= linePx) return [label];
  const { body, suffix } = splitSuffix(label);
  const rows = wrapBody(body, linePx);
  if (rows.length === 0) return [label];
  const room = Math.max(maxLines, 1);
  if (rows.length <= room) {
    const lines = rows.map((row) => row.text);
    if (!suffix) return lines;
    const joined = `${lines[lines.length - 1]} ${suffix}`;
    if (textPx(joined) <= linePx) return [...lines.slice(0, -1), joined];
    if (lines.length < room) return [...lines, suffix];
  }
  const restFrom = (keep: number) => (keep === 0 ? body : body.slice(rows[keep - 1].end)).trim();
  const head = (keep: number) => rows.slice(0, keep).map((row) => row.text);
  if (!suffix) return [...head(room - 1), middlePx(restFrom(room - 1), linePx)];
  const roomForName = linePx - textPx(` ${suffix}`);
  if (room === 1 || roomForName >= MIN_TAIL_PX) return [...head(room - 1), `${middlePx(restFrom(room - 1), roomForName)} ${suffix}`];
  return [...head(room - 2), middlePx(restFrom(room - 2), linePx), suffix];
}

/**
 * The width at 12 px of the widest piece of `label` that cannot be broken any further: a word, or the part of one between hyphens, underscores and slashes
 * (the places `wrapBody` may break at). The identifying suffix is left out, as it always has a line of its own.
 */
function widestPiece(label: string): number {
  let widest = 0;
  for (const word of splitSuffix(label).body.split(/\s+/)) for (const piece of word.match(PIECES) ?? []) widest = Math.max(widest, textPx(piece));
  return widest;
}

export interface AxisLayout {
  /** `none`: the box has no room for even a short name under its plot, so the axis draws no names (the tooltip and the text alternative have them). */
  mode: "wrap" | "rotate" | "none";
  /** Width of one category's slot, in px. */
  slot: number;
  /** Lines of the longest label (1 when rotated). */
  lines: number;
  /** The text of each label as the axis draws it; a wrapped label has its lines joined with a newline. */
  labels: Map<string, string>;
  /** `grid.bottom`: the room under the plot for the labels (wrapped), or the margin under the turned names (rotated, which uses containLabel). */
  bottom: number;
  /** `grid.top`: TOP_PX, or less when the box is short (the plot's share comes first). */
  top: number;
  /** `grid.left`: WRAPPED_LEFT_PX, or `rotatedLeft(...)` when rotated: at least ROTATED_LEFT_PX, up to 0.4 of the chart width for a long first name (containLabel counts the y axis's numbers and the turned names' height, not their width). */
  left: number;
}

/** What the y axis's numbers take left of the plot at the least: one digit (7 px) and the 8 px margin the chart library keeps before the plot. */
const Y_NUMBERS_PX = 15;
const COS_TURN = Math.cos((40 * Math.PI) / 180);
const SIN_TURN = Math.sin((40 * Math.PI) / 180);

/**
 * `grid.left` of a rotated axis. containLabel (echarts 5.6, Grid.js) takes the HEIGHT of the turned names off the bottom and the WIDTH of the y numbers
 * off the left, and nothing else: the first name is drawn ending at its tick, reaching back to the lower left by its width * cos(40 degrees) plus half
 * of its height * sin(40 degrees), and that is cut at the picture's edge unless the margin, the y numbers and the first slot's half hold it.
 * So the margin is what is missing of that reach, plus 4 px (a third of a slot counts, not half: the plot narrows as the margin grows), never
 * below ROTATED_LEFT_PX and never above two fifths of the chart (a name that wide is cut rather than leave no plot).
 */
function rotatedLeft(first: string, slot: number, chartWidth: number): number {
  const reach = textPx(first) * COS_TURN + (LABEL_LINE_PX / 2) * SIN_TURN;
  return Math.max(ROTATED_LEFT_PX, Math.min(Math.floor(chartWidth * 0.4), Math.ceil(reach - Y_NUMBERS_PX - slot / 3) + 4));
}

/**
 * What a chart `height` px tall leaves for the names: `top` (grid.top) and `room`, the height under the plot for the tick, the gap and the names, once
 * the plot has its share. `named` is whether the value axis has a unit name (it stands above the plot, in `top`).
 */
function verticalBudget(height: number, named: boolean): { top: number; room: number } {
  const plot = Math.max(PLOT_MIN_PX, Math.ceil(height * PLOT_SHARE));
  const top = height - TOP_PX - plot < COMFORT_PX ? (named ? TOP_NAMED_TIGHT_PX : TOP_BARE_TIGHT_PX) : TOP_PX;
  return { top, room: Math.max(0, height - top - plot) };
}

/**
 * How the category labels of a chart `chartWidth` x `chartHeight` px are drawn. `wrap`: each name in lines of its slot's width, as many lines as the
 * height under the plot holds (at most LABEL_LINES; a name that does not fit them is cut in the middle). Two names that wrap to the same text keep their
 * whole text, over up to LABEL_LINES + 1 lines where the height allows; if they are still equal, or the slot is narrower than MIN_SLOT_PX, or a word of
 * a name is wider than the line (it would be cut inside the word), the axis is `rotate`d, with `shortLabels` (which never makes two names equal) cut to
 * what the height under the plot holds; if that is under MIN_TURNED_CHARS characters the axis draws no names at all (`none`).
 * `named`: the value axis has a unit name above its plot.
 */
export function barAxisLayout(
  labels: readonly string[], chartWidth: number, chartHeight: number = DEFAULT_CHART_HEIGHT, named = true,
): AxisLayout {
  const slot = (chartWidth - GRID_SIDES_PX) / Math.max(labels.length, 1);
  const { top, room } = verticalBudget(chartHeight, named);
  const rotated = (): AxisLayout => {
    // The widest text a turned name may have so that the names' height fits under the plot (the margin below the grid and the tick are theirs too).
    const maxText = (room - ROTATED_BOTTOM_PX - TICK_AND_GAP_PX - LABEL_LINE_PX * COS_TURN) / SIN_TURN;
    const widest = (texts: Iterable<string>) => Math.max(0, ...Array.from(texts, textPx));
    let short = shortLabels(labels, AXIS_CHARS);
    let kept = AXIS_CHARS;
    // Cut until it fits. `shortLabels` restores the full text of names whose cuts are equal (two bars never carry the same name), and that stays while it
    // fits; when it cannot (names that differ only in the middle, and a short box) the axis draws no names rather than two equal ones.
    while (widest(short.values()) > maxText && kept > MIN_TURNED_CHARS) {
      kept--;
      short = shortLabels(labels, kept);
    }
    if (widest(short.values()) > maxText) {
      return { mode: "none", slot, lines: 1, labels: new Map(), top, bottom: ROTATED_BOTTOM_PX, left: ROTATED_LEFT_PX };
    }
    return { mode: "rotate", slot, lines: 1, labels: short, top, bottom: ROTATED_BOTTOM_PX, left: rotatedLeft(short.get(labels[0] ?? "") ?? "", slot, chartWidth) };
  };
  if (!(slot >= MIN_SLOT_PX)) return rotated();
  const linePx = slot - SLOT_GAP_PX;
  const names = [...new Set(labels)];
  if (names.some((name) => widestPiece(name) > linePx)) return rotated(); // a word wider than its slot would be cut in two ("Electrica" over "l"): the axis turns instead (w27 R5)
  const fits = Math.floor((room - BOTTOM_BASE_PX) / LABEL_LINE_PX); // the lines the height under the plot holds
  const most = Math.max(1, Math.min(LABEL_LINES, fits));
  const wrapped = new Map(names.map((name) => [name, wrapLabel(name, linePx, most)] as const));
  const owners = new Map<string, number>();
  for (const lines of wrapped.values()) owners.set(lines.join("\n"), (owners.get(lines.join("\n")) ?? 0) + 1);
  for (const name of names) if ((owners.get(wrapped.get(name)!.join("\n")) ?? 0) > 1) wrapped.set(name, wrapLabel(name, linePx, Math.max(1, Math.min(LABEL_LINES + 1, fits))));
  const texts = [...wrapped.values()].map((lines) => lines.join("\n"));
  if (new Set(texts).size < texts.length) return rotated();
  // A name cut to "…" or "Ro…" (one short line, a long identifying suffix) says nothing: such an axis turns, and the height may then leave the names off.
  if (texts.some((text) => text.includes("…") && nameChars(text.replace(/\n/g, " ")) < MIN_CUT_NAME_CHARS)) return rotated();
  const lines = Math.max(1, ...[...wrapped.values()].map((rows) => rows.length));
  return {
    mode: "wrap", slot, lines, top, bottom: BOTTOM_BASE_PX + lines * LABEL_LINE_PX, left: WRAPPED_LEFT_PX,
    labels: new Map([...wrapped].map(([name, rows]) => [name, rows.join("\n")] as const)),
  };
}

/**
 * The chart width to lay the axis out for, from a measured box: rounded DOWN to a step of 8 px (a resize by a few pixels must not redraw the
 * chart, and a label never gets more room than it has). A width at or below the grid's sides plus one slot is not a real chart (a box that
 * has not been laid out measures 0, as in jsdom): the default stays.
 */
export function steppedWidth(measured: number): number {
  return measured > GRID_SIDES_PX + MIN_SLOT_PX ? Math.floor(measured / STEP_PX) * STEP_PX : DEFAULT_CHART_WIDTH;
}

/**
 * The chart height to lay the axis out for, from a measured box: rounded DOWN to a step of 4 px. A box that has not been laid out (0 in jsdom, NaN) or
 * is shorter than a plot's minimum keeps the default.
 */
export function steppedHeight(measured: number): number {
  return measured > PLOT_MIN_PX ? Math.floor(measured / 4) * 4 : DEFAULT_CHART_HEIGHT;
}
