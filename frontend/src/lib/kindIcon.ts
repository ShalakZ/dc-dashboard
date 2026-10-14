import type { IconName } from "../components/Icon";

type KindIcon = Extract<IconName, `kind${string}`>;

// Walked top to bottom, the first row with a matching word wins: the specific equipment kinds come before the general places,
// and the voltage-class words (a weak hint: "LV Meter" is a meter, "MV Room" a room) come last. Words match WHOLE tokens only:
// "Panelling" must not look like a panel, so the aliases ("panelboard") are listed instead of guessing at substrings.
// W7o: the data-centre pack's rows (RPP, CDU, RMU, AHU, VFD, ATS, STS, busway, switchgear, patch panel, valve, heat exchanger, cooling tower,
// dry cooler, smoke detector, humidity, router, firewall, cable tray, hall) sit where their closest older word did, so every older answer holds
// except the ones that name the new equipment: "ATS" is no longer a circuit breaker, "Data Hall" no longer a room. The registry's own icon
// still wins for a registered kind (assetIcon); this table only guesses for text it does not know.
const TABLE: ReadonlyArray<readonly [KindIcon, ReadonlySet<string>]> = [
  ["kindUps", new Set(["ups", "rectifier", "inverter"])],
  ["kindBattery", new Set(["battery", "batteries", "bess"])],
  ["kindRpp", new Set(["rpp"])],
  ["kindCdu", new Set(["cdu"])],
  ["kindPdu", new Set(["pdu", "rpdu", "strip"])],
  ["kindGenerator", new Set(["generator", "genset", "gen"])],
  ["kindRmu", new Set(["rmu"])],
  ["kindTransformer", new Set(["transformer", "trafo", "xfmr", "substation"])],
  ["kindChiller", new Set(["chiller"])],
  ["kindAhu", new Set(["ahu"])],
  ["kindCrac", new Set(["crac", "crah"])],
  ["kindVfd", new Set(["vfd"])],
  ["kindFan", new Set(["fan"])],
  ["kindAts", new Set(["ats"])],
  ["kindSts", new Set(["sts"])],
  ["kindBusway", new Set(["busway"])],
  ["kindCircuit", new Set(["circuit", "breaker", "feeder", "busbar", "mcb", "mccb", "transferswitch"])],
  ["kindSwitchgear", new Set(["switchgear"])],
  ["kindPatchPanel", new Set(["patchpanel"])],
  ["kindPanel", new Set(["panel", "panelboard", "switchboard", "mdb"])],
  // the pump and the weak cooling words come after the panels ("Pump Control Panel" is a panel) and, in this order, still before the places:
  // "Cooling Pump" is a pump, "Cooling Tower" the cooling tower, "Pump Room" a pump
  ["kindPump", new Set(["pump"])],
  ["kindValve", new Set(["valve"])],
  ["kindHeatExchanger", new Set(["heatexchanger"])],
  ["kindCoolingTower", new Set(["coolingtower"])],
  ["kindDryCooler", new Set(["drycooler"])],
  ["kindCrac", new Set(["cooling", "cooler"])],
  ["kindMeter", new Set(["meter", "submeter", "metering"])],
  ["kindSmokeDetector", new Set(["smokedetector", "smoke"])],
  ["kindHumidity", new Set(["humidity"])],
  ["kindSensor", new Set(["sensor"])],
  ["kindRouter", new Set(["router"])],
  ["kindFirewall", new Set(["firewall"])],
  ["kindCableTray", new Set(["cabletray"])],
  ["kindRack", new Set(["rack", "cabinet", "enclosure"])],
  ["kindRow", new Set(["row", "aisle", "pod"])],
  ["kindHall", new Set(["hall"])],
  ["kindRoom", new Set(["room", "suite", "floor", "cage", "zone"])],
  ["kindBuilding", new Set(["building", "block", "tower", "plant"])],
  ["kindSite", new Set(["site", "dc", "datacenter", "datacentre", "campus", "facility"])],
  ["kindPanel", new Set(["lv", "mv", "hv", "db", "distribution"])],
];

// A kind is a short label; the clamp keeps the boundary regexes linear on absurd input.
const MAX_KIND_CHARS = 200;

// Two-word names that are one piece of equipment (W7o), each second word accepting a plural: "Cooling Towers" is the cooling tower, a
// lone "Cooling" the weak cooling-unit hint and a lone "Tower" a building. "air handling" and "ring main" need no "unit" after them.
const PAIRS: ReadonlyArray<readonly [string, RegExp, string]> = [
  ["air", /^handling$/, "ahu"],
  ["ring", /^main$/, "rmu"],
  ["cooling", /^towers?$/, "coolingtower"],
  ["dry", /^coolers?$/, "drycooler"],
  ["heat", /^exchangers?$/, "heatexchanger"],
  ["patch", /^panels?$/, "patchpanel"],
  ["cable", /^trays?$/, "cabletray"],
  ["smoke", /^detectors?$/, "smokedetector"],
];

/**
 * The words of a kind: split at camelCase and digit boundaries ("LVPanel", "DC1"), lower-cased, and a name made of several words made one:
 * "data" + "centre", "transfer" + "switch" (with "automatic" or "static" in front the "ats" or "sts"), "distribution" + "unit" (a "pdu"; with
 * "cooling" or "coolant" in front a "cdu"), "variable" + "frequency" or "speed" + "drive" (a "vfd"), "remote" + "power" + "panel" (an "rpp")
 * and the PAIRS above. Every join takes a plural; a word alone keeps its old meaning ("distribution" is still a panel hint, "tower" a building).
 */
function words(kind: string): string[] {
  const spaced = kind
    .slice(0, MAX_KIND_CHARS)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    // "PDUs" keeps its plural s ("PD Us" would be wrong); "UPSRoom" still splits.
    .replace(/([A-Z]+)([A-Z](?!s(?![a-z]))[a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2");
  const tokens = spaced.normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token !== "");
  const joined: string[] = [];
  for (const token of tokens) {
    const last = joined[joined.length - 1];
    const before = joined[joined.length - 2];
    const pair = PAIRS.find(([first, second]) => last === first && second.test(token));
    if (last === "data" && /^cent(?:er|re)s?$/.test(token)) joined[joined.length - 1] = `data${token}`;
    // The three-word names are tested before the shorter ones they contain: "cooling distribution unit" must not stop at the PDU's "distribution unit".
    else if ((before === "cooling" || before === "coolant") && last === "distribution" && /^units?$/.test(token)) joined.splice(-2, 2, "cdu");
    else if (before === "variable" && (last === "frequency" || last === "speed") && /^drives?$/.test(token)) joined.splice(-2, 2, "vfd");
    else if (before === "remote" && last === "power" && /^panels?$/.test(token)) joined.splice(-2, 2, "rpp");
    else if (last === "distribution" && /^units?$/.test(token)) joined[joined.length - 1] = "pdu";
    // One word before the plural strip below, which would turn "switches" into "switche": a bare "transfer" is not a circuit.
    else if (last === "transfer" && /^switch(?:es)?$/.test(token)) {
      if (before === "automatic" || before === "static") joined.splice(-2, 2, before === "automatic" ? "ats" : "sts");
      else joined[joined.length - 1] = "transferswitch";
    } else if (pair) joined[joined.length - 1] = pair[2];
    else joined.push(token);
  }
  return joined;
}

/** The icon for an asset kind: a pure, total function of the text, `kindGeneric` when no word is recognised. */
export function kindIcon(kind: string): IconName {
  const tokens = words(kind).flatMap((token) => (token.endsWith("s") ? [token, token.slice(0, -1)] : [token]));
  for (const [icon, known] of TABLE) {
    if (tokens.some((token) => known.has(token))) return icon;
  }
  return "kindGeneric";
}
