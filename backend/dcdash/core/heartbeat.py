"""The collector's heartbeat: one row in `settings` that the collector rewrites every few seconds and the API reads."""
HEARTBEAT_KEY = "collector_heartbeat"
HEARTBEAT_SECONDS = 10.0
# Three missed beats. The age is computed by the database (now() minus the stored now()), so no clock of the collector,
# the api or the browser enters into it.
STALE_AFTER_SECONDS = 30.0
