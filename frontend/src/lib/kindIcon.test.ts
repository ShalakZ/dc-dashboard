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
    ["CRAH unit", "kindCrac"],
    ["ATS", "kindAts"],
    // camelCase and digit boundaries split
    ["LVPanel", "kindPanel"],
    ["UPSRoom", "kindUps"],
    ["DC1", "kindSite"],
    ["MDB1", "kindPanel"],
    ["DataCenter", "kindSite"],
    // "data" + "center" is one word
    ["Data Center", "kindSite"],
    ["Data Centre", "kindSite"],
    ["Data Hall A", "kindHall"],
    // long forms: "distribution" + "unit" is one word (a PDU), and these words belong to the equipment, not to the place
    ["Power Distribution Unit", "kindPdu"],
    ["Distribution Units", "kindPdu"],
    ["Distribution Board", "kindPanel"],
    ["Automatic Transfer Switch", "kindAts"],
    ["Submeter", "kindMeter"],
    ["Sub-meter", "kindMeter"],
    ["DC Rectifier", "kindUps"],
    ["Inverter 2", "kindUps"],
  ])("%s is %s", (kind, icon) => {
    expect(kindIcon(kind)).toBe(icon);
  });
});

describe("kindIcon: transfer", () => {
  // "Transfer" alone is not equipment (a transfer pump, a transfer room); "transfer" + "switch" is one word, the transfer switch: a plain one
  // stays a circuit breaker, "Automatic" or "Static" in front of it makes it the ATS or the STS (W7o).
  it.each([
    ["Transfer Switch", "kindCircuit"],
    ["Automatic Transfer Switch", "kindAts"],
    ["Static Transfer Switch", "kindSts"],
    ["Transfer Switches", "kindCircuit"],
    ["Static Transfer Switches", "kindSts"],
    ["TransferSwitch", "kindCircuit"],
    ["transfer-switch", "kindCircuit"],
    ["ATS Transfer Switch", "kindAts"],
    ["Fuel Transfer Pump", "kindPump"],
    ["Transfer", "kindGeneric"],
    ["Transfer Room", "kindRoom"],
    ["Transfer Switchgear", "kindSwitchgear"],
    ["Switch Transfer", "kindGeneric"],
  ])("%s is %s", (kind, icon) => {
    expect(kindIcon(kind)).toBe(icon);
  });
});

describe("kindIcon: battery, cooling unit, fan, pump and sensor have their own icons", () => {
  it.each([
    ["Battery", "kindBattery"],
    ["Batteries", "kindBattery"],
    ["BESS", "kindBattery"],
    ["CRAC", "kindCrac"],
    ["CRAH", "kindCrac"],
    ["Cooling", "kindCrac"],
    ["Cooler", "kindCrac"],
    ["AHU", "kindAhu"],
    ["Fan", "kindFan"],
    ["Fans", "kindFan"],
    ["Pump", "kindPump"],
    ["Pumps", "kindPump"],
    ["Sensor", "kindSensor"],
    ["Sensors", "kindSensor"],
  ])("%s is %s", (kind, icon) => {
    expect(kindIcon(kind)).toBe(icon);
  });

  // The table order decides when a kind holds two known words.
  it.each([
    ["UPS Battery", "kindUps"],
    ["Battery UPS", "kindUps"],
    ["Battery Room", "kindBattery"],
    ["CRAC Unit", "kindCrac"],
    ["Cooling Tower", "kindCoolingTower"],
    ["Cooling Pump", "kindPump"],
    ["Cooling Fan", "kindFan"],
    ["AHU Fan", "kindAhu"],
    ["Chiller", "kindChiller"],
    ["Chiller Pump", "kindChiller"],
    ["Fan Coil Unit", "kindFan"],
    ["Fuel Transfer Pump", "kindPump"],
    // a panel that serves a pump (or a cooling loop) is a panel; a pump room is a pump, as a UPS room is a UPS
    ["Pump Panel", "kindPanel"],
    ["Pump Control Panel", "kindPanel"],
    ["Cooling Panel", "kindPanel"],
    ["Pump Room", "kindPump"],
    ["Transfer Switch", "kindCircuit"],
    ["Rack Temperature Sensor", "kindSensor"],
    ["Power Meter", "kindMeter"],
    ["Sensor Meter", "kindMeter"],
    ["LV Panel", "kindPanel"],
    ["Cooling Plant", "kindCrac"],
    ["Boiler", "kindGeneric"],
  ])("%s is %s", (kind, icon) => {
    expect(kindIcon(kind)).toBe(icon);
  });
});

describe("kindIcon: the data-centre pack (W7o): every new word and join, plurals included", () => {
  it.each([
    // one word each
    ["Busway", "kindBusway"],
    ["Busways", "kindBusway"],
    ["Switchgear", "kindSwitchgear"],
    ["RPP", "kindRpp"],
    ["RPPs", "kindRpp"],
    ["RMU", "kindRmu"],
    ["CDU", "kindCdu"],
    ["CDUs", "kindCdu"],
    ["AHUs", "kindAhu"],
    ["VFD", "kindVfd"],
    ["VFDs", "kindVfd"],
    ["Valve", "kindValve"],
    ["Valves", "kindValve"],
    ["Router", "kindRouter"],
    ["Routers", "kindRouter"],
    ["Firewall", "kindFirewall"],
    ["Firewalls", "kindFirewall"],
    ["Humidity", "kindHumidity"],
    ["Smoke", "kindSmokeDetector"],
    ["Hall", "kindHall"],
    ["Halls", "kindHall"],
    ["STS", "kindSts"],
    ["ATS-1", "kindAts"],
    // two-word joins
    ["Cooling Tower 2", "kindCoolingTower"],
    ["Cooling Towers", "kindCoolingTower"],
    ["CoolingTower", "kindCoolingTower"],
    ["Dry Cooler", "kindDryCooler"],
    ["Dry Coolers", "kindDryCooler"],
    ["Heat Exchanger", "kindHeatExchanger"],
    ["Heat Exchangers", "kindHeatExchanger"],
    ["Patch Panel", "kindPatchPanel"],
    ["Patch Panels", "kindPatchPanel"],
    ["Cable Tray", "kindCableTray"],
    ["Cable Trays", "kindCableTray"],
    ["Smoke Detector", "kindSmokeDetector"],
    ["Smoke Detectors", "kindSmokeDetector"],
    ["Air Handling", "kindAhu"],
    ["Ring Main", "kindRmu"],
    // three-word joins
    ["Cooling distribution unit", "kindCdu"],
    ["Cooling Distribution Units", "kindCdu"],
    ["Coolant distribution unit", "kindCdu"],
    ["Air handling unit", "kindAhu"],
    ["Air Handling Units", "kindAhu"],
    ["Ring main unit", "kindRmu"],
    ["Ring Main Units", "kindRmu"],
    ["Variable frequency drive", "kindVfd"],
    ["Variable Frequency Drives", "kindVfd"],
    ["Variable speed drive", "kindVfd"],
    ["Remote power panel", "kindRpp"],
    ["Remote Power Panels", "kindRpp"],
    ["Automatic Transfer Switches", "kindAts"],
    ["Static Transfer Switch", "kindSts"],
    // the table order decides when a kind holds two known words
    ["ATS Panel", "kindAts"],
    ["Humidity Sensor", "kindHumidity"],
    ["Humidity Sensors", "kindHumidity"],
    ["Smoke Sensor", "kindSmokeDetector"],
    ["Router Room", "kindRouter"],
    ["Valve Room", "kindValve"],
    ["Fan Coil Unit", "kindFan"],
    ["Data Hall", "kindHall"],
    ["Hall 2", "kindHall"],
  ])("%s is %s", (kind, icon) => {
    expect(kindIcon(kind)).toBe(icon);
  });

  // The joins must not steal the words they are made of when the rest is missing: "distribution unit" is still a PDU, a bare "transfer switch"
  // a circuit breaker, "tower" a building, and the old pump and panel rules keep their kinds.
  it.each([
    ["Power Distribution Unit", "kindPdu"],
    ["Distribution Unit", "kindPdu"],
    ["Distribution Board", "kindPanel"],
    ["Main Power Panel", "kindPanel"],
    ["Power Panel", "kindPanel"],
    ["Remote Panel", "kindPanel"],
    ["Transfer Switch", "kindCircuit"],
    ["Transfer Switches", "kindCircuit"],
    ["Automatic Switch", "kindGeneric"],
    ["Static", "kindGeneric"],
    ["Tower", "kindBuilding"],
    ["Cooling", "kindCrac"],
    ["Cooler", "kindCrac"],
    ["Cooling Pump", "kindPump"],
    ["Cooling Tower Pump", "kindPump"],
    ["Pump Control Panel", "kindPanel"],
    ["Fuel Transfer Pump", "kindPump"],
    ["Heat", "kindGeneric"],
    ["Dry", "kindGeneric"],
    ["Patch", "kindGeneric"],
    ["Cable", "kindGeneric"],
    ["Air", "kindGeneric"],
    ["Ring", "kindGeneric"],
    ["Variable Speed", "kindGeneric"],
    ["Detector", "kindGeneric"],
    ["Main", "kindGeneric"],
  ])("%s stays %s", (kind, icon) => {
    expect(kindIcon(kind)).toBe(icon);
  });

  it("names a drawing of the catalogue for every pack word, so a suggestion always has an icon", () => {
    for (const kind of ["Busway", "RPP", "ATS", "STS", "Switchgear", "RMU", "Cooling Tower", "Dry Cooler", "AHU", "CDU", "Valve", "VFD", "Heat Exchanger", "Patch Panel", "Cable Tray", "Router", "Firewall", "Smoke Detector", "Humidity", "Data Hall"]) {
      expect(Object.keys(ICONS), kind).toContain(kindIcon(kind));
      expect(kindIcon(kind), kind).not.toBe("kindGeneric");
    }
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
