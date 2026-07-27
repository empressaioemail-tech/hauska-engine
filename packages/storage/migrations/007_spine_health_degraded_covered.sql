-- 007_spine_health_degraded_covered.sql
--
-- QA4: widen spine_health_probe.status CHECK to allow degraded-covered
-- (overpass down but county-roadway / surveyed-2016 covers — no red alert).
--
-- Idempotent. Records itself into schema_migrations.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE spine_health_probe
  DROP CONSTRAINT IF EXISTS spine_health_probe_status_check;

ALTER TABLE spine_health_probe
  ADD CONSTRAINT spine_health_probe_status_check
  CHECK (status IN ('firing', 'degraded', 'degraded-covered', 'dead', 'dead-expected'));

INSERT INTO schema_migrations (filename)
VALUES ('007_spine_health_degraded_covered.sql')
ON CONFLICT (filename) DO NOTHING;
