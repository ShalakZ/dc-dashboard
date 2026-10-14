import { iconHtml } from "../test/iconHtml";
import { DEFAULT_KIND, STARTER_KINDS, cleanKind, kindChoices, kindIconForName, kindKey, kindOptions, resolveKind } from "./kinds";

const used = (...kinds: string[]) => kinds.map((kind) => ({ kind }));
const registry = (...names: string[]) => names.map((name) => ({ name }));
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

describe("kindChoices", () => {
  it("lists the registry names sorted by key, and the default when the registry lacks it", () => {
    expect(kindChoices(registry("Rack", "Room", "Panel"))).toEqual(["generic", "Panel", "Rack", "Room"]);
  });

  it("gives just the default for an empty registry (also what a registry that failed to load comes to)", () => {
    expect(kindChoices([])).toEqual([DEFAULT_KIND]);
  });

  it("does not add the starter kinds: the registry already holds them", () => {
    expect(kindChoices(registry("Rack"))).toEqual(["generic", "Rack"]);
  });

  it("lists the default once: a registry kind named generic, in any case, is not duplicated and keeps its spelling", () => {
    expect(kindChoices(registry("Generic", "Rack"))).toEqual(["Generic", "Rack"]);
    expect(kindChoices(registry("generic")).filter((o) => kindKey(o) === "generic")).toEqual(["generic"]);
  });

  it("is sorted by comparison key in code-point order, not by locale", () => {
    expect(kindChoices(registry("Zone", "apple", "Éclair", "banana"))).toEqual(["apple", "banana", "generic", "Zone", "Éclair"]);
  });

  it("offers the kind of the asset being edited exactly as stored, replacing the registry's spelling of its key", () => {
    expect(kindChoices(registry("Rack"), "rack ")).toEqual(["generic", "rack "]);
    expect(kindChoices(registry("Rack", "Room"), "ROOM")).toEqual(["generic", "Rack", "ROOM"]);
  });

  it("offers the current kind when the registry does not know it, and when it is the default's own spelling", () => {
    expect(kindChoices(registry("Rack"), "Aisle")).toEqual(["Aisle", "generic", "Rack"]);
    expect(kindChoices(registry("Rack"), "GENERIC")).toEqual(["GENERIC", "Rack"]);
  });

  it("ignores a blank current kind and a blank registry name", () => {
    expect(kindChoices(registry("Rack"), "")).toEqual(kindChoices(registry("Rack")));
    expect(kindChoices(registry("Rack"), "   ")).toEqual(kindChoices(registry("Rack")));
    expect(kindChoices(registry("Rack", "  ", ""))).toEqual(["generic", "Rack"]);
  });

  it("keeps one option per key when the registry holds two names that read alike", () => {
    const options = kindChoices(registry("Rack", "rack"));
    expect(options.filter((o) => kindKey(o) === "rack")).toHaveLength(1);
  });

  it("does not list in-use kinds: only what it is given", () => {
    expect(kindChoices(registry("Rack"))).not.toContain("Room");
  });
});

describe("kindIconForName", () => {
  const kinds = [{ name: "Rack", icon: "server" }, { name: "Pump", icon: "zzz" }, { name: "Room", icon: "room" }];

  it("uses the registry's icon for a kind with the same key, whatever the spelling and whatever the keyword guess says", () => {
    expect(kindIconForName("rack", kinds)).toBe("kindServer");
    expect(kindIconForName("  RACK ", kinds)).toBe("kindServer");
    expect(kindIconForName("Room", kinds)).toBe("kindRoom");
  });

  it("falls back to the keyword guess for a kind the registry does not hold", () => {
    expect(kindIconForName("Panel", kinds)).toBe("kindPanel");
    expect(kindIconForName("Unheard of", kinds)).toBe("kindGeneric");
    expect(kindIconForName("Panel", [])).toBe("kindPanel");
  });

  it("falls back to the keyword guess while the registry is not there (loading, not allowed, failed)", () => {
    expect(kindIconForName("Panel", undefined)).toBe("kindPanel");
    expect(kindIconForName("Rack", undefined)).toBe("kindRack");
  });

  it("draws generic, not the guess, for a registry icon the catalogue lacks", () => {
    expect(kindIconForName("Pump", kinds)).toBe("kindGeneric");
    expect(iconHtml(kindIconForName("pump", kinds))).toBe(iconHtml("kindGeneric"));
  });

  it("does not take an inherited property for a registry icon, or for a kind", () => {
    const odd = [{ name: "Constructor", icon: "constructor" }, { name: "Proto", icon: "__proto__" }, { name: "toString", icon: "server" }];
    expect(kindIconForName("constructor", odd)).toBe("kindGeneric");
    expect(kindIconForName("proto", odd)).toBe("kindGeneric");
    expect(kindIconForName("tostring", odd)).toBe("kindServer");
    expect(kindIconForName("__proto__", odd)).toBe("kindGeneric");
    expect(kindIconForName("hasOwnProperty", odd)).toBe("kindGeneric");
  });
});
