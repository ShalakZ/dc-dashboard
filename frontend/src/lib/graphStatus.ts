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
