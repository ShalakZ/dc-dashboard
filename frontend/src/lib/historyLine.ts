import type { Source } from "../api/types";
import { formatAge } from "./age";

/** The longest error the line shows: the server already took credentials out of it; this only keeps a long one from filling the row. */
const ERROR_MAX = 80;
const HOUR_MS = 3_600_000;

const clipped = (text: string) => (text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX - 1)}…` : text);

/** Whole hours from the ISO time `since` to `now` (epoch ms); null for no time or one that cannot be read. Never negative. */
function hoursSince(since: string | null, now: number): number | null {
  const at = since === null ? Number.NaN : Date.parse(since);
  return Number.isNaN(at) ? null : Math.floor(Math.max(0, now - at) / HOUR_MS);
}

/**
 * The second line under a source's name on the Sources page: how far its history backfill got, or null when there is nothing to say (a connector that keeps
 * no history, which is every real source today, shows nothing). A source that is filled by importing files is never polled and keeps no history, and says so.
 * A switched-off source that never ran says it is not filled, since nothing starts its fill.
 * The times in `history` are the server's, `now` is the browser's clock (epoch ms, as `ageNow` takes it): a clock that is off shifts the figures, never the state.
 */
export function historyLine(row: Pick<Source, "connector_type" | "polls" | "enabled" | "history">, now: number): string | null {
  if (row.polls === false || row.connector_type === "file") return "Filled by importing files";
  const history = row.history;
  if (!history || !history.supports_history) return null;
  switch (history.state) {
    case "never_run":
      // The automatic fill only takes sources that are switched on, so a switched-off one that never ran stays at never_run until somebody fills it by hand.
      return row.enabled === false ? "History: not filled (the source is switched off)" : "History: not started yet";
    case "filling": {
      // The automatic fill takes only sources that are switched on: a source switched off in the middle of a fill stands still, and "N hours behind" would grow for ever.
      if (row.enabled === false) return "History: paused (the source is switched off)";
      const hours = hoursSince(history.answered_through, now);
      if (hours === null) return "History: filling";
      if (hours === 0) return "History: filling, less than an hour behind";
      return `History: filling, ${hours.toLocaleString("en-US")} ${hours === 1 ? "hour" : "hours"} behind`;
    }
    case "idle": {
      const at = history.last_success_at === null ? Number.NaN : Date.parse(history.last_success_at);
      return Number.isNaN(at) ? "History: up to date" : `History: up to date, last fill ${formatAge((now - at) / 1000)}`;
    }
    case "backing_off": {
      const error = (history.last_error ?? "").replace(/\s+/g, " ").trim();
      return error ? `History: waiting, ${clipped(error)}` : "History: waiting";
    }
    default:
      return null; // not_supported, or a state a newer server sends: nothing is better than a wrong word
  }
}
