-- 014_feasibility_export_jobs_result.sql
--
-- P-155 follow-on to 013. Before this migration, the ONLY channel that
-- carried pageCount / feasibilityPageCount / sitePlanAppended /
-- sitePlanUnavailableReason / sectionCount / openItemCount /
-- narrativeIsDeterministicSkeleton to a caller was the SYNCHRONOUS refresh
-- (201) response body (see feasibility-author.ts's own comment: "ride the
-- REFRESH RESPONSE only ... a fed path"). Once refresh returns 202 and the
-- caller learns the result from a POLL instead, that response no longer
-- exists to carry them -- both real consumers (Property Explorer's
-- mapEngineFeasibilityPayload and smartsite-mcp's executeFeasibilityExport)
-- read exactly these seven fields and nothing else from the refresh body,
-- so these seven, and only these seven, move onto the job row.
--
-- Deliberately flat columns, not a jsonb blob: matches every other column
-- on this table, and the field set is small, fixed, and already typed at
-- the callers (pe-feasibility-export-core.ts's FeasibilityExportBffResponse
-- / feasibility-export.ts's inline object) -- a jsonb bag would hide a
-- typo in a column name behind "still valid JSON."
--
-- ALTER TABLE ADD COLUMN IF NOT EXISTS -- idempotent, safe to re-run, no
-- rewrite of existing rows (nullable columns, no default computation).

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE feasibility_export_jobs
  ADD COLUMN IF NOT EXISTS result_page_count integer,
  ADD COLUMN IF NOT EXISTS result_feasibility_page_count integer,
  ADD COLUMN IF NOT EXISTS result_site_plan_appended boolean,
  ADD COLUMN IF NOT EXISTS result_site_plan_unavailable_reason text,
  ADD COLUMN IF NOT EXISTS result_section_count integer,
  ADD COLUMN IF NOT EXISTS result_open_item_count integer,
  ADD COLUMN IF NOT EXISTS result_narrative_is_deterministic_skeleton boolean;

INSERT INTO schema_migrations (filename)
VALUES ('014_feasibility_export_jobs_result.sql')
ON CONFLICT (filename) DO NOTHING;
