import type { TextStyle } from "../api/types";

// The rules of a Text widget's text. The server applies the same ones (backend core/widgets.py) and both are held to the same answers
// by backend/tests/fixtures/text_widget_samples.json (textWidget.test.ts reads it). Order: (1) CRLF, lone CR, U+2028 and U+2029 become LF;
// (2) refuse control characters and lone surrogates; (3) trim both ends with TRIM_SET; (4) count Unicode code points, never `.length`.
// This file is pure ASCII on purpose: the special characters are built from their code points, so no tool can turn an escape into the
// character itself (a literal U+2028 inside a regex is a syntax error).

export const TEXT_STYLE_LABELS: Record<TextStyle, string> = { heading: "Heading", paragraph: "Paragraph", divider: "Divider" };

/** The longest heading and paragraph, in Unicode code points (a divider holds no text). */
export const TEXT_LIMITS = { heading: 200, paragraph: 2000 } as const;

/**
 * The characters trimmed from both ends: exactly the `trim_set` of the sample file (TAB, LF, space, NBSP, U+1680, U+2000 to U+200A,
 * U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF). `String.prototype.trim` is not used: the server's set decides, and `trim()` differs
 * from Python's `strip()` on U+FEFF.
 */
export const TRIM_SET = String.fromCodePoint(
  0x09, 0x0a, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
);

export type TextReason = "control" | "invalid" | "empty" | "too_long" | "line_break" | "divider_text";
export type TextResult = { ok: true; text: string; count: number } | { ok: false; reason: TextReason; message: string };

/** Trim the ends with exactly TRIM_SET. Every character of the set is one UTF-16 unit, so stepping by unit is safe. */
export function trimText(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && TRIM_SET.includes(s[start])) start += 1;
  while (end > start && TRIM_SET.includes(s[end - 1])) end -= 1;
  return s.slice(start, end);
}

/** Unicode code points, as the server counts them (an emoji is one, a family emoji is five); `.length` counts UTF-16 units. */
export const codePointCount = (s: string): number => [...s].length;

const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);

/** CRLF, lone CR, U+2028 and U+2029 become LF. */
const withLineFeeds = (raw: string): string =>
  raw.replace(/\r\n|\r/g, "\n").replaceAll(LINE_SEPARATOR, "\n").replaceAll(PARAGRAPH_SEPARATOR, "\n");

/** The code points the stored text will have (line feeds unified, both ends trimmed): the number the editor's counter shows, also for a text the rules refuse. */
export const textLength = (raw: string): number => codePointCount(trimText(withLineFeeds(raw)));

/** Every control character except LF and TAB (CR is gone by the time this runs). */
function hasControl(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x08 || (cp >= 0x0b && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f)) return true;
  }
  return false;
}

const thousands = (n: number): string => n.toLocaleString("en-US");

const fail = (reason: TextReason, message: string): TextResult => ({ ok: false, reason, message });

/** Apply the four steps to what was typed. `text` is what is stored (the normalized text, "" for a divider) and `count` its code points. */
export function normalizeText(style: TextStyle, raw: string): TextResult {
  const lines = withLineFeeds(raw);
  if (hasControl(lines)) return fail("control", "The text has a control character that cannot be saved.");
  if (/\p{Cs}/u.test(lines)) return fail("invalid", "The text has a character that cannot be saved."); // with the u flag only an UNPAIRED surrogate matches
  const text = trimText(lines);
  const count = codePointCount(text);
  if (style === "divider") return count === 0 ? { ok: true, text: "", count: 0 } : fail("divider_text", "A divider has no text.");
  if (count === 0) return fail("empty", "Enter the text.");
  if (style === "heading" && text.includes("\n")) return fail("line_break", "A heading is one line.");
  const limit = TEXT_LIMITS[style];
  if (count > limit) return fail("too_long", `The text can be at most ${thousands(limit)} characters.`);
  return { ok: true, text, count };
}

/** The user-perceived characters of one line. Intl.Segmenter when the browser has it; else code points (never inside a surrogate pair). */
function graphemes(line: string): string[] {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line), (part) => part.segment);
  }
  return [...line];
}

/** How many characters of the first line an automatic title keeps. */
export const AUTO_TITLE_CUT = 40;
/**
 * The longest title, in UTF-16 units: the same number as MAX_TEXT of dashboardEdit.ts, which the title check there counts with `.length`.
 * It is written again here because dashboardEdit.ts imports this file (an import back would be a cycle); textWidget.test.ts holds the two equal.
 */
export const AUTO_TITLE_MAX_UNITS = 100;
const ELLIPSIS = String.fromCodePoint(0x2026);

const STYLE_WORD: Record<TextStyle, string> = { heading: "Heading", paragraph: "Paragraph", divider: "Divider" };

/** The first name of `base`, "base 2", "base 3" ... that no other title has (case-insensitive). */
function firstFreeName(base: string, taken: ReadonlySet<string>): string {
  let candidate = base;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${base} ${n}`;
  return candidate;
}

/**
 * The title a new text widget gets until the person types one: the first line of the text cut to 40 characters (+ one ellipsis when
 * cut), else the style word. The first free name among `otherTitles` (case-insensitive): "Heading", "Heading 2", "Heading 3" ...
 * A TAB in the first line becomes one space. The result (its " 2" suffix included) never exceeds AUTO_TITLE_MAX_UNITS UTF-16 units:
 * if the cut line is longer (a cluster can be many units), whole grapheme clusters are dropped from its end, never half of one.
 */
export function autoTitle(style: TextStyle, text: string, otherTitles: readonly string[]): string {
  const taken = new Set(otherTitles.map((title) => title.trim().toLowerCase()));
  if (style === "divider") return firstFreeName(STYLE_WORD.divider, taken);
  const line = trimText(withLineFeeds(text)).split("\n")[0] ?? "";
  const parts = graphemes(trimText(trimText(line).replace(/\t+/g, " ")));
  if (parts.length === 0) return firstFreeName(STYLE_WORD[style], taken);
  for (let keep = Math.min(parts.length, AUTO_TITLE_CUT); keep > 0; keep -= 1) {
    const base = keep === parts.length ? parts.join("") : `${parts.slice(0, keep).join("").trimEnd()}${ELLIPSIS}`;
    const title = firstFreeName(base, taken);
    if (title.length <= AUTO_TITLE_MAX_UNITS) return title;
  }
  return firstFreeName(STYLE_WORD[style], taken); // the first cluster alone is too long for a title: the style word
}
