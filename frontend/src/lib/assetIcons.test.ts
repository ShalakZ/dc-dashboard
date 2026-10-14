import { ICONS } from "../components/Icon";
import { iconHtml } from "../test/iconHtml";
import { ASSET_ICONS, assetIcon, assetIconLabel, iconIdFor, iconLabelFor, kindIconId } from "./assetIcons";
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

describe("assetIcon: the kind's icon from the registry (kind_icon) sits between the asset's own icon and the keyword guess", () => {
  it("lets an asset's own icon beat the kind's", () => {
    expect(assetIcon({ kind: "Pump", icon: "fan", kind_icon: "server" })).toBe("kindFan");
    expect(assetIcon({ kind: "Pump", icon: "generic", kind_icon: "server" })).toBe("kindGeneric");
  });

  it("lets the kind's icon beat the keyword guess, even when the guess would say otherwise", () => {
    expect(assetIcon({ kind: "Pump", kind_icon: "server" })).toBe("kindServer");
    expect(assetIcon({ kind: "Pump", icon: null, kind_icon: "server" })).toBe("kindServer");
    expect(assetIcon({ kind: "Rack", icon: undefined, kind_icon: "pump" })).toBe("kindPump");
    expect(assetIcon({ kind: "", kind_icon: "rack" })).toBe("kindRack");
  });

  it("uses the keyword guess when the kind is not in the registry (kind_icon null) or the response predates the field (undefined)", () => {
    expect(assetIcon({ kind: "Pump", kind_icon: null })).toBe("kindPump");
    expect(assetIcon({ kind: "Pump", kind_icon: undefined })).toBe("kindPump");
    expect(assetIcon({ kind: "Pump", icon: null, kind_icon: null })).toBe("kindPump");
    expect(assetIcon({ kind: "Unheard of", kind_icon: null })).toBe("kindGeneric");
  });

  // The guess is for text the registry does not know. A registry row whose icon this build does not list is still a registered kind: generic, never the guess.
  it.each(["zzz", "", "__proto__", "constructor", "toString", "Server", " server"])(
    "draws generic, not the keyword guess, for the registry icon %j the catalogue lacks, and does not throw",
    (stored) => {
      expect(assetIcon({ kind: "Rack", kind_icon: stored })).toBe("kindGeneric");
      expect(assetIcon({ kind: "Rack", icon: null, kind_icon: stored })).toBe("kindGeneric");
    },
  );

  it("lets an own icon the catalogue lacks fall through to the kind's icon, then to the guess", () => {
    expect(assetIcon({ kind: "Rack", icon: "zzz", kind_icon: "server" })).toBe("kindServer");
    expect(assetIcon({ kind: "Rack", icon: "__proto__", kind_icon: "zzz" })).toBe("kindGeneric");
    expect(assetIcon({ kind: "Rack", icon: "zzz", kind_icon: null })).toBe("kindRack");
    expect(assetIcon({ kind: "Rack", icon: "", kind_icon: undefined })).toBe("kindRack");
  });

  it("falls back to the guess for a kind_icon that is not text", () => {
    expect(assetIcon({ kind: "Rack", kind_icon: 5 as never })).toBe("kindRack");
    expect(assetIcon({ kind: "Rack", kind_icon: ["server"] as never })).toBe("kindRack");
  });

  it("follows every catalogue id", () => {
    for (const entry of ASSET_ICONS) expect(assetIcon({ kind: "Rack", kind_icon: entry.id })).toBe(entry.icon);
  });
});

describe("iconIdFor and kindIconId", () => {
  it("turns each kind drawing back into its catalogue id (all 28)", () => {
    for (const entry of ASSET_ICONS) expect(iconIdFor(entry.icon)).toBe(entry.id);
  });

  it("says generic for a drawing that is not a kind icon", () => {
    expect(iconIdFor("rate")).toBe("generic");
    expect(iconIdFor("assets")).toBe("generic");
  });

  it("gives the keyword guess for a kind as a catalogue id, generic when no word is recognised", () => {
    expect(kindIconId("Pump")).toBe("pump");
    expect(kindIconId("LV Panel")).toBe("panel");
    expect(kindIconId("Cooling Unit")).toBe("crac");
    expect(kindIconId("Unheard of")).toBe("generic");
    expect(kindIconId("")).toBe("generic");
    for (const entry of ASSET_ICONS) expect(ASSET_ICONS.some((e) => e.id === kindIconId(entry.id))).toBe(true);
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
