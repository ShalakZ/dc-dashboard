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
/** `grid.bottom` of a rotated axis: room for an 18-character label turned by 40 degrees. */
export const ROTATED_BOTTOM_PX = 84;
/** The tick and the margin under the plot, before the first line of text. */
const BOTTOM_BASE_PX = 16;
/** The last line must keep at least this much for the name when the suffix shares it; below it the suffix takes a line of its own. */
const MIN_TAIL_PX = 30;
const STEP_PX = 8;

const NARROW = new Set(Array.from("iljtf.,:;'|!"));
const WIDE = new Set(Array.from("mwMW%GOQ"));
const LOWER = /^[a-z]$/;

/**
 * An estimate of the width of `text` at 12 px, per character class, deliberately WIDER than any common system font so that a line the
 * estimate lets through never reaches the neighbouring slot: upper case, digits and the marks `#()~*` 8.6 px, lower case 7 px, narrow
 * letters and punctuation 3.8 px, wide letters (m w M W % and the round capitals G O Q, which the library's own width table puts above 9 px) 11 px, @ 12 px,
 * a space 3.6 px, anything else 8.6 px, then 5 percent on the sum.
 */
export function textPx(text: string): number {
  let sum = 0;
  for (const char of text) {
    if (char === " ") sum += 3.6;
    else if (char === "@") sum += 12;
    else if (WIDE.has(char)) sum += 11;
    else if (NARROW.has(char)) sum += 3.8;
    else if (LOWER.test(char)) sum += 7;
    else sum += 8.6;
  }
  return sum * 1.05;
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
    for (const piece of found[0].match(PIECES) ?? [found[0]]) {
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
  /** `grid.bottom`: the room under the plot for the labels. */
  bottom: number;
}

/**
 * How the category labels of a chart `chartWidth` px wide are drawn. `wrap`: each name in lines of its slot's width. Two names that wrap to the
 * same text keep their whole text, over up to LABEL_LINES + 1 lines; if they are still equal, or the slot is narrower than MIN_SLOT_PX, the
 * axis is `rotate`d, with `shortLabels` (which never makes two names equal).
 */
export function barAxisLayout(labels: readonly string[], chartWidth: number): AxisLayout {
  const slot = (chartWidth - GRID_SIDES_PX) / Math.max(labels.length, 1);
  const rotated = (): AxisLayout => ({ mode: "rotate", slot, lines: 1, labels: shortLabels(labels, AXIS_CHARS), bottom: ROTATED_BOTTOM_PX });
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
    mode: "wrap", slot, lines, bottom: BOTTOM_BASE_PX + lines * LABEL_LINE_PX,
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
