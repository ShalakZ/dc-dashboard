# Storage

This page is for the administrator who sizes the database and decides how long readings are kept. Readings are stored in three tiers
(raw, 1-minute and 1-hour); this page says what each holds and for how long, which tier a chart reads, and what the Storage page's
controls do. Saving can delete data: read the paragraph on it below before shortening a retention.

## Storage tiers

| Tier | Table | Contents | Kept for (default) |
|---|---|---|---|
| raw | `readings` | every sample, compressed after `compress_after_days` (7) | `raw_retention_days` (30) |
| 1m | `readings_1m` | per-minute avg/min/max of good samples (`quality = 0`) | `rollup_1m_retention_days` (730) |
| 1h | `readings_1h` | per-hour avg/min/max of good samples | forever |

A chart reads whichever tier matches its bucket width: raw under one minute per bucket, `1m` under
one hour, `1h` beyond; the `series` response carries the chosen `tier` and the chart shows it as
"raw samples", "1-minute rollup" or "1-hour rollup". Rollups and retention are TimescaleDB
continuous aggregates and policies configured from the Storage settings; no application code ever
deletes readings.

**Defaults and resets.** Next to Save the Storage page has three buttons. *Set as default* remembers the values in the form as this
site's own default and changes nothing else. *Reset to default* fills the form with that default, or with the factory values (raw 30
days, compress after 7, 1-minute rollups 730, capacity 100 GB, warn at 80 %) when no default was set. *Reset to factory settings*
fills it with the factory values. The two Resets only fill in the form; nothing is saved until you press Save.

**Saving can delete data, so it asks first.** Retention deletes whole chunks (7 days wide for raw readings, 70 days for the 1-minute
rollup), and a save re-applies the policies, which TimescaleDB then runs within about a minute. So `PUT /api/settings/storage` answers
**409** unless the request carries `confirm=true` when the save shortens the raw or the 1-minute retention, or when chunks older than
the new limits exist that no scheduled retention would delete anyway (the state after a restore that paused retention: pressing Save
then deletes them, also with unchanged values). The 409 says how many chunks, which days and how much space they take; the page shows it in a
dialog. The audit row `storage.changed` records the `origin` of the values (`factory`, `site_default` or `manual`, judged by the
saved values) and, for a confirmed save, `confirmed_loss`.

## The Storage page

- **Storage** (admin): database and per-tier sizes, compression ratio, rows per day, growth and a
  projected days-until-full figure. Free disk space is not visible from the API container, so disk
  capacity is a setting: set it to the size of the volume holding the database. The page also edits
  raw retention, compression delay, 1-minute rollup retention and the warning threshold.
- **Removing assets or sources does not remove their readings.** Under the disk-capacity note the page says: *They leave when
  retention drops them (see the limits below), except the hourly summaries, which stay. Shorten the retention to free space sooner;
  saving a shorter retention asks first.* (The readings table has no link to assets or points, so a removal never touches it; the
  confirmation of a removal that takes mappings says the same, see [Dashboards and billing](dashboards-and-billing.md).) That is why
  the database does not shrink when you remove assets.
- **Permissions.** `storage.view` opens the page; `storage.edit` turns on Save, Set as default and the Resets (without it the form
  is read-only).
- **Limits on the values.** Raw retention is at least 8 days (one more than the 7-day rollup refresh window), at most 3650, and at
  least one day longer than the compression delay; the compression delay is 1 to 365 days; the 1-minute rollup retention is 30 to
  36500 days and never shorter than raw retention; the warning threshold is 50 to 99 %; the disk capacity is above 0 and at most
  1,000,000 GB.

The hourly rollup is the only permanent copy of the energy data: back it up ([Backup and restore](backup-and-restore.md)).

Related: [Sources and discovery](sources-and-discovery.md), [Dashboards and billing](dashboards-and-billing.md), [Backup and restore](backup-and-restore.md), [Screens](screens.md)
