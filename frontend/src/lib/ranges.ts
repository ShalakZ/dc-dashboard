import type { RangePreset } from "../api/types";

export const RANGE_PRESETS: RangePreset[] = ["1h", "6h", "24h", "7d", "30d", "today", "yesterday", "this_month", "last_month"];

export const RANGE_LABELS: Record<RangePreset, string> = {
  "1h": "Last hour", "6h": "Last 6 hours", "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days",
  today: "Today", yesterday: "Yesterday", this_month: "This month", last_month: "Last month",
};

const ROLLING = new Set<RangePreset>(["1h", "6h", "24h", "7d", "30d"]);

/** Rolling presets end now; the others are whole calendar days or months in the site timezone. */
export function isRolling(preset: RangePreset): boolean {
  return ROLLING.has(preset);
}
