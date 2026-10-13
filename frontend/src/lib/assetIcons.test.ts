import { ICONS } from "../components/Icon";
import { iconHtml } from "../test/iconHtml";
import { ASSET_ICONS, assetIcon, assetIconLabel, iconLabelFor } from "./assetIcons";
import { kindIcon } from "./kindIcon";

describe("the asset icon catalogue", () => {
  it("lists 28 icons, the picker order starting at Site and ending at Generic", () => {
    expect(ASSET_ICONS).toHaveLength(28);
    expect(ASSET_ICONS[0].id).toBe("site");
    expect(ASSET_ICONS[ASSET_ICONS.length - 1].id).toBe("generic");
  });

  it("has unique, lower-case ids and a label for each", () => {
    const ids = ASSET_ICONS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+$/);
    for (const entry of ASSET_ICONS) expect(entry.label.trim()).not.toBe("");
    expect(new Set(ASSET_ICONS.map((entry) => entry.label)).size).toBe(ASSET_ICONS.length);
  });

  it("resolves every entry to a drawing in Icon.tsx, one drawing per entry, and leaves no kind icon out", () => {
    const names = ASSET_ICONS.map((entry) => entry.icon);
    for (const name of names) expect(Object.keys(ICONS)).toContain(name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(Object.keys(ICONS).filter((name) => name.startsWith("kind")).sort());
  });

  it("draws 28 different pictures (a copy-pasted drawing would show here)", () => {
    const drawn = ASSET_ICONS.map((entry) => iconHtml(entry.icon));
    for (const html of drawn) expect(html.length).toBeGreaterThan(20);
    expect(new Set(drawn).size).toBe(28);
  });
});

describe("assetIconLabel", () => {
  it("gives the label of a listed id and null for anything else, never an inherited property", () => {
    expect(assetIconLabel("ups")).toBe("UPS");
    expect(assetIconLabel("fueltank")).toBe("Fuel tank");
    expect(assetIconLabel("crac")).toBe("Cooling unit");
    for (const id of ["zzz", "", "Server", "__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(assetIconLabel(id)).toBeNull();
    }
  });
});

describe("assetIcon: a chosen icon wins, anything else follows the kind", () => {
  it("follows the kind when no icon is stored", () => {
    expect(assetIcon({ kind: "Panel" })).toBe(kindIcon("Panel"));
    expect(assetIcon({ kind: "Panel", icon: null })).toBe("kindPanel");
    expect(assetIcon({ kind: "Rack", icon: undefined })).toBe("kindRack");
    expect(assetIcon({ kind: "" })).toBe("kindGeneric");
  });

  it("uses a listed id over a conflicting kind", () => {
    expect(assetIcon({ kind: "Panel", icon: "server" })).toBe("kindServer");
    expect(assetIcon({ kind: "Rack", icon: "fueltank" })).toBe("kindFuelTank");
    expect(assetIcon({ kind: "Pump", icon: "generic" })).toBe("kindGeneric");
  });

  it("turns the kind Pump into the pump drawing by itself (Automatic), while a chosen icon still wins", () => {
    expect(assetIcon({ kind: "Pump" })).toBe("kindPump");
    expect(assetIcon({ kind: "Pump", icon: null })).toBe("kindPump");
    expect(assetIcon({ kind: "Pump", icon: "fan" })).toBe("kindFan");
  });

  it.each(["zzz", "", "__proto__", "constructor", "toString", "Server", " server", "SERVER"])(
    "falls back to the kind icon for the unknown stored id %j and does not throw",
    (icon) => {
      expect(assetIcon({ kind: "Rack", icon })).toBe("kindRack");
      expect(assetIcon({ kind: "", icon })).toBe("kindGeneric");
    },
  );

  it("falls back for a stored value that is not text", () => {
    expect(assetIcon({ kind: "Rack", icon: 5 as never })).toBe("kindRack");
    expect(assetIcon({ kind: "Rack", icon: ["server"] as never })).toBe("kindRack");
  });
});

describe("iconLabelFor", () => {
  it("names a kind icon by its catalogue label", () => {
    expect(iconLabelFor("kindPanel")).toBe("Panel");
    expect(iconLabelFor("kindUps")).toBe("UPS");
    expect(iconLabelFor("kindFuelTank")).toBe("Fuel tank");
  });

  it("says Generic for the generic cube and for any icon that is not a kind icon", () => {
    expect(iconLabelFor("kindGeneric")).toBe("Generic");
    expect(iconLabelFor("rate")).toBe("Generic");
  });
});
