import type { IconName } from "../components/Icon";
import { kindIcon } from "./kindIcon";

/** The picker's headings, in the order of the catalogue below (W7o): each group is one run of ASSET_ICONS, so the server's flat list keeps the same order. */
export const ICON_GROUPS = ["Structure", "Power", "Cooling", "IT and network", "Monitoring and safety", "Other"] as const;
export type IconGroup = (typeof ICON_GROUPS)[number];

export type AssetIconEntry = {
  id: string;
  label: string;
  icon: IconName;
  group: IconGroup;
  /** Lower-case words and phrases a person might type to find the icon, besides its label; the picker's search reads them. Never stored. */
  keywords: readonly string[];
};

/**
 * The icons an asset can be given, in the picker's order (group by group). The ids are what the server stores (assets.icon,
 * asset_kinds.icon); they are fixed and independent of the drawing names. backend/tests/test_asset_icons_parity.py compares this list
 * with dcdash.core.asset_icons. The 28 ids of W7g to W7m keep their labels and drawings; the 20 of the data-centre pack (W7o) join them.
 */
export const ASSET_ICONS: ReadonlyArray<AssetIconEntry> = [
  { id: "site", label: "Site", icon: "kindSite", group: "Structure", keywords: ["campus", "facility", "location", "dc"] },
  { id: "building", label: "Building", icon: "kindBuilding", group: "Structure", keywords: ["tower", "block", "plant", "office"] },
  { id: "hall", label: "Data hall", icon: "kindHall", group: "Structure", keywords: ["white space", "suite", "floor", "pod", "datacentre"] },
  { id: "room", label: "Room", icon: "kindRoom", group: "Structure", keywords: ["suite", "cage", "zone", "space"] },
  { id: "row", label: "Row of racks", icon: "kindRow", group: "Structure", keywords: ["aisle", "pod", "racks", "line"] },
  { id: "rack", label: "Rack", icon: "kindRack", group: "Structure", keywords: ["cabinet", "enclosure", "19 inch", "frame"] },
  { id: "panel", label: "Panel", icon: "kindPanel", group: "Power", keywords: ["panelboard", "switchboard", "distribution board", "mdb", "lv"] },
  { id: "meter", label: "Meter", icon: "kindMeter", group: "Power", keywords: ["submeter", "energy", "metering", "kwh", "power meter"] },
  { id: "circuit", label: "Circuit breaker", icon: "kindCircuit", group: "Power", keywords: ["breaker", "feeder", "mcb", "mccb", "fuse"] },
  { id: "ups", label: "UPS", icon: "kindUps", group: "Power", keywords: ["uninterruptible", "rectifier", "inverter", "backup power"] },
  { id: "battery", label: "Battery", icon: "kindBattery", group: "Power", keywords: ["batteries", "bess", "cell", "storage", "lithium"] },
  { id: "pdu", label: "PDU", icon: "kindPdu", group: "Power", keywords: ["power distribution unit", "rack pdu", "rpdu", "strip", "socket"] },
  { id: "rpp", label: "Remote power panel", icon: "kindRpp", group: "Power", keywords: ["panelboard", "branch circuit", "power panel", "distribution"] },
  { id: "ats", label: "Automatic transfer switch", icon: "kindAts", group: "Power", keywords: ["transfer", "automatic", "switch", "source", "changeover"] },
  { id: "sts", label: "Static transfer switch", icon: "kindSts", group: "Power", keywords: ["transfer", "static", "thyristor", "switch", "source"] },
  { id: "busway", label: "Busway", icon: "kindBusway", group: "Power", keywords: ["busbar", "bus bar", "trunking", "busduct", "tap off"] },
  { id: "switchgear", label: "Switchgear", icon: "kindSwitchgear", group: "Power", keywords: ["lv", "mv", "switchboard", "breaker", "lineup"] },
  { id: "rmu", label: "Ring main unit", icon: "kindRmu", group: "Power", keywords: ["ring main", "medium voltage", "mv", "11kv", "switchgear"] },
  { id: "transformer", label: "Transformer", icon: "kindTransformer", group: "Power", keywords: ["trafo", "xfmr", "substation", "step down", "mv"] },
  { id: "generator", label: "Generator", icon: "kindGenerator", group: "Power", keywords: ["genset", "gen", "diesel", "backup power", "engine"] },
  { id: "fueltank", label: "Fuel tank", icon: "kindFuelTank", group: "Power", keywords: ["diesel", "day tank", "storage", "bunker"] },
  { id: "chiller", label: "Chiller", icon: "kindChiller", group: "Cooling", keywords: ["chilled water", "cooling plant", "refrigeration", "compressor", "cooling"] },
  { id: "crac", label: "Cooling unit", icon: "kindCrac", group: "Cooling", keywords: ["computer room", "air conditioner", "cooling", "crah", "cooler"] },
  { id: "ahu", label: "Air handling unit", icon: "kindAhu", group: "Cooling", keywords: ["air handler", "ventilation", "hvac", "fresh air"] },
  { id: "cdu", label: "Cooling distribution unit", icon: "kindCdu", group: "Cooling", keywords: ["coolant", "liquid cooling", "direct to chip", "secondary loop", "manifold"] },
  { id: "coolingtower", label: "Cooling tower", icon: "kindCoolingTower", group: "Cooling", keywords: ["tower", "evaporative", "heat rejection", "condenser water"] },
  { id: "drycooler", label: "Dry cooler", icon: "kindDryCooler", group: "Cooling", keywords: ["radiator", "air cooled", "heat rejection", "glycol", "free cooling"] },
  { id: "heatexchanger", label: "Heat exchanger", icon: "kindHeatExchanger", group: "Cooling", keywords: ["plate", "shell and tube", "free cooling", "phe"] },
  { id: "fan", label: "Fan", icon: "kindFan", group: "Cooling", keywords: ["blower", "ventilation", "extractor", "exhaust"] },
  { id: "pump", label: "Pump", icon: "kindPump", group: "Cooling", keywords: ["circulation", "water", "booster", "motor"] },
  { id: "valve", label: "Valve", icon: "kindValve", group: "Cooling", keywords: ["isolation", "control", "butterfly", "actuator", "shutoff"] },
  { id: "vfd", label: "Variable frequency drive", icon: "kindVfd", group: "Cooling", keywords: ["inverter", "speed drive", "motor drive", "variable speed", "frequency"] },
  { id: "server", label: "Server", icon: "kindServer", group: "IT and network", keywords: ["host", "compute", "blade", "node"] },
  { id: "switch", label: "Network switch", icon: "kindSwitch", group: "IT and network", keywords: ["network", "ethernet", "lan", "top of rack", "fabric"] },
  { id: "router", label: "Router", icon: "kindRouter", group: "IT and network", keywords: ["gateway", "wan", "bgp", "edge", "network"] },
  { id: "firewall", label: "Firewall", icon: "kindFirewall", group: "IT and network", keywords: ["security", "gateway", "waf", "perimeter", "network"] },
  { id: "patchpanel", label: "Patch panel", icon: "kindPatchPanel", group: "IT and network", keywords: ["patch", "cabling", "ports", "fibre", "fiber"] },
  { id: "cabletray", label: "Cable tray", icon: "kindCableTray", group: "IT and network", keywords: ["tray", "ladder", "containment", "basket", "routing"] },
  { id: "controller", label: "Controller", icon: "kindController", group: "Monitoring and safety", keywords: ["plc", "bms", "scada", "rtu", "automation"] },
  { id: "sensor", label: "Sensor", icon: "kindSensor", group: "Monitoring and safety", keywords: ["temperature", "probe", "thermometer", "detector", "monitor"] },
  { id: "smokedetector", label: "Smoke detector", icon: "kindSmokeDetector", group: "Monitoring and safety", keywords: ["smoke", "fire alarm", "vesda", "aspirating", "alarm"] },
  { id: "humidity", label: "Humidity sensor", icon: "kindHumidity", group: "Monitoring and safety", keywords: ["hygrometer", "moisture", "dew point", "rh"] },
  { id: "leak", label: "Water leak", icon: "kindLeak", group: "Monitoring and safety", keywords: ["flood", "leak detection", "rope", "moisture", "detector"] },
  { id: "fire", label: "Fire", icon: "kindFire", group: "Monitoring and safety", keywords: ["suppression", "extinguisher", "fm200", "novec", "flame"] },
  { id: "camera", label: "Camera", icon: "kindCamera", group: "Monitoring and safety", keywords: ["cctv", "video", "security", "surveillance"] },
  { id: "door", label: "Door", icon: "kindDoor", group: "Monitoring and safety", keywords: ["access", "entry", "gate", "badge", "mantrap"] },
  { id: "lighting", label: "Lighting", icon: "kindLighting", group: "Other", keywords: ["lights", "lamp", "led", "luminaire"] },
  { id: "generic", label: "Generic", icon: "kindGeneric", group: "Other", keywords: ["other", "equipment", "anything", "miscellaneous"] },
];

// Maps, not object indexes: a stored "constructor" or "__proto__" must not find an inherited property.
const BY_ID = new Map(ASSET_ICONS.map((entry) => [entry.id, entry]));
const BY_ICON = new Map(ASSET_ICONS.map((entry) => [entry.icon, entry]));

/** The label of a catalogue id, or null for an id the catalogue does not list. */
export function assetIconLabel(id: string): string | null {
  return BY_ID.get(id)?.label ?? null;
}

/** The catalogue label of a `kind*` icon ("Panel"); "Generic" for any other icon. */
export function iconLabelFor(name: IconName): string {
  return BY_ICON.get(name)?.label ?? "Generic";
}

/** The catalogue id of a `kind*` drawing ("kindPanel" -> "panel"); "generic" for any other icon. The id the server stores for a suggestion. */
export function iconIdFor(name: IconName): string {
  return BY_ICON.get(name)?.id ?? "generic";
}

/** The keyword guess for a kind text, as a catalogue id: what a new kind is offered as its icon. */
export function kindIconId(kind: string): string {
  return iconIdFor(kindIcon(kind));
}

/**
 * The icon to draw for an asset, first match wins: (1) the one it was given, when that is in the catalogue; (2) the icon of its kind in
 * the registry (`kind_icon`, resolved by the server; an id this build lacks draws the generic one, since the kind IS registered);
 * (3) only when the kind is not in the registry (`kind_icon` null, or left out by an older response), the keyword guess. Never throws.
 */
export function assetIcon(asset: { kind: string; icon?: string | null; kind_icon?: string | null }): IconName {
  const chosen = typeof asset.icon === "string" ? BY_ID.get(asset.icon) : undefined;
  if (chosen) return chosen.icon;
  if (typeof asset.kind_icon === "string") return BY_ID.get(asset.kind_icon)?.icon ?? "kindGeneric";
  return kindIcon(asset.kind);
}
