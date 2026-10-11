import type { LiveStatus } from "../api/types";

/** `4 s`, `3 min`, `2 h`, `5 d`: the largest unit that fits, floored. Negative or non-numeric reads `0 s`. */
export function agoText(seconds: number): string {
  if (!(seconds >= 0)) return "0 s";
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86400)} d`;
}

export interface StatusView { state: "live" | "stale" | "offline" | "waiting"; word: string; detail: string | null }

/**
 * What the top bar's chip says. A collector that is down is named first, even when old readings still count as fresh.
 * Freshness is the server's verdict (each mapping against its own poll interval): the age is a caption, never a cutoff here.
 */
export function statusView(status: LiveStatus | undefined): StatusView | null {
  if (!status) return null;
  if (!status.collector_alive) return { state: "offline", word: "Collector offline", detail: null };
  if (status.readings_fresh === null) return { state: "waiting", word: "No readings yet", detail: null };
  const age = status.last_reading_age_seconds;
  const detail = age === null ? null : `last reading ${agoText(age)} ago`;
  return status.readings_fresh ? { state: "live", word: "Live", detail } : { state: "stale", word: "Stale", detail };
}
