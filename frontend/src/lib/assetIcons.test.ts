import { ICONS } from "../components/Icon";
import { iconHtml } from "../test/iconHtml";
import { ASSET_ICONS, ICON_GROUPS, assetIcon, assetIconLabel, iconIdFor, iconLabelFor, kindIconId } from "./assetIcons";
import { kindIcon } from "./kindIcon";

// The 28 icons of W7g to W7m: their ids, labels and drawings are STORED (assets.icon, asset_kinds.icon) or shown to people, so they never change.
const OLD: ReadonlyArray<readonly [string, string, string]> = [
  ["site", "Site", "kindSite"], ["building", "Building", "kindBuilding"], ["room", "Room", "kindRoom"], ["row", "Row of racks", "kindRow"],
  ["rack", "Rack", "kindRack"], ["panel", "Panel", "kindPanel"], ["meter", "Meter", "kindMeter"], ["circuit", "Circuit breaker", "kindCircuit"],
  ["ups", "UPS", "kindUps"], ["battery", "Battery", "kindBattery"], ["pdu", "PDU", "kindPdu"], ["generator", "Generator", "kindGenerator"],
  ["transformer", "Transformer", "kindTransformer"], ["fueltank", "Fuel tank", "kindFuelTank"], ["chiller", "Chiller", "kindChiller"],
  ["crac", "Cooling unit", "kindCrac"], ["fan", "Fan", "kindFan"], ["pump", "Pump", "kindPump"], ["server", "Server", "kindServer"],
  ["switch", "Network switch", "kindSwitch"], ["controller", "Controller", "kindController"], ["sensor", "Sensor", "kindSensor"],
  ["lighting", "Lighting", "kindLighting"], ["camera", "Camera", "kindCamera"], ["door", "Door", "kindDoor"], ["fire", "Fire", "kindFire"],
  ["leak", "Water leak", "kindLeak"], ["generic", "Generic", "kindGeneric"],
];

// W7o decision 3: the picker's headings, in order, with the ids each holds, in order. The server's ICONS list is this list flattened.
const GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["Structure", ["site", "building", "hall", "room", "row", "rack"]],
  ["Power", ["panel", "meter", "circuit", "ups", "battery", "pdu", "rpp", "ats", "sts", "busway", "switchgear", "rmu", "transformer", "generator", "fueltank"]],
  ["Cooling", ["chiller", "crac", "ahu", "cdu", "coolingtower", "drycooler", "heatexchanger", "fan", "pump", "valve", "vfd"]],
  ["IT and network", ["server", "switch", "router", "firewall", "patchpanel", "cabletray"]],
  ["Monitoring and safety", ["controller", "sensor", "smokedetector", "humidity", "leak", "fire", "camera", "door"]],
  ["Other", ["lighting", "generic"]],
];

const NEW_LABELS: Record<string, string> = {
  ats: "Automatic transfer switch", sts: "Static transfer switch", busway: "Busway", rpp: "Remote power panel", switchgear: "Switchgear",
  rmu: "Ring main unit", coolingtower: "Cooling tower", drycooler: "Dry cooler", ahu: "Air handling unit", cdu: "Cooling distribution unit",
  valve: "Valve", vfd: "Variable frequency drive", heatexchanger: "Heat exchanger", patchpanel: "Patch panel", cabletray: "Cable tray",
  router: "Router", firewall: "Firewall", smokedetector: "Smoke detector", humidity: "Humidity sensor", hall: "Data hall",
};

describe("the asset icon catalogue", () => {
  it("lists 48 icons, the picker order starting at Site and ending at Generic", () => {
    expect(ASSET_ICONS).toHaveLength(48);
    expect(ASSET_ICONS[0].id).toBe("site");
    expect(ASSET_ICONS[ASSET_ICONS.length - 1].id).toBe("generic");
  });

  it("keeps the 28 older ids, labels and drawings exactly as they were, and adds 20 with the planned labels", () => {
    for (const [id, label, icon] of OLD) expect(ASSET_ICONS.find((entry) => entry.id === id), id).toMatchObject({ id, label, icon });
    const added = ASSET_ICONS.filter((entry) => !OLD.some(([id]) => id === entry.id));
    expect(Object.fromEntries(added.map((entry) => [entry.id, entry.label]))).toEqual(NEW_LABELS);
    expect(added).toHaveLength(20);
  });

  it("puts every entry in one of the six groups, each group in one run, and the runs in the planned order", () => {
    expect(ICON_GROUPS).toEqual(GROUPS.map(([name]) => name));
    for (const entry of ASSET_ICONS) expect(ICON_GROUPS, entry.id).toContain(entry.group);
    const runs = ASSET_ICONS.reduce<string[]>((names, entry) => (names[names.length - 1] === entry.group ? names : [...names, entry.group]), []);
    expect(runs).toEqual(ICON_GROUPS); // no group appears twice
    for (const [name, ids] of GROUPS) {
      expect(ASSET_ICONS.filter((entry) => entry.group === name).map((entry) => entry.id), name).toEqual(ids);
    }
    expect(ASSET_ICONS.map((entry) => entry.id)).toEqual(GROUPS.flatMap(([, ids]) => ids));
  });

  it("gives every entry two to six lower-case search keywords, none blank or repeated", () => {
    for (const entry of ASSET_ICONS) {
      expect(entry.keywords.length, entry.id).toBeGreaterThanOrEqual(2);
      expect(entry.keywords.length, entry.id).toBeLessThanOrEqual(6);
      for (const word of entry.keywords) {
        expect(word.trim(), entry.id).not.toBe("");
        expect(word, entry.id).toBe(word.trim().toLowerCase());
      }
      expect(new Set(entry.keywords).size, entry.id).toBe(entry.keywords.length);
    }
  });

  it("knows the words a person types for the transfer switches, the cooling and the network gear", () => {
    const keywords = (id: string) => ASSET_ICONS.find((entry) => entry.id === id)!.keywords;
    expect(keywords("ats")).toEqual(expect.arrayContaining(["transfer", "automatic"]));
    expect(keywords("sts")).toEqual(expect.arrayContaining(["transfer", "static"]));
    expect(keywords("crac")).toEqual(expect.arrayContaining(["computer room", "air conditioner", "cooling"]));
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

  it("draws 48 different pictures (a copy-pasted drawing would show here)", () => {
    const drawn = ASSET_ICONS.map((entry) => iconHtml(entry.icon));
    for (const html of drawn) expect(html.length).toBeGreaterThan(20);
    expect(new Set(drawn).size).toBe(48);
  });

  // W7o decision 4, the part jsdom can judge: stroke only (svg.i supplies the stroke and the colour) and at most six drawn elements. The
  // 2..22 band and the 2-unit gaps need a browser (getBBox): the contact sheet of the wave checks them.
  it.each(ASSET_ICONS.map((entry) => [entry.id, entry.icon] as const))("%s (%s) follows the drawing rules", (_id, icon) => {
    const html = iconHtml(icon);
    expect(html).not.toMatch(/\bfill=|\bstroke=|style=/);
    const shapes = html.match(/<(?:path|circle|rect|ellipse|line|polyline|polygon)\b/g) ?? [];
    expect(shapes.length).toBeGreaterThan(0);
    expect(shapes.length).toBeLessThanOrEqual(6);
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
  it("turns each kind drawing back into its catalogue id (all 48)", () => {
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
