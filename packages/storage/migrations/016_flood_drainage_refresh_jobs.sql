-- 016_flood_drainage_refresh_jobs.sql
--
-- P-240 (OPS-24, 2026-09-15): port flood-drainage/refresh onto P-155's async
-- job pattern (013_feasibility_export_jobs.sql). F7/P-240 measured 56-75s on
-- Travis with 6 of 11 calls over the client's 55,000ms abort while the engine
-- itself returned 201 on all 11 -- the same "engine never failed, client gave
-- up and reported the wrong mechanism" shape P-155 fixed for feasibility.
--
-- Unlike feasibility_export_jobs, this table carries NO result columns: the
-- old synchronous refresh response's two payloads (`study`, `artifact`) both
-- already have their own read paths after the fact --
-- `GET .../flood-drainage/study` and `GET .../flood-drainage/download` --
-- so there is nothing left that only ever existed on the refresh response
-- body. The job row exists purely to answer "queued / running / ready /
-- failed / never-requested" for the poll leg.
--
-- One row per parcelNodeId, same job-ref/state-machine contract as
-- feasibility_export_jobs: `job_ref` changes only on a genuinely NEW job;
-- `never-requested` is the ABSENCE of a row, never a stored state.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS flood_drainage_refresh_jobs (
  parcel_node_id text PRIMARY KEY,
  job_ref        text NOT NULL,
  state          text NOT NULL CHECK (state IN ('queued', 'running', 'ready', 'failed')),
  queued_at      timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  completed_at   timestamptz,
  failed_at      timestamptz,
  error_class    text,
  error_message  text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Read path is a single-row lookup by primary key (parcel_node_id); no
-- extra index needed beyond the primary key itself.

INSERT INTO schema_migrations (filename)
VALUES ('016_flood_drainage_refresh_jobs.sql')
ON CONFLICT (filename) DO NOTHING;
