export const RANGES = ["1h", "6h", "24h", "7d"] as const;
export type Range = (typeof RANGES)[number];

const HOURS: Record<Range, number> = { "1h": 1, "6h": 6, "24h": 24, "7d": 168 };

export function rangeToQuery(range: Range, now: Date = new Date()) {
  const end = now;
  const start = new Date(end.getTime() - HOURS[range] * 3600_000);
  return { start: start.toISOString(), end: end.toISOString(), buckets: 300 };
}

const TREND_REFETCH_MS: Record<Range, number> = { "1h": 10_000, "6h": 30_000, "24h": 60_000, "7d": 300_000 };

/** How often the asset page's Trend chart asks for fresh points: slower for longer ranges, whose buckets are wider (12 s on 1h, about 34 min on 7d). */
export function trendRefetchMs(range: Range): number {
  return TREND_REFETCH_MS[range];
}
