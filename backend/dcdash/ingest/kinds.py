"""The journal kinds the data path writes (the kinds of the older components live in `dcdash.core.journal`; nothing under
`core/` changes for this wave, so the kind strings of the ingest package sit here)."""

# readings.conflict: readings that were sent AGAIN for a time already stored, with a different value or quality. The stored
# value is kept (a reading is never updated). The message says how many; the detail holds the counts (new, already,
# differing, flushes) and up to five samples (point_id, ts, stored, resent), never a name or a secret.
READINGS_CONFLICT = "readings.conflict"

# history.filled: one backfill cycle (or one fill command) stored NEW readings from a source's history; the detail holds the counts
# (new, already, differing, rejected, requests) and the window. info.
HISTORY_FILLED = "history.filled"
# history.failed: the backfill of a source stopped or could not start (the source is unreachable, refused our credentials, cannot
# answer a history read, a batch was set aside, or the rollups cannot be refreshed safely). Written when the trouble begins and then
# at most every 15 minutes while it lasts; `code` names the cause. warning (info for "this source keeps no history").
HISTORY_FAILED = "history.failed"
# history.closed_month: NEW readings landed in a month an administrator has closed. The readings are stored, the frozen figures of
# the closed month do not change (Billing shows "today's figures differ"); the detail names the month. One per month and cycle. info.
HISTORY_CLOSED_MONTH = "history.closed_month"

# import.finished: one real import of a file into a source finished (or stopped half-way); the detail holds the counts (read, new,
# already, differing, rejected, unknown rows), the closed months it wrote into and whether it was complete. Never a value. info
# (warning when it stopped half-way).
IMPORT_FINISHED = "import.finished"

# data.stale (w35): ONE incident per source while its billing meters give no good reading (or its energy counters stand still although each
# reads Good). Written by the figures worker (component `figures`) from the data freshness verdict, opened on the second evaluation in a row
# that finds trouble. `detail` holds `state` (open | closed), `count` (evaluations that found it), `last_at`, `since`, once closed `closed_at`,
# `duration_seconds` and `closed_by` (recovered | polling_stopped), and the numbers: `meters`, `stale`, `not_advancing`, `frozen`,
# `oldest_stale_age_seconds`. The message counts and gives the oldest age, never a name, an address or a value. error when a meter is silent
# or the source is frozen, warning when only counters have stopped rising. NOT in the collector's incident kinds: its reconcile never touches it.
DATA_STALE = "data.stale"
# data.recovered: the source that had a data.stale incident reports good readings again (the incident is closed `recovered`); the detail holds
# `incident_id`, `stale_seconds` and `meters`. info. Nothing is written when the incident ends because the source is no longer judged.
DATA_RECOVERED = "data.recovered"
# readings.dropped: the writer's buffer was full and the oldest readings were thrown away (a database that stayed away too long). The detail holds
# the counts `dropped` (since the last report), `buffer` (its limit) and `flushes_failed`, never a name or a value. Written after the next
# successful commit, at most once per 10 minutes, with no source. error.
READINGS_DROPPED = "readings.dropped"
