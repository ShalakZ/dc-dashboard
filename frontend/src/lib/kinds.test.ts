import { DEFAULT_KIND, STARTER_KINDS, cleanKind, kindKey, kindOptions, resolveKind } from "./kinds";

const used = (...kinds: string[]) => kinds.map((kind) => ({ kind }));
const keys = (options: string[]) => options.map(kindKey);

describe("kindKey and cleanKind", () => {
  it("ignores case, surrounding blanks and repeated inner blanks", () => {
    expect(kindKey("  LV   Panel ")).toBe("lv panel");
    expect(kindKey("lv panel")).toBe("lv panel");
    expect(kindKey("   ")).toBe("");
  });

  it("normalises Unicode to NFC, so a composed and a decomposed spelling are one kind", () => {
    expect(kindKey("Café")).toBe(kindKey("Café"));
  });

  it("cleans typed text: trimmed, inner blanks collapsed, case kept", () => {
    expect(cleanKind("  New   Thing ")).toBe("New Thing");
    expect(cleanKind("   ")).toBe("");
  });
});

describe("kindOptions", () => {
  const options = kindOptions(used("LV_Panel", "LV_Panel", "lv_panel", "Room", "room", "room", ""));

  it("offers the default, every starter and the kinds in use", () => {
    expect(options).toContain(DEFAULT_KIND);
    for (const starter of STARTER_KINDS) expect(keys(options)).toContain(kindKey(starter));
    expect(keys(options)).toContain("lv_panel");
  });

  it("keeps the most used spelling of a kind in use, once", () => {
    expect(options.filter((o) => kindKey(o) === "lv_panel")).toEqual(["LV_Panel"]);
  });

  it("lets a spelling in use win over a starter's (room beats the starter Room)", () => {
    expect(options.filter((o) => kindKey(o) === "room")).toEqual(["room"]);
  });

  it("has no blank option and no two options with one key", () => {
    expect(options).not.toContain("");
    expect(keys(options).every((k) => k !== "")).toBe(true);
    expect(new Set(keys(options)).size).toBe(options.length);
  });

  it("is sorted by comparison key", () => {
    expect(keys(options)).toEqual([...keys(options)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it("breaks a tie between two spellings in code-point order", () => {
    expect(kindOptions(used("Zone", "zone")).filter((o) => kindKey(o) === "zone")).toEqual(["Zone"]);
  });

  it("lets a starter or the default fill a key nobody uses, and the default give way to a spelling in use", () => {
    expect(kindOptions([])).toContain("Rack");
    expect(kindOptions([])).toContain("generic");
    expect(kindOptions(used("Generic", "Generic")).filter((o) => kindKey(o) === "generic")).toEqual(["Generic"]);
  });

  it("offers the kind of the asset being edited exactly as stored, replacing the spelling of its key", () => {
    expect(kindOptions(used("Room", "room", "room"), "Room").filter((o) => kindKey(o) === "room")).toEqual(["Room"]);
    expect(kindOptions([], "Row ").filter((o) => kindKey(o) === "row")).toEqual(["Row "]);
  });

  it("adds an edited kind that nobody else uses", () => {
    expect(kindOptions([], "Aisle")).toContain("Aisle");
  });

  it("ignores a blank current kind", () => {
    expect(kindOptions(used("Room"), "")).toEqual(kindOptions(used("Room")));
    expect(kindOptions(used("Room"), "  ")).toEqual(kindOptions(used("Room")));
  });
});

describe("resolveKind", () => {
  const options = kindOptions(used("LV_Panel", "room"));

  it("reuses the spelling of an option with the same key", () => {
    expect(resolveKind("lv_panel ", options)).toBe("LV_Panel");
    expect(resolveKind("ROOM", options)).toBe("room");
    expect(resolveKind("LV_PANEL", options)).toBe("LV_Panel");
  });

  it("keeps a new kind, cleaned", () => {
    expect(resolveKind("  New   thing ", options)).toBe("New thing");
    expect(resolveKind("Aisle", options)).toBe("Aisle");
  });

  it("gives an empty string for blank text", () => {
    expect(resolveKind("   ", options)).toBe("");
    expect(resolveKind("", options)).toBe("");
  });
});
