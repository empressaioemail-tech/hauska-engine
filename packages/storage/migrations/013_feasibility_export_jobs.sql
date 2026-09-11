-- 013_feasibility_export_jobs.sql
--
-- P-155 (OPS-23 FEASIBILITY, 2026-09-11): the feasibility-export refresh
-- becomes asynchronous. Before this migration the ONLY persisted state for
-- a feasibility run was the `parcel-terrain-model` atom's
-- `artifacts["pdf-feasibility"]` record, written once, after the PDF is
-- already stored -- there was no way to tell "running" from "never
-- requested" from "failed" (F7, OPS-23 section 2).
--
-- This table is a SMALL JOB ROW BESIDE the artifact record, not a widening
-- of the atom's `artifacts` type. `ParcelTerrainModelAtomInstance.artifacts`
-- is documented in packages/atoms/src/property-instances.ts as a CLOSED
-- type ("TerrainExportArtifact is a closed type in the atom schema, and
-- widening it is the substrate seat's call" -- feasibility-author.ts
-- comment above the `atom.artifacts["pdf-feasibility"] = ...` write). The
-- property seat (this lane) does not own that type and does not widen it.
-- A dedicated table keeps the job-lifecycle concern (this seat's, purely
-- operational bookkeeping -- never a fact about the parcel) out of a
-- schema another seat owns, while still living beside the same storage
-- port the artifact record already goes through.
--
-- One row per parcelNodeId: only one feasibility job may be in flight for
-- a given parcel at a time (a second refresh while `running` returns the
-- existing job's reference rather than starting a second job -- P-155
-- item 2). `job_ref` changes on every NEW job (a fresh `queued` row); it
-- does not change across `queued` -> `running` -> `ready`/`failed`
-- transitions of the SAME job.
--
-- States, by type (`state` column), never by sentinel:
--   queued   - refresh accepted, authoring not yet started
--   running  - authoring in progress (`started_at` set)
--   ready    - authoring succeeded (`artifact_ref` + `completed_at` set)
--   failed   - authoring threw (`error_class` + `failed_at` set)
-- `never-requested` is NOT a row in this table -- it is the absence of a
-- row for a parcelNodeId, per P-155 item 1 ("never-requested is its own
-- answer; it is not deferred").
--
-- Plain CREATE TABLE (not CONCURRENTLY), matching 008/012's own
-- precedent that the multi-statement migration runner executes in one
-- implicit transaction. Idempotent (CREATE ... IF NOT EXISTS / ON
-- CONFLICT DO NOTHING). Safe to re-run.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feasibility_export_jobs (
  parcel_node_id text PRIMARY KEY,
  job_ref        text NOT NULL,
  state          text NOT NULL CHECK (state IN ('queued', 'running', 'ready', 'failed')),
  queued_at      timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  completed_at   timestamptz,
  failed_at      timestamptz,
  error_class    text,
  error_message  text,
  artifact_ref   text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Read path is a single-row lookup by primary key (parcel_node_id); no
-- extra index needed beyond the primary key itself.

INSERT INTO schema_migrations (filename)
VALUES ('013_feasibility_export_jobs.sql')
ON CONFLICT (filename) DO NOTHING;
