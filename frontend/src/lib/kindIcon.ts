import type { IconName } from "../components/Icon";

type KindIcon = Extract<IconName, `kind${string}`>;

// Walked top to bottom, the first row with a matching word wins: the specific equipment kinds come before the general places,
// and the voltage-class words (a weak hint: "LV Meter" is a meter, "MV Room" a room) come last. Words match WHOLE tokens only:
// "Panelling" must not look like a panel, so the aliases ("panelboard") are listed instead of guessing at substrings.
const TABLE: ReadonlyArray<readonly [KindIcon, ReadonlySet<string>]> = [
  ["kindUps", new Set(["ups", "rectifier", "inverter"])],
  ["kindBattery", new Set(["battery", "batteries", "bess"])],
  ["kindPdu", new Set(["pdu", "rpp", "rpdu", "strip"])],
  ["kindGenerator", new Set(["generator", "genset", "gen"])],
  ["kindTransformer", new Set(["transformer", "trafo", "xfmr", "substation"])],
  ["kindChiller", new Set(["chiller"])],
  ["kindCrac", new Set(["crac", "crah", "ahu"])],
  ["kindFan", new Set(["fan"])],
  ["kindPump", new Set(["pump"])],
  // the weak words come after the fan and the pump: "Cooling Pump" is a pump, "Cooling Tower" still the cooling unit
  ["kindCrac", new Set(["cooling", "cooler"])],
  ["kindCircuit", new Set(["circuit", "breaker", "feeder", "ats", "sts", "busway", "busbar", "mcb", "mccb", "transferswitch"])],
  ["kindPanel", new Set(["panel", "panelboard", "switchboard", "switchgear", "mdb"])],
  ["kindMeter", new Set(["meter", "submeter", "metering"])],
  ["kindSensor", new Set(["sensor"])],
  ["kindRack", new Set(["rack", "cabinet", "enclosure"])],
  ["kindRow", new Set(["row", "aisle", "pod"])],
  ["kindRoom", new Set(["room", "hall", "suite", "floor", "cage", "zone"])],
  ["kindBuilding", new Set(["building", "block", "tower", "plant"])],
  ["kindSite", new Set(["site", "dc", "datacenter", "datacentre", "campus", "facility"])],
  ["kindPanel", new Set(["lv", "mv", "hv", "db", "distribution"])],
];

// A kind is a short label; the clamp keeps the boundary regexes linear on absurd input.
const MAX_KIND_CHARS = 200;

/** The words of a kind: split at camelCase and digit boundaries ("LVPanel", "DC1"), lower-cased, "data" + "centre" joined, "transfer" + "switch" joined, "distribution" + "unit" made one "pdu". */
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
    if (last === "data" && /^cent(?:er|re)s?$/.test(token)) joined[joined.length - 1] = `data${token}`;
    else if (last === "distribution" && /^units?$/.test(token)) joined[joined.length - 1] = "pdu";
    // One word before the plural strip below, which would turn "switches" into "switche": a bare "transfer" is not a circuit.
    else if (last === "transfer" && /^switch(?:es)?$/.test(token)) joined[joined.length - 1] = "transferswitch";
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
