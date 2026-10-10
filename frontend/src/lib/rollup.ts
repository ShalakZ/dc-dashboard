import type { RollupSource } from "../api/types";
import { liveOrFetched } from "./live";
import type { LiveValue } from "./stream";

export type { RollupSource };

export interface RollupPower {
  /** The sum, or null when no source has a good fresh reading (never 0 for "nothing known"). */
  kw: number | null;
  counted: number;
  of: number;
  missing: RollupSource[];
}

/** The plain sum of the sources that have a good, fresh reading (the stream beats the fetched row when it is newer, see liveOrFetched). */
export function rollupPower(sources: readonly RollupSource[], live: ReadonlyMap<number, LiveValue>): RollupPower {
  let kw = 0;
  const missing: RollupSource[] = [];
  for (const s of sources) {
    const r = liveOrFetched(live.get(s.point_id), { value: s.value, ts: s.ts, stale: s.stale, no_data: s.value === null });
    if (r.stale || r.noData || r.value === null || !Number.isFinite(r.value)) missing.push(s);
    else kw += r.value;
  }
  const counted = sources.length - missing.length;
  return { kw: counted > 0 ? kw : null, counted, of: sources.length, missing };
}

const OWN_METER_TIP = "This asset has no power meter of its own: the figure is the sum of its sub-assets' meters.";

/**
 * The line under the figure, its tooltip and, when some but not all meters are silent, the list of the silent ones for a visible
 * line (`silent`, else null). Meters are named by path, so two sub-assets with one name can be told apart.
 */
export function rollupNote(
  { counted, of, missing }: RollupPower,
  sources: readonly RollupSource[],
): { text: string; title: string; silent: string | null } {
  let text: string;
  if (counted === of) text = `Sum of the live power of ${of === 1 ? "1 meter" : `${of} meters`} below`;
  else if (counted > 0) text = `Sum of ${counted} of ${of} meters below; ${of - counted === 1 ? "the other is" : "the others are"} not reporting`;
  else text = of === 1 ? "The meter below is not reporting" : `None of the ${of} meters below is reporting`;
  const names = (list: readonly RollupSource[]) => list.map((s) => s.path).join(", ");
  const detail = missing.length > 0 ? `Not reporting: ${names(missing)}.` : `Meters: ${names(sources)}.`;
  return { text, title: `${OWN_METER_TIP} ${detail}`, silent: counted > 0 && missing.length > 0 ? names(missing) : null };
}
