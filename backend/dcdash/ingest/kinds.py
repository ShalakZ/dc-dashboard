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
