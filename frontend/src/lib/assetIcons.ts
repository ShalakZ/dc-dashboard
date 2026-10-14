import type { IconName } from "../components/Icon";
import { kindIcon } from "./kindIcon";

/**
 * The icons an asset can be given, in the picker's order. The ids are what the server stores (assets.icon); they are fixed and
 * independent of the drawing names. backend/tests/test_asset_icons_parity.py compares this list with dcdash.core.asset_icons.
 */
export const ASSET_ICONS: ReadonlyArray<{ id: string; label: string; icon: IconName }> = [
  { id: "site", label: "Site", icon: "kindSite" },
  { id: "building", label: "Building", icon: "kindBuilding" },
  { id: "room", label: "Room", icon: "kindRoom" },
  { id: "row", label: "Row of racks", icon: "kindRow" },
  { id: "rack", label: "Rack", icon: "kindRack" },
  { id: "panel", label: "Panel", icon: "kindPanel" },
  { id: "meter", label: "Meter", icon: "kindMeter" },
  { id: "circuit", label: "Circuit breaker", icon: "kindCircuit" },
  { id: "ups", label: "UPS", icon: "kindUps" },
  { id: "battery", label: "Battery", icon: "kindBattery" },
  { id: "pdu", label: "PDU", icon: "kindPdu" },
  { id: "generator", label: "Generator", icon: "kindGenerator" },
  { id: "transformer", label: "Transformer", icon: "kindTransformer" },
  { id: "fueltank", label: "Fuel tank", icon: "kindFuelTank" },
  { id: "chiller", label: "Chiller", icon: "kindChiller" },
  { id: "crac", label: "Cooling unit", icon: "kindCrac" },
  { id: "fan", label: "Fan", icon: "kindFan" },
  { id: "pump", label: "Pump", icon: "kindPump" },
  { id: "server", label: "Server", icon: "kindServer" },
  { id: "switch", label: "Network switch", icon: "kindSwitch" },
  { id: "controller", label: "Controller", icon: "kindController" },
  { id: "sensor", label: "Sensor", icon: "kindSensor" },
  { id: "lighting", label: "Lighting", icon: "kindLighting" },
  { id: "camera", label: "Camera", icon: "kindCamera" },
  { id: "door", label: "Door", icon: "kindDoor" },
  { id: "fire", label: "Fire", icon: "kindFire" },
  { id: "leak", label: "Water leak", icon: "kindLeak" },
  { id: "generic", label: "Generic", icon: "kindGeneric" },
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
