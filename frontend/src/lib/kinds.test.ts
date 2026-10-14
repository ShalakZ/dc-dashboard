import { iconHtml } from "../test/iconHtml";
import { DEFAULT_KIND, cleanKind, kindChoices, kindIconForName, kindKey, registersKind, resolveKind } from "./kinds";

const registry = (...names: string[]) => names.map((name) => ({ name }));

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

describe("resolveKind", () => {
  const options = kindChoices(registry("LV_Panel", "room"));

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

describe("registersKind", () => {
  const kinds = registry("Rack", "Room");

  it("is true for a kind the registry lacks, on a new asset", () => {
    expect(registersKind("Aisle", kinds, null)).toBe(true);
    expect(registersKind("Aisle", [], null)).toBe(true);
  });

  it("is true when an edit changes the kind text to one the registry lacks", () => {
    expect(registersKind("Aisle", kinds, "Rack")).toBe(true);
  });

  it("is false when the kind text did not change: an unrelated edit of an asset whose kind nobody registered writes nothing", () => {
    expect(registersKind("Aisle", kinds, "Aisle")).toBe(false);
  });

  it("is false for a kind the registry holds, whatever the case or the blanks", () => {
    expect(registersKind("Rack", kinds, null)).toBe(false);
    expect(registersKind("rack ", kinds, null)).toBe(false);
    expect(registersKind("  ROOM", kinds, "Rack")).toBe(false);
  });

  it("is false for the default kind, in any spelling, even when the registry lacks it", () => {
    expect(registersKind("generic", [], null)).toBe(false);
    expect(registersKind("Generic", kinds, "Rack")).toBe(false);
    expect(registersKind(" GENERIC ", kinds, null)).toBe(false);
  });

  it("is false for a blank kind", () => {
    expect(registersKind("", kinds, null)).toBe(false);
    expect(registersKind("   ", kinds, "Rack")).toBe(false);
  });

  it("counts a changed spelling as a change (the text is what the asset stores)", () => {
    expect(registersKind("aisle", [], "Aisle")).toBe(true);
  });
});
