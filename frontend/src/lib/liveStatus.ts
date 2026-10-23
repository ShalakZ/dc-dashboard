import type { LiveStatus, SourceMeters } from "../api/types";

/** `4 s`, `3 min`, `2 h`, `5 d`: the largest unit that fits, floored. Negative or non-numeric reads `0 s`. */
export function agoText(seconds: number): string {
  if (!(seconds >= 0)) return "0 s";
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86400)} d`;
}

/**
 * `staleMeters` is there only for the stale-meters word, with the numbers it is made of: the chip draws " of {total}" as a part that a narrow window drops
 * (CSS decides, as it does for the detail). `total` is null when the server sent none that fits.
 */
export interface StatusView { state: "live" | "stale" | "offline" | "waiting"; word: string; detail: string | null; staleMeters?: { stale: number; total: number | null } }

/** A count the server sent: a whole number of one or more, else null (missing, null, zero, a fraction or not a number). */
const positive = (value: number | null | undefined): number | null => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null);

/** `3 of 48 meters stale`; `1 of 1 meter stale`; without a usable total, `3 meters stale`. */
export function staleMetersWord(stale: number, total: number | null): string {
  const noun = (total ?? stale) === 1 ? "meter" : "meters";
  return total === null ? `${stale} ${noun} stale` : `${stale} of ${total} ${noun} stale`;
}

/** `2 meters not rising`; `1 meter not rising`. */
export const notRisingWord = (count: number): string => `${count} ${count === 1 ? "meter" : "meters"} not rising`;

/**
 * The second line of a source's Last reading cell on the Sources page, only while the watchdog sees trouble: stale meters first (a frozen source's counters
 * are in `stale`, as in the chip), else counters that do not rise. `stale` picks the ink (the warning one; the other line is muted). Null when all is well, or
 * when the server sent no `meters` (an older server, a source without a billing meter). The hours stay out: the incident in the System events carries them.
 */
export function metersLine(meters: SourceMeters | null | undefined): { text: string; stale: boolean } | null {
  if (!meters) return null;
  const stale = positive(meters.stale);
  if (stale !== null) {
    const total = positive(meters.total);
    return { text: staleMetersWord(stale, total !== null && total >= stale ? total : null), stale: true };
  }
  const still = positive(meters.not_advancing);
  return still === null ? null : { text: notRisingWord(still), stale: false };
}

/**
 * What the top bar's chip says, in this order (w35): a collector that is down is named first, even when old readings still count as fresh;
 * then the billing meters that stopped answering (the data watchdog, from the server's verdict); then the readings' own verdict as before.
 * Freshness is the server's verdict (each mapping against its own poll interval): the age is a caption, never a cutoff here.
 * A server without the meter fields (or one that sent null for them) gets exactly today's words. When the readings are fresh but energy counters
 * stand still, the word stays `Live` and the caption says how many ("2 meters not rising") in place of the age.
 */
export function statusView(status: LiveStatus | undefined): StatusView | null {
  if (!status) return null;
  if (!status.collector_alive) return { state: "offline", word: "Collector offline", detail: null };
  const stale = positive(status.meters_stale);
  if (stale !== null) {
    const counted = positive(status.meters);
    const total = counted !== null && counted >= stale ? counted : null;
    const oldest = status.oldest_stale_age_seconds;
    const detail = typeof oldest === "number" && Number.isFinite(oldest) ? `oldest ${agoText(oldest)} ago` : null;
    return { state: "stale", word: staleMetersWord(stale, total), detail, staleMeters: { stale, total } };
  }
  if (status.readings_fresh === null) return { state: "waiting", word: "No readings yet", detail: null };
  const age = status.last_reading_age_seconds;
  const detail = age === null ? null : `last reading ${agoText(age)} ago`;
  if (!status.readings_fresh) return { state: "stale", word: "Stale", detail };
  const still = positive(status.meters_not_advancing);
  return { state: "live", word: "Live", detail: still === null ? detail : notRisingWord(still) };
}
