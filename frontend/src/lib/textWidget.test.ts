import { readFileSync } from "node:fs";
import type { TextStyle } from "../api/types";
import {
  AUTO_TITLE_CUT, AUTO_TITLE_MAX_UNITS, TEXT_LIMITS, TEXT_STYLE_LABELS, TRIM_SET, autoTitle, codePointCount, normalizeText, textLength, trimText, type TextReason,
} from "./textWidget";
import { MAX_TEXT } from "./dashboardEdit";

// The same file backend/tests/test_widget_config.py reads. The server and the editor must give every case the same answer. The file is pure
// ASCII by design (every special character is an escape), and this test file is too: special characters are built from code points.
interface Sample {
  name: string; style: TextStyle; text?: string; repeat?: [string, number];
  ok: boolean; stored?: string; stored_repeat?: [string, number]; count?: number; reason?: TextReason;
}
interface SampleFile { trim_set: string; limits: { heading: number; paragraph: number }; cases: Sample[] }

const raw = readFileSync("../backend/tests/fixtures/text_widget_samples.json", "utf8"); // vitest runs from the frontend directory
const file = JSON.parse(raw) as SampleFile;

const ELLIPSIS = String.fromCodePoint(0x2026);
const EMOJI = String.fromCodePoint(0x1f600);
const FAMILY = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
const textOf = (sample: Sample): string => (sample.repeat ? sample.repeat[0].repeat(sample.repeat[1]) : (sample.text ?? ""));
const storedOf = (sample: Sample): string => (sample.stored_repeat ? sample.stored_repeat[0].repeat(sample.stored_repeat[1]) : (sample.stored ?? ""));

describe("backend/tests/fixtures/text_widget_samples.json", () => {
  it("is pure ASCII and holds the same trim set and limits as the code", () => {
    expect(raw).toMatch(/^[\x00-\x7f]*$/);
    expect(TRIM_SET).toBe(file.trim_set);
    expect(TEXT_LIMITS).toEqual(file.limits);
    expect(file.cases.length).toBeGreaterThan(40);
  });

  it.each(file.cases.map((sample) => [sample.name, sample] as const))("%s", (_name, sample) => {
    const result = normalizeText(sample.style, textOf(sample));
    if (sample.ok) {
      expect(result).toEqual({ ok: true, text: storedOf(sample), count: sample.count });
      expect(codePointCount(storedOf(sample))).toBe(sample.count);
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(sample.reason);
        expect(result.message).not.toBe("");
      }
    }
  });
});

describe("trimText", () => {
  it("trims exactly the explicit set, from both ends", () => {
    expect(trimText(`${TRIM_SET}Hall A${TRIM_SET}`)).toBe("Hall A");
    expect(trimText(TRIM_SET)).toBe("");
    expect(trimText("")).toBe("");
    expect(trimText(" a b ")).toBe("a b");
  });

  it("does not trim a zero width space or a Mongolian vowel separator, and keeps what is inside", () => {
    const zeroWidth = String.fromCodePoint(0x200b);
    const mongolian = String.fromCodePoint(0x180e);
    expect(trimText(`${zeroWidth}a${mongolian}`)).toBe(`${zeroWidth}a${mongolian}`);
    expect(trimText(" a\tb\nc ")).toBe("a\tb\nc");
  });
});

describe("codePointCount", () => {
  it("counts code points, not UTF-16 units", () => {
    expect(EMOJI.length).toBe(2);
    expect(codePointCount(EMOJI)).toBe(1);
    expect(codePointCount(EMOJI.repeat(3))).toBe(3);
    expect(codePointCount(FAMILY)).toBe(5);
    expect(codePointCount("")).toBe(0);
  });
});

describe("normalizeText", () => {
  it("says what is wrong in plain words", () => {
    expect(normalizeText("heading", "")).toMatchObject({ ok: false, reason: "empty", message: "Enter the text." });
    expect(normalizeText("heading", "a\nb")).toMatchObject({ ok: false, reason: "line_break", message: "A heading is one line." });
    expect(normalizeText("heading", "a".repeat(201))).toMatchObject({ ok: false, reason: "too_long", message: "The text can be at most 200 characters." });
    expect(normalizeText("paragraph", "a".repeat(2001))).toMatchObject({ ok: false, reason: "too_long", message: "The text can be at most 2,000 characters." });
    expect(normalizeText("divider", "x")).toMatchObject({ ok: false, reason: "divider_text", message: "A divider has no text." });
    expect(normalizeText("paragraph", "a\u0000b")).toMatchObject({ ok: false, reason: "control" });
    expect(normalizeText("paragraph", "a\ud800b")).toMatchObject({ ok: false, reason: "invalid", message: "The text has a character that cannot be saved." });
  });

  it("stores the normalized text and counts that", () => {
    expect(normalizeText("paragraph", "  one\r\ntwo  ")).toEqual({ ok: true, text: "one\ntwo", count: 7 });
    expect(normalizeText("heading", EMOJI.repeat(200))).toMatchObject({ ok: true, count: 200 });
    expect(normalizeText("divider", "  \n ")).toEqual({ ok: true, text: "", count: 0 });
  });
});

describe("textLength", () => {
  it("is the count of the normalized text, also for a text the rules refuse", () => {
    expect(textLength("  one\r\ntwo  ")).toBe(7); // CRLF is one line feed, the ends are trimmed
    expect(textLength(EMOJI.repeat(3))).toBe(3);
    expect(textLength("a".repeat(2500))).toBe(2500); // too long: the counter still says by how much
    expect(textLength("a\u0000b")).toBe(3); // a control character: refused, still counted
    expect(textLength(" \n ")).toBe(0);
    for (const sample of file.cases.filter((c) => c.ok)) expect(textLength(textOf(sample)), sample.name).toBe(sample.count);
  });
});

describe("TEXT_STYLE_LABELS", () => {
  it("names the three styles", () => {
    expect(TEXT_STYLE_LABELS).toEqual({ heading: "Heading", paragraph: "Paragraph", divider: "Divider" });
  });
});

describe("autoTitle", () => {
  it("is the first line of the text", () => {
    expect(autoTitle("heading", "Hall A", [])).toBe("Hall A");
    expect(autoTitle("paragraph", "  Line one\r\nline two", [])).toBe("Line one");
    expect(autoTitle("paragraph", "\n\nafter blank lines\nsecond", [])).toBe("after blank lines");
  });

  it("is the style word when there is no text, and Divider for a divider whatever it holds", () => {
    expect(autoTitle("heading", "", [])).toBe("Heading");
    expect(autoTitle("paragraph", "  \n ", [])).toBe("Paragraph");
    expect(autoTitle("divider", "", [])).toBe("Divider");
    expect(autoTitle("divider", "kept in the form", [])).toBe("Divider");
  });

  it("cuts at 40 characters and adds one ellipsis only when it cut", () => {
    expect(AUTO_TITLE_CUT).toBe(40);
    expect(autoTitle("heading", "a".repeat(40), [])).toBe("a".repeat(40));
    expect(autoTitle("heading", "a".repeat(41), [])).toBe(`${"a".repeat(40)}${ELLIPSIS}`);
    expect(autoTitle("heading", `${"a".repeat(39)} bcd`, [])).toBe(`${"a".repeat(39)}${ELLIPSIS}`); // the space before the cut goes
  });

  it("counts an emoji as one character and never cuts inside it", () => {
    expect(autoTitle("heading", EMOJI.repeat(40), [])).toBe(EMOJI.repeat(40));
    const cut = autoTitle("heading", EMOJI.repeat(41), []);
    expect(cut).toBe(`${EMOJI.repeat(40)}${ELLIPSIS}`);
    expect(cut).not.toMatch(/\p{Cs}/u);
  });

  it("counts a family emoji (five code points) as one character when the browser can segment", () => {
    // nine families are 45 code points: the code point fallback below cuts them; whole clusters, 9 of 40, do not
    expect(autoTitle("heading", FAMILY.repeat(9), [])).toBe(FAMILY.repeat(9));
  });

  it("turns each run of TABs in the first line into one space, so the title never holds a TAB (review W1)", () => {
    const TAB = String.fromCharCode(9);
    expect(autoTitle("heading", `Hall${TAB}A`, [])).toBe("Hall A");
    expect(autoTitle("heading", `Hall${TAB}${TAB}${TAB}A${TAB}B`, [])).toBe("Hall A B");
    expect(autoTitle("heading", `${TAB}Hall`, [])).toBe("Hall");
    expect(autoTitle("paragraph", `${TAB}${TAB}Hall${TAB}${TAB}\nsecond${TAB}line`, [])).toBe("Hall");
    expect(autoTitle("heading", TAB, [])).toBe("Heading");
    expect(autoTitle("heading", `Hall${TAB}A`, ["hall a"])).toBe("Hall A 2");
  });

  describe("never longer than the title limit, suffix included (review W3)", () => {
    const FAMILY4 = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466); // one cluster, 11 UTF-16 units
    /** A whole number of FAMILY4 clusters followed by the ellipsis, nothing else. */
    const endsOnWholeCluster = (title: string): boolean => {
      const body = title.replace(/ \d+$/, "");
      return body.endsWith(ELLIPSIS) && body.slice(0, -1) === FAMILY4.repeat((body.length - 1) / FAMILY4.length);
    };

    it("keeps the same number as the editor's title check", () => {
      expect(AUTO_TITLE_MAX_UNITS).toBe(MAX_TEXT);
      expect(AUTO_TITLE_MAX_UNITS).toBe(100);
    });

    it("drops whole clusters from the end of 40 family emoji (440 units) until the title fits, and ends on a whole cluster plus the ellipsis", () => {
      const first = autoTitle("heading", FAMILY4.repeat(40), []);
      expect(first.length).toBeLessThanOrEqual(AUTO_TITLE_MAX_UNITS);
      expect(first).toBe(`${FAMILY4.repeat(9)}${ELLIPSIS}`); // 99 + 1 units
      expect(endsOnWholeCluster(first)).toBe(true);
      expect(first).not.toMatch(/\p{Cs}/u);
    });

    it("counts the numbering suffix too: the second title of the same text is still at most 100 units, and the third", () => {
      const first = autoTitle("heading", FAMILY4.repeat(40), []);
      const second = autoTitle("heading", FAMILY4.repeat(40), [first]);
      const third = autoTitle("heading", FAMILY4.repeat(40), [first, second]);
      for (const title of [second, third]) {
        expect(title.length).toBeLessThanOrEqual(AUTO_TITLE_MAX_UNITS);
        expect(endsOnWholeCluster(title)).toBe(true);
        expect(title).not.toMatch(/\p{Cs}/u);
      }
      expect(new Set([first, second, third].map((title) => title.toLowerCase())).size).toBe(3);
    });

    it("numbers a short title with the suffix when the suffix still fits", () => {
      const eight = `${FAMILY4.repeat(8)}${ELLIPSIS}`; // 89 units: " 2" fits
      expect(autoTitle("heading", FAMILY4.repeat(40), [`${FAMILY4.repeat(9)}${ELLIPSIS}`, eight])).toBe(`${eight} 2`);
    });

    it("also fits a line that is under 40 clusters but over 100 units, and the code point fallback", () => {
      const title = autoTitle("heading", FAMILY4.repeat(12), []); // 132 units, 12 clusters
      expect(title).toBe(`${FAMILY4.repeat(9)}${ELLIPSIS}`);
      const saved = Intl.Segmenter;
      Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true, writable: true });
      try {
        const fallback = autoTitle("heading", FAMILY4.repeat(40), []);
        expect(fallback.length).toBeLessThanOrEqual(AUTO_TITLE_MAX_UNITS);
        expect(fallback).not.toMatch(/\p{Cs}/u);
        expect(fallback.endsWith(ELLIPSIS)).toBe(true);
      } finally {
        Object.defineProperty(Intl, "Segmenter", { value: saved, configurable: true, writable: true });
      }
    });

    it("falls back to the style word when even the first cluster is too long for a title", () => {
      const huge = `e${String.fromCodePoint(0x0301).repeat(150)}`; // one cluster of 151 units
      expect(autoTitle("heading", huge, [])).toBe("Heading");
      expect(autoTitle("heading", huge, ["Heading"])).toBe("Heading 2");
    });

    it("leaves plain titles alone: 40 stay, 41 are cut", () => {
      expect(autoTitle("heading", "a".repeat(40), []).length).toBe(40);
      expect(autoTitle("heading", "a".repeat(41), []).length).toBe(41);
    });
  });

  it("falls back to code points without Intl.Segmenter, still never inside a surrogate pair", () => {
    const saved = Intl.Segmenter;
    Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true, writable: true });
    try {
      const cut = autoTitle("heading", EMOJI.repeat(41), []);
      expect(cut).toBe(`${EMOJI.repeat(40)}${ELLIPSIS}`);
      expect(cut).not.toMatch(/\p{Cs}/u);
      expect(autoTitle("heading", FAMILY.repeat(8), [])).toBe(FAMILY.repeat(8)); // 40 code points
      expect(autoTitle("heading", FAMILY.repeat(9), [])).toBe(`${FAMILY.repeat(8)}${ELLIPSIS}`);
      expect(autoTitle("heading", "Hall A", [])).toBe("Hall A");
    } finally {
      Object.defineProperty(Intl, "Segmenter", { value: saved, configurable: true, writable: true });
    }
  });

  it("takes the first free name among the other titles, case-insensitively, for every kind of title", () => {
    expect(autoTitle("heading", "", ["Heading"])).toBe("Heading 2");
    expect(autoTitle("heading", "", ["heading", " HEADING 2 "])).toBe("Heading 3");
    expect(autoTitle("paragraph", "", ["Paragraph", "Paragraph 3"])).toBe("Paragraph 2");
    expect(autoTitle("divider", "", ["Divider", "Divider 2"])).toBe("Divider 3");
    expect(autoTitle("heading", "Hall A", ["hall a"])).toBe("Hall A 2");
    expect(autoTitle("heading", "Hall A", ["Hall B"])).toBe("Hall A");
    expect(autoTitle("heading", "a".repeat(41), [`${"a".repeat(40)}${ELLIPSIS}`])).toBe(`${"a".repeat(40)}${ELLIPSIS} 2`);
  });
});
