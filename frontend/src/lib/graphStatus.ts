import type { GraphSource } from "../api/types";

/** What a source node's status dot shows. The collector writes `online` / `offline`; a source never polled has any other value (`unknown`). */
export type StatusKey = "online" | "offline" | "credentials" | "idle";
export interface SourceStatus { key: StatusKey; label: string }

type StatusFacts = Pick<GraphSource, "enabled" | "status" | "needs_credentials">;

/**
 * The dot of a source node: "needs credentials" first (it is the thing the person has to do), then "disabled" (the collector does not poll a
 * source that is not enabled, whatever status it was left with), then online / offline by the stored status; any other status (`unknown`) is
 * "not polled". The raw status word stays in the node's text: the dot is decoration, colour is never the only signal.
 */
export function sourceStatus(source: StatusFacts): SourceStatus {
  if (source.needs_credentials) return { key: "credentials", label: "needs credentials" };
  if (!source.enabled) return { key: "idle", label: "disabled" };
  if (source.status === "online") return { key: "online", label: "online" };
  if (source.status === "offline") return { key: "offline", label: "offline" };
  return { key: "idle", label: "not polled" };
}

const PROTOCOLS: Readonly<Record<string, string>> = { opcua: "OPC UA", modbus: "Modbus", simulator: "Simulator" };

/** The protocol badge of a source node. The names match `lib/ports.ts`; a type the page does not know (there is no HTTP connector yet) shows its raw name. */
export function protocolLabel(type: string): string {
  return Object.hasOwn(PROTOCOLS, type) ? PROTOCOLS[type] : type;
}

/** A source whose edges may flow: it is polled (enabled) and its last poll worked. */
export function isLive(source: Pick<GraphSource, "enabled" | "status">): boolean {
  return source.enabled && source.status === "online";
}

/** Where a source listens, as `host:port` (`host` alone when there is no numeric port): from `config.host` and `config.port` (Modbus), else from the host and port of `config.endpoint` (OPC UA) or `config.url` (simulator), without the scheme and the path; "" when the config says nothing usable. Never throws. */
export function sourceAddress(source: Pick<GraphSource, "config">): string {
  const { config } = source;
  const text = (key: string) => (typeof config[key] === "string" ? (config[key] as string).trim() : "");
  const host = text("host");
  if (host) return typeof config.port === "number" ? `${host}:${config.port}` : host;
  for (const url of [text("endpoint"), text("url")]) {
    if (!url) continue;
    try {
      const found = new URL(url).host;
      if (found) return found;
    } catch {
      // not a url: try the next one
    }
  }
  return "";
}

/**
 * The name of a source without the address the scan appended to it ("OPC UA server at 172.20.0.2:4840" -> "OPC UA server", "Modbus Schneider PM5560 at
 * 10.0.0.5:502" -> "Modbus Schneider PM5560"): only when the name ENDS with ` at ` plus this source's own address, so a name somebody typed, or an
 * address that is not the source's, stays as it is, and so does a name that would be left empty. The full name stays the source's accessible name.
 */
export function sourceTitle(source: Pick<GraphSource, "name" | "config">): string {
  const address = sourceAddress(source);
  const tail = ` at ${address}`;
  if (!address || !source.name.endsWith(tail)) return source.name;
  const head = source.name.slice(0, -tail.length).trimEnd();
  return head === "" ? source.name : head;
}
