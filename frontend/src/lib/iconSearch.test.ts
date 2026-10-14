import { ASSET_ICONS } from "./assetIcons";
import { iconMatches, searchWords } from "./iconSearch";

const entry = (id: string) => ASSET_ICONS.find((e) => e.id === id)!;
const found = (query: string) => ASSET_ICONS.filter((e) => iconMatches(e, query)).map((e) => e.id);

describe("searchWords", () => {
  it("lower-cases and splits on anything that is not a letter or a digit", () => {
    expect(searchWords("  Air-Handling, UNIT (2) ")).toEqual(["air", "handling", "unit", "2"]);
    expect(searchWords("19 inch")).toEqual(["19", "inch"]);
  });

  it("keeps letters beyond ASCII and gives no words for blanks or punctuation", () => {
    expect(searchWords("Düsseldorf")).toEqual(["düsseldorf"]);
    expect(searchWords("")).toEqual([]);
    expect(searchWords("   ")).toEqual([]);
    expect(searchWords(" -.,() ")).toEqual([]);
  });
});

describe("iconMatches", () => {
  it("matches everything for an empty query, a blank one or one with no words in it", () => {
    for (const query of ["", "  ", "...", "()"]) expect(found(query)).toHaveLength(ASSET_ICONS.length);
  });

  it("finds an icon by its label, ignoring case", () => {
    expect(found("Rack")).toContain("rack");
    expect(found("rack")).toEqual(found("RACK"));
    expect(found("automatic")).toEqual(["ats"]);
  });

  it("finds an icon by a keyword that is not in its label", () => {
    expect(found("thyristor")).toEqual(["sts"]);
    expect(found("busbar")).toEqual(["busway"]);
  });

  it("finds 'transfer' in the two transfer switches only, not in the transformer", () => {
    expect(found("transfer")).toEqual(["ats", "sts"]);
  });

  it("counts a word prefix, never the middle of a word", () => {
    expect(found("trans")).toEqual(expect.arrayContaining(["ats", "sts", "transformer"]));
    expect(found("ransfer")).toEqual([]);
    expect(found("fer")).toEqual([]);
    expect(found("sw")).toEqual(expect.arrayContaining(["switch", "ats", "sts", "switchgear"]));
  });

  it("needs every typed word to match, in any order", () => {
    expect(found("static transfer")).toEqual(["sts"]);
    expect(found("transfer static")).toEqual(["sts"]);
    expect(found("transfer zzz")).toEqual([]);
    expect(found("cooling distribution")).toContain("cdu");
  });

  it("reads punctuation as a gap between words", () => {
    expect(found("air-handling")).toEqual(["ahu"]);
    expect(found("(ups)")).toEqual(["ups"]);
    expect(found("transfer,")).toEqual(["ats", "sts"]);
  });

  it("splits a keyword phrase into words, so a phrase can be typed from any of its words", () => {
    expect(iconMatches(entry("crac"), "computer")).toBe(true);
    expect(iconMatches(entry("crac"), "room computer")).toBe(true);
    expect(iconMatches(entry("coolingtower"), "heat rejection")).toBe(true);
  });

  it("also matches the id, so the abbreviation a person types finds its icon even when no keyword spells it", () => {
    for (const id of ["ats", "sts", "crac", "ahu", "cdu", "vfd", "rmu", "rpp", "pdu"]) {
      expect(found(id), id).toContain(id);
    }
  });

  it("finds nothing for text that matches no word", () => {
    expect(found("zzzz")).toEqual([]);
  });
});
