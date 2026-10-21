"""The journal kinds the data path writes (the kinds of the older components live in `dcdash.core.journal`; nothing under
`core/` changes for this wave, so the kind strings of the ingest package sit here)."""

# readings.conflict: readings that were sent AGAIN for a time already stored, with a different value or quality. The stored
# value is kept (a reading is never updated). The message says how many; the detail holds the counts (new, already,
# differing, flushes) and up to five samples (point_id, ts, stored, resent), never a name or a secret.
READINGS_CONFLICT = "readings.conflict"
