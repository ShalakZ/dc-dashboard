// P1 (w14): the category axis of a bar chart of one value per asset. Six assets on a 480 px card leave an 80 px slot for each name, and a name
// cut to 18 characters is about 105 px wide, so neighbours collided and `hideOverlap` dropped one of them. The names now WRAP inside their slot
// (up to three lines) and only a crowded axis turns them by 40 degrees. This file is pure (no canvas, no DOM): it decides the text of each label
// and the room under the plot; BarWidget measures the chart's width and barOption puts the result into the axis.
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

export interface AxisLayout {
  mode: "wrap" | "rotate";
  /** Width of one category's slot, in px. */
  slot: number;
  /** Lines of the longest label (1 when rotated). */
  lines: number;
  /** The text of each label as the axis draws it; a wrapped label has its lines joined with a newline. */
  labels: Map<string, string>;
  /** `grid.bottom`: the room under the plot for the labels (wrapped), or the margin under the turned names (rotated, which uses containLabel). */
  bottom: number;
  /** `grid.left`: WRAPPED_LEFT_PX, or ROTATED_LEFT_PX when rotated (containLabel counts the y axis's numbers). */
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
 * How the category labels of a chart `chartWidth` px wide are drawn. `wrap`: each name in lines of its slot's width. Two names that wrap to the
 * same text keep their whole text, over up to LABEL_LINES + 1 lines; if they are still equal, or the slot is narrower than MIN_SLOT_PX, the
 * axis is `rotate`d, with `shortLabels` (which never makes two names equal).
 */
export function barAxisLayout(labels: readonly string[], chartWidth: number): AxisLayout {
  const slot = (chartWidth - GRID_SIDES_PX) / Math.max(labels.length, 1);
  const rotated = (): AxisLayout => {
    const short = shortLabels(labels, AXIS_CHARS);
    return { mode: "rotate", slot, lines: 1, labels: short, bottom: ROTATED_BOTTOM_PX, left: rotatedLeft(short.get(labels[0] ?? "") ?? "", slot, chartWidth) };
  };
  if (!(slot >= MIN_SLOT_PX)) return rotated();
  const linePx = slot - SLOT_GAP_PX;
  const names = [...new Set(labels)];
  const wrapped = new Map(names.map((name) => [name, wrapLabel(name, linePx, LABEL_LINES)] as const));
  const owners = new Map<string, number>();
  for (const lines of wrapped.values()) owners.set(lines.join("\n"), (owners.get(lines.join("\n")) ?? 0) + 1);
  for (const name of names) if ((owners.get(wrapped.get(name)!.join("\n")) ?? 0) > 1) wrapped.set(name, wrapLabel(name, linePx, LABEL_LINES + 1));
  const texts = [...wrapped.values()].map((lines) => lines.join("\n"));
  if (new Set(texts).size < texts.length) return rotated();
  const lines = Math.max(1, ...[...wrapped.values()].map((rows) => rows.length));
  return {
    mode: "wrap", slot, lines, bottom: BOTTOM_BASE_PX + lines * LABEL_LINE_PX, left: WRAPPED_LEFT_PX,
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
