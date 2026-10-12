import { ICONS } from "../components/Icon";
import { STARTER_KINDS } from "./kinds";
import { kindIcon } from "./kindIcon";

describe("kindIcon: the starter kinds", () => {
  it.each([
    ["Site", "kindSite"],
    ["Building", "kindBuilding"],
    ["Room", "kindRoom"],
    ["Row", "kindRow"],
    ["Rack", "kindRack"],
    ["Panel", "kindPanel"],
    ["Meter", "kindMeter"],
    ["Circuit", "kindCircuit"],
    ["Other equipment", "kindGeneric"],
    ["generic", "kindGeneric"],
  ])("%s is %s", (kind, icon) => {
    expect(kindIcon(kind)).toBe(icon);
  });

  it("covers every starter kind with an icon", () => {
    for (const kind of STARTER_KINDS) expect(Object.keys(ICONS)).toContain(kindIcon(kind));
  });
});

describe("kindIcon: matching", () => {
  it.each([
    // case, separators and a number or letter suffix do not matter
    ["LV_Panel", "kindPanel"],
    ["lv panel", "kindPanel"],
    ["UPS-A", "kindUps"],
    ["DC", "kindSite"],
    ["Chiller-1", "kindChiller"],
    ["Genset 2", "kindGenerator"],
    // the specific equipment kind wins over the general place or the voltage class
    ["Rack PDU", "kindPdu"],
    ["UPS Room", "kindUps"],
    ["LV Meter", "kindMeter"],
    ["MV Room", "kindRoom"],
    ["HV Substation", "kindTransformer"],
    ["MV Transformer", "kindTransformer"],
    ["Main LV Board", "kindPanel"],
    // whole words only: a word that merely contains "panel" is generic
    ["Panelling", "kindGeneric"],
    ["LVP01", "kindGeneric"],
    // aliases and one trailing plural s
    ["panelboard", "kindPanel"],
    ["Racks", "kindRack"],
    ["Meters", "kindMeter"],
    ["PDUs", "kindPdu"],
    ["CRAH unit", "kindChiller"],
    ["ATS", "kindCircuit"],
    // camelCase and digit boundaries split
    ["LVPanel", "kindPanel"],
    ["UPSRoom", "kindUps"],
    ["DC1", "kindSite"],
    ["MDB1", "kindPanel"],
    ["DataCenter", "kindSite"],
    // "data" + "center" is one word
    ["Data Center", "kindSite"],
    ["Data Centre", "kindSite"],
    ["Data Hall A", "kindRoom"],
  ])("%s is %s", (kind, icon) => {
    expect(kindIcon(kind)).toBe(icon);
  });
});

describe("kindIcon: odd input", () => {
  const odd = ["", "   ", "x", "\u{1F9EF}", "موزع", "a".repeat(500), "UPS ".repeat(125), "ab\uD800cd", "\uDC00", "Panel\u0000"];

  it.each(odd.map((kind) => [JSON.stringify(kind).slice(0, 24), kind]))("%s: never throws, is deterministic and is an icon", (_label, kind) => {
    const first = kindIcon(kind);
    expect(kindIcon(kind)).toBe(first);
    expect(Object.keys(ICONS)).toContain(first);
  });

  it("is generic for blank, one letter, emoji and Arabic text", () => {
    for (const kind of ["", "   ", "x", "\u{1F9EF}", "موزع"]) expect(kindIcon(kind)).toBe("kindGeneric");
  });
});
