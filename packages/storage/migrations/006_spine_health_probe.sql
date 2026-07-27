-- 006_spine_health_probe.sql
--
-- COMPLETE-BASTROP B1 / WDLL items 6,7 (S-03): persist source+engine
-- liveness probe results so silent zeros cannot go unnoticed.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS, ON CONFLICT DO NOTHING). Safe to
-- re-run. Records itself into schema_migrations.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS spine_health_probe (
  id               bigserial PRIMARY KEY,
  probe_id         text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('source', 'engine')),
  pack             text NOT NULL DEFAULT 'bastrop',
  status           text NOT NULL CHECK (status IN ('firing', 'degraded', 'dead', 'dead-expected')),
  alert            boolean NOT NULL DEFAULT false,
  signal           jsonb NOT NULL DEFAULT '{}'::jsonb,
  baseline_value   double precision,
  current_value    double precision,
  error            text,
  last_success_at  timestamptz,
  probed_at        timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS spine_health_probe_pack_probe_probed_idx
  ON spine_health_probe (pack, probe_id, probed_at DESC);

CREATE INDEX IF NOT EXISTS spine_health_probe_alert_idx
  ON spine_health_probe (alert)
  WHERE alert = true;

INSERT INTO schema_migrations (filename)
VALUES ('006_spine_health_probe.sql')
ON CONFLICT (filename) DO NOTHING;
