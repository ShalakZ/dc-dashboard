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
  confirmation of a removal that takes mappings says that the readings stay stored too, see
  [Dashboards and billing](dashboards-and-billing.md).) That is why the database does not shrink when you remove assets.
- **Permissions.** `storage.view` opens the page; `storage.edit` turns on Save, Set as default and the Resets (without it the form
  is read-only).
- **Limits on the values.** Raw retention is at least 8 days (one more than the 7-day rollup refresh window), at most 3650, and at
  least one day longer than the compression delay; the compression delay is 1 to 365 days; the 1-minute rollup retention is 30 to
  36500 days and never shorter than raw retention; the warning threshold is 50 to 99 %; the disk capacity is above 0 and at most
  1,000,000 GB.

The hourly rollup is the only permanent copy of the energy data: back it up ([Backup and restore](backup-and-restore.md)).

## How long system events are kept

The card **System events and the audit log** (at the bottom of the Storage page) says how long the system's own events are kept
([System events](screens.md), the journal of sources going offline and coming back, checks, imports and errors): by default **90 days or
the newest 100,000 events, whichever is fewer** (before w32 it was a fixed 14 days and 20,000, not a setting), and how many are kept now
with the day of the oldest ("Kept now: 3,412, the oldest from 24 Jul."). Under it the card says that **the audit log is kept forever**:
nothing deletes it, so the record of who did what is not part of this limit.

**Change...** (needs `storage.edit`; `storage.view` shows the card) opens a small dialog with the two limits and the range each accepts:
7 to 400 days, and 10,000 to 1,000,000 events. A value outside the range, or a half-filled form, is refused. The collector applies the
setting at its next hourly clean-up (if the stored value is missing or broken it uses the defaults, so the clean-up always has a rule).

**Shortening asks first.** Saving a shorter time or a lower number first asks the server what it would delete: when events would go, the
dialog says "About N events will be deleted within the hour" and the button becomes **Confirm and save** (the focus moves to **Cancel**, so a
repeated Enter cannot confirm it unread; Tab reaches the confirming button); the events themselves are
deleted by the next hourly clean-up, not by the save. N counts the events the new limits delete that the old ones would not, each once even
if both limits reach it, and leaves out open problems. Lengthening needs no confirmation. The audit row `events.retention_changed`
records the values before and after and, for a confirmed save, how many events were about to go.

**What is never deleted early.** A problem that is still open (a source that is down or reading badly and has not answered again) is never
deleted, by age or by count, however old it is, because it is the one row that says the source is still down. A closed one is kept until
its *closing* is older than the limit, so a long outage that has just ended is not removed at the next clean-up.

## The data watchdog

The card **Data watchdog** (under the System events card) says when the platform calls a billing meter stale and an energy counter not
rising: by default "Meters are stale after 5 minutes without a good reading (or 3 polls, whichever is longer); energy counters are
flagged after 6 hours without rising." What those words mean for the top bar, the Sources page, System events and the
`GET /api/health/data` URL is on [Operating the stack](operating.md#when-a-meter-counts-as-stale).

**Change...** (needs `storage.edit`; `storage.view` shows the card) opens the dialog **Change when meters count as stale** with the two
numbers and the range each accepts: **Stale after (minutes)**, 2 to 60, and **Counter not rising after (hours)**, 1 to 72. A value outside
the range, a fraction or a half-filled form is refused with a sentence. A shorter time finds a dead meter sooner and may flag one that is
only slow; a longer one is calmer and slower to tell. The meter's own rhythm still counts: a meter polled every 5 minutes is stale
after at least 15 (three of its own polls, or the floor when that is longer). Saving deletes nothing and asks nothing, so there is no confirmation step.

**When it takes effect.** The top bar, the Sources line and the URL use the new numbers within a few seconds (the verdict is kept for at
most 5 seconds, and a save drops it). A `data.stale` incident in System events follows at the figures service's second look in a row that finds trouble: the service looks
about once a minute, so it opens 1 to 3 minutes after the meter turns stale. A missing or damaged stored value reads as the factory values, so the watchdog always has a rule.

**The audit entry.** A save that changes a number is recorded as `watchdog.changed` with the values before and after (a save that changes
nothing writes no entry), and the Audit page words it like this:
`Changed the data watchdog: stale after 10 minutes (was 5), counters flagged after 12 hours (was 6)`. It lists only the number or
numbers that changed.

## Filling older gaps

When a source keeps its own history, the platform can fill the holes an outage leaves
([History and backfill](sources-and-discovery.md#history-and-backfill)). How far back that reaches depends on the raw retention.

- **Automatic fills stay inside the lookback**: 7 days (`DCDASH_HISTORY_LOOKBACK_DAYS`), and never further than two days inside the raw
  retention. The refresh policies of the rollups cover the last 7 days, so a row that old reaches the 1-minute rollup in about a minute
  and the hourly rollup in about 10 minutes by itself (measured on a row 3 days old).
- **The fill command reaches back to the raw retention minus a day** (29 days with the default of 30), and it refreshes the rollups itself
  over what it stored. A row older than the 7-day window stayed out of both rollups until a refresh (measured on a row 10 days old).
- **"Older than that cannot be added" is by design.** The default raw retention is 30 days, so a gap of 40 days cannot be filled. The raw
  readings of those days are gone; only the rollups remain.
- **Why the platform refuses instead of trying.** Refreshing a rollup over a range recomputes every bucket in it from the raw readings.
  If the raw readings of some of those minutes are gone, the refresh would recompute them from nothing and delete real rollup history.
  This was measured: after a raw chunk was dropped, a refresh over its range took the rollup from 21 rows to 0 (1-minute) and from 1 row
  to 0 (hourly). So before it asks the source, the platform checks the 1-minute rollup for minutes in the range whose raw readings are
  gone, and when it finds one it writes nothing and says so. A file import follows the same rule: it refuses every row in a stretch whose raw
  readings the retention removed while the 1-minute rollup kept the summaries (reason `older_than_stored_raw_readings`). The stretch ends at
  the first whole hour after the newest such minute, no later rise of the retention reopens it, and a row after it is stored even when the
  raw table is empty.
- **What to do for an older gap.** Raise the raw retention on the Storage page before the gap becomes older than it, because retention
  drops raw chunks of 7 days at a time and raising it later cannot bring back what was dropped. A longer retention costs space; the
  page's size projection shows how much. A gap whose raw readings retention has already dropped cannot be filled, whatever you set now:
  neither a fill nor a file import reaches it, and raising the retention afterwards does not change that.
- **Filling into a compressed chunk works.** Readings older than the compression delay (7 days by default) are stored compressed. A
  fill writes into such a chunk, the database checks the new readings against the stored ones, and the chunk stays compressed. It costs
  about 35 ms per 1,000 rows (a few milliseconds per 1,000 in an uncompressed chunk): 20,000 rows take about 0.9 seconds and 60,000
  about 2.2 seconds.

Related: [Sources and discovery](sources-and-discovery.md), [Dashboards and billing](dashboards-and-billing.md), [Backup and restore](backup-and-restore.md), [Screens](screens.md)
