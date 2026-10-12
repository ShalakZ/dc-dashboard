import type { StorageSettings } from "../api/types";

export type TileKey = "database" | "readings" | "rollups" | "growth" | "projected";

/** What each retention and capacity field does, true to core/storage.py: raw chunks are dropped whole (7 days wide) by a daily job, the hourly tier has no retention policy. */
export const FIELD_HELP: Record<keyof StorageSettings, string> = {
  raw_retention_days:
    "Raw readings older than this are deleted by a daily job, about a week at a time, so some stay up to a week longer. The 1-minute averages follow their own setting; the 1-hour averages are kept for good.",
  compress_after_days:
    "Readings older than this are compressed in the background to save disk space. They stay available, they just take less room.",
  rollup_1m_retention_days: "How long the 1-minute averages are kept. The 1-hour averages have no limit.",
  disk_capacity_gb:
    "The size of the disk that holds the database. The dashboard cannot see the disk itself, so it uses this number to work out the percentage used and when the database will fill it.",
  warn_threshold_pct: "The warning banner above appears when the database uses this share of the capacity.",
};

/** What each summary tile counts (storage_stats in core/storage.py). */
export const TILE_HELP: Record<TileKey, string> = {
  database: "Everything the database holds on disk: the readings, the 1-minute and 1-hour averages, and the rest (users, settings, the audit log).",
  readings:
    "The raw readings. Older readings are compressed to save space. The smaller line compares the size of the readings already compressed with the size they had before.",
  rollups:
    "Averages the database builds from the raw readings: one value per minute and one per hour. They take little room and outlive the raw readings.",
  growth: "How much the raw readings grow per day, averaged over the whole time they have been stored. The estimate of when the disk is full uses it.",
  projected:
    "Days until the database fills the disk capacity set below if it keeps growing at this rate. Not growing means no growth was measured. The percentage is how much of the capacity is used now.",
};
