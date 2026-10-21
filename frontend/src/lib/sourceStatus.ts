import type { Source } from "../api/types";

/**
 * What the Status column says. The collector polls only enabled sources and only their mapped points, so a source with none of
 * either reads "not polled". Test and Browse jobs still write the stored status of such a source, so the last check stays visible.
 * A source that is filled by importing files (`polls` false) is never polled by design, so "not polled" would read as a fault: it says how it is filled.
 */
export function sourceStatusText(s: Pick<Source, "enabled" | "status" | "mapped_points" | "polls">): { text: string; polled: boolean } {
  if (s.polls === false) return { text: "filled by file import", polled: false };
  const last = s.status === "unknown" ? "" : `; last check: ${s.status}`;
  if (!s.enabled) return { text: `not polled (disabled)${last}`, polled: false };
  if (s.mapped_points === 0) return { text: `not polled (no mapped points)${last}`, polled: false };
  return { text: s.status, polled: true };
}
