export interface LiveValue {
  ts: string;
  value: number | null;
  quality: number;
}

/**
 * Parse one SSE `data:` payload: a JSON list of [point_id, ts, value|null, quality].
 * The collector publishes `ts` as epoch seconds (float); ISO strings are accepted too.
 */
export function parseStreamMessage(data: string): [number, LiveValue][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: [number, LiveValue][] = [];
  for (const row of parsed) {
    if (!Array.isArray(row) || row.length < 4 || typeof row[0] !== "number") continue;
    const [pointId, rawTs, value, quality] = row as [number, number | string, number | null, number];
    const ts = typeof rawTs === "number" ? new Date(rawTs * 1000).toISOString() : rawTs;
    out.push([pointId, { ts, value: typeof value === "number" ? value : null, quality }]);
  }
  return out;
}

export function applyUpdates(
  current: Map<number, LiveValue>,
  updates: [number, LiveValue][],
  wanted: Set<number>,
): Map<number, LiveValue> {
  let next: Map<number, LiveValue> | null = null;
  for (const [pointId, live] of updates) {
    if (!wanted.has(pointId)) continue;
    next ??= new Map(current);
    next.set(pointId, live);
  }
  return next ?? current;
}
