export const RANGES = ["1h", "6h", "24h", "7d"] as const;
export type Range = (typeof RANGES)[number];

const HOURS: Record<Range, number> = { "1h": 1, "6h": 6, "24h": 24, "7d": 168 };

export function rangeToQuery(range: Range, now: Date = new Date()) {
  const end = now;
  const start = new Date(end.getTime() - HOURS[range] * 3600_000);
  return { start: start.toISOString(), end: end.toISOString(), buckets: 300 };
}
