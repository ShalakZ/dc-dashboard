-- Run by scripts/restore.sh and scripts/restore.ps1 after pg_restore and BEFORE timescaledb_post_restore().
-- psql variable apply_retention: 1 leaves the restored retention jobs scheduled, 0 pauses them when they would delete data.
-- Why here: the restored retention jobs have no next start, so they run the moment TimescaleDB's background workers come back
-- (post_restore). A job that is paused before that point never runs, and the old chunks survive.
\set ON_ERROR_STOP on
\pset footer off
\echo
\echo 'What the restored retention policies would delete as soon as they run:'
SELECT j.hypertable_name AS "table",
       j.config->>'drop_after' AS "keeps",
       j.scheduled AS "scheduled",
       d.chunks AS "chunks to drop",
       d.first_day AS "oldest day",
       d.last_day AS "newest day"
FROM timescaledb_information.jobs j
CROSS JOIN LATERAL (
    SELECT count(*) AS chunks, min(i.range_start)::date AS first_day, max(i.range_end)::date AS last_day
    FROM show_chunks(format('%I.%I', j.hypertable_schema, j.hypertable_name)::regclass,
                     older_than => (j.config->>'drop_after')::interval) c
    JOIN timescaledb_information.chunks i ON format('%I.%I', i.chunk_schema, i.chunk_name) = c::text
) d
WHERE j.proc_name = 'policy_retention'
ORDER BY j.job_id;

SELECT EXISTS (
    SELECT 1 FROM timescaledb_information.jobs j
    WHERE j.proc_name = 'policy_retention' AND j.scheduled
      AND EXISTS (SELECT 1 FROM show_chunks(format('%I.%I', j.hypertable_schema, j.hypertable_name)::regclass,
                                            older_than => (j.config->>'drop_after')::interval))
) AS would_drop \gset

\if :would_drop
    \if :apply_retention
        \echo 'Retention is left as restored (--apply-retention): scheduled jobs delete the chunks above as soon as the database starts its background jobs.'
    \else
        SELECT count(*) AS "retention jobs paused"
        FROM (SELECT alter_job(job_id, scheduled => false)
              FROM timescaledb_information.jobs WHERE proc_name = 'policy_retention') paused;
        \echo 'Retention is PAUSED so that the data above survives the restore. Nothing is deleted while it is paused,'
        \echo 'and the disk is not trimmed either: open Storage and press Save to start retention again (that deletes the chunks above).'
    \endif
\else
    \echo 'Nothing would be deleted now.'
\endif
