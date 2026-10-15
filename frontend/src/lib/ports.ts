/**
 * The TCP ports the operator meets on the Scans page, by name, and a gentle typo guard for the scope form.
 *
 * The names are the ports the connectors listen on by default (`default_ports` in backend/dcdash/connectors/*.py; backend/tests/test_ports_parity.py
 * fails when one is missing here) and the one the dev simulator's Modbus server uses. A port the page does not name is shown as the bare number.
 */
export const PORT_NAMES: Readonly<Record<number, string>> = {
  502: "Modbus",
  4840: "OPC UA",
  9000: "simulator",
  5020: "Modbus, simulator",
};

export function portName(port: number): string | undefined {
  return PORT_NAMES[port];
}

/** `4840 (OPC UA)`, or `4080` for a port without a name. */
export function portLabel(port: number): string {
  const name = portName(port);
  return name ? `${port} (${name})` : String(port);
}

/** A list of ports as the operator reads them: `9000 (simulator), 4840 (OPC UA), 4080`. A typo shows as the bare number beside its named neighbours. */
export function portsLine(ports: readonly number[]): string {
  return ports.map(portLabel).join(", ");
}

/** The ports the page knows without asking the server, with the server's suggested ports added: each once, smallest first. */
export function knownPorts(suggested: readonly number[] = []): number[] {
  const named = Object.keys(PORT_NAMES).map(Number);
  return [...new Set([...named, ...suggested])].sort((a, b) => a - b);
}

/** Ports of everyday services: a scan of them is deliberate, whatever they look like. */
export const COMMON_PORTS: readonly number[] = [
  20, 21, 22, 23, 25, 53, 80, 110, 123, 143, 161, 389, 443, 445, 465, 587, 636, 993, 995, 1433, 1521, 1883, 2049, 3000, 3306, 3389, 4000, 4443,
  5000, 5001, 5432, 5672, 5900, 6379, 8000, 8001, 8008, 8080, 8081, 8443, 8883, 8888, 9001, 9090, 9200, 9443, 27017,
];

/** Ports of the industrial protocols other than the ones with a connector here (Modbus variants, OPC UA TLS, S7, EtherNet/IP, BACnet, DNP3 ...). */
export const INDUSTRIAL_PORTS: readonly number[] = [
  102, 623, 789, 802, 1502, 1911, 2222, 2404, 4843, 4911, 5007, 9100, 9600, 18245, 20000, 34962, 34963, 34964, 44818, 47808,
];

/** The demo port is named in the readout but is not worth nagging about: it is not an anchor of the guard. */
const DEMO_PORT = 9000;

const hamming = (a: string, b: string) => [...a].reduce((n, ch, i) => n + (ch === b[i] ? 0 : 1), 0);

/** True when `a` becomes `b` by one insert, delete, substitute or swap of two neighbours (or they are equal). */
function withinOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const apart = [...a].flatMap((ch, i) => (ch === b[i] ? [] : [i]));
    if (apart.length <= 1) return true;
    const [i, j] = apart;
    return apart.length === 2 && j === i + 1 && a[i] === b[j] && a[j] === b[i];
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  return long.slice(i + 1) === short.slice(i);
}

/** 1 when the typed port is one edit from the anchor, 2 when it is two letters off at the same length (4+ digits, same first digit), else null. */
function nearness(typed: string, anchor: string): 1 | 2 | null {
  if (withinOne(typed, anchor)) return 1;
  if (typed.length === anchor.length && typed.length >= 4 && typed[0] === anchor[0] && hamming(typed, anchor) <= 2) return 2;
  return null;
}

export interface PortHint {
  port: number;
  near: number;
  text: string;
}

/**
 * A warning for a typed port that looks like a typo of a known one, or null. It never blocks anything: it is a line of text under the field.
 * `known` is every port the page knows (the static names plus what the server suggests, see `knownPorts`). The anchors are `known` without the
 * demo port; a port that is known, common or industrial is left alone, as is anything under three digits. Of several anchors the nearer wins,
 * then the one with as many digits as the typed port, then the smaller.
 */
export function portHint(port: number, known: readonly number[] = knownPorts()): PortHint | null {
  const typed = String(port);
  if (typed.length < 3) return null;
  if (known.includes(port) || COMMON_PORTS.includes(port) || INDUSTRIAL_PORTS.includes(port)) return null;
  const ranked = known
    .filter((anchor) => anchor !== DEMO_PORT)
    .flatMap((anchor) => {
      const distance = nearness(typed, String(anchor));
      return distance === null ? [] : [{ anchor, distance, otherLength: String(anchor).length === typed.length ? 0 : 1 }];
    })
    .sort((a, b) => a.distance - b.distance || a.otherLength - b.otherLength || a.anchor - b.anchor);
  const best = ranked[0];
  if (!best) return null;
  return { port, near: best.anchor, text: `${port} is not a port any connector uses; did you mean ${portLabel(best.anchor)}?` };
}

/**
 * The warning for a typed list: the FIRST suspect port's warning in full (each port counted once), and how many other suspect ports there are.
 * The form draws the warning and, when `more` is above 0, ONE line from `moreLine`; a list of warnings would make the reserved slot grow
 * and move the Save button, which is what the slot is there to prevent.
 */
export function portHints(ports: readonly number[], known: readonly number[] = knownPorts()): { first: string | null; more: number } {
  const hints = [...new Set(ports)].flatMap((port) => portHint(port, known) ?? []);
  return { first: hints[0]?.text ?? null, more: Math.max(0, hints.length - 1) };
}

/** The line that counts the warnings that are not shown: `and 1 more port looks like a typo.`, `and 4 more ports look like typos.` */
export function moreLine(more: number): string {
  return more === 1 ? "and 1 more port looks like a typo." : `and ${more} more ports look like typos.`;
}

/** The valid ports in what is typed in the Ports field, in order, for the readout and the guard: anything that is not a port (a word, 0, 70000) is left out, the save reports it. */
export function readPorts(text: string): number[] {
  return text
    .split(/[\s,]+/)
    .filter((part) => /^\d{1,5}$/.test(part))
    .map(Number)
    .filter((port) => port >= 1 && port <= 65535);
}
