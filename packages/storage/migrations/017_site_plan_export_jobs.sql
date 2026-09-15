-- 017_site_plan_export_jobs.sql
--
-- P-240 (OPS-24, 2026-09-15): port site-plan-export/refresh onto P-155's
-- async job pattern (013/014_feasibility_export_jobs*.sql). F7/P-240
-- measured 56.8-115.9s on Travis, all 201 -- the engine never failed; the
-- client's 55,000ms abort is what the customer experienced as a failure.
--
-- Unlike flood_drainage_refresh_jobs (016), this table DOES carry result
-- columns, because seven fields on the old synchronous refresh response
-- have no OTHER channel: `atom`/`artifacts` are already re-readable from
-- `GET .../site-plan-export`, but setbackDegenerate/setbackDegenerateReason/
-- setbackHonestAbsence/setbackHonestAbsenceReason/streetHonestAbsence/
-- zoningHonestAbsence/floodZoneHonestUnavailable are computed fresh by
-- authorParcelSitePlanExport() each call and were never persisted to the
-- atom -- exactly the situation 014 solved for feasibility's seven fields.
--
-- One row per parcelNodeId, same job-ref/state-machine contract as
-- feasibility_export_jobs and flood_drainage_refresh_jobs: `job_ref`
-- changes only on a genuinely NEW job; `never-requested` is the ABSENCE of
-- a row, never a stored state.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS site_plan_export_jobs (
  parcel_node_id                    text PRIMARY KEY,
  job_ref                           text NOT NULL,
  state                             text NOT NULL CHECK (state IN ('queued', 'running', 'ready', 'failed')),
  queued_at                         timestamptz NOT NULL DEFAULT now(),
  started_at                        timestamptz,
  completed_at                      timestamptz,
  failed_at                         timestamptz,
  error_class                       text,
  error_message                     text,
  result_setback_degenerate         boolean,
  result_setback_degenerate_reason  text,
  result_setback_honest_absence     boolean,
  result_setback_honest_absence_reason text,
  result_street_honest_absence      boolean,
  result_zoning_honest_absence      boolean,
  result_flood_zone_honest_unavailable boolean,
  updated_at                        timestamptz NOT NULL DEFAULT now()
);

-- Read path is a single-row lookup by primary key (parcel_node_id); no
-- extra index needed beyond the primary key itself.

INSERT INTO schema_migrations (filename)
VALUES ('017_site_plan_export_jobs.sql')
ON CONFLICT (filename) DO NOTHING;
