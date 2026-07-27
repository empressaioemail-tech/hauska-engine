/**
 * Persist + load spine_health_probe rows (substrate Neon).
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type postgres from "postgres";

import type { ProbeKind, ProbeResult, ProbeStatus, SpineHealthSummary } from "./types.js";
import { BASTROP_PACK } from "./baselines.js";

type Sql = postgres.Sql;

const MIGRATION_REL = join(
  "packages",
  "storage",
  "migrations",
  "006_spine_health_probe.sql",
);

function resolveMigrationPath(): string {
  // retrieval-api lives at services/retrieval-api — walk up to repo root.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "..", MIGRATION_REL);
}

/** Apply 006 (idempotent) so probe writes never fail on missing table. */
export async function ensureSpineHealthSchema(sql: Sql): Promise<void> {
  const migrationSql = await readFile(resolveMigrationPath(), "utf8");
  await sql.unsafe(migrationSql);
}

export async function insertProbeResults(
  sql: Sql,
  results: ReadonlyArray<ProbeResult>,
): Promise<number> {
  if (results.length === 0) return 0;
  let inserted = 0;
  for (const r of results) {
    await sql`
      INSERT INTO spine_health_probe (
        probe_id,
        kind,
        pack,
        status,
        alert,
        signal,
        baseline_value,
        current_value,
        error,
        last_success_at,
        probed_at
      ) VALUES (
        ${r.probeId},
        ${r.kind},
        ${r.pack},
        ${r.status},
        ${r.alert},
        ${sql.json(r.signal as never)},
        ${r.baselineValue},
        ${r.currentValue},
        ${r.error},
        ${r.lastSuccessAt},
        ${r.probedAt}
      )
    `;
    inserted += 1;
  }
  return inserted;
}

/**
 * Latest row per probe_id for a pack (DISTINCT ON probed_at DESC).
 */
export async function loadLatestProbeSummary(
  sql: Sql,
  pack: string = BASTROP_PACK,
): Promise<SpineHealthSummary | null> {
  const rows = await sql<
    Array<{
      probe_id: string;
      kind: string;
      pack: string;
      status: string;
      alert: boolean;
      signal: Record<string, unknown> | null;
      baseline_value: number | null;
      current_value: number | null;
      error: string | null;
      last_success_at: Date | string | null;
      probed_at: Date | string;
    }>
  >`
    SELECT DISTINCT ON (probe_id)
      probe_id,
      kind,
      pack,
      status,
      alert,
      signal,
      baseline_value,
      current_value,
      error,
      last_success_at,
      probed_at
    FROM spine_health_probe
    WHERE pack = ${pack}
    ORDER BY probe_id, probed_at DESC
  `;

  if (rows.length === 0) return null;

  const probes: ProbeResult[] = rows.map((row) => ({
    probeId: row.probe_id,
    kind: row.kind as ProbeKind,
    pack: row.pack,
    status: row.status as ProbeStatus,
    alert: Boolean(row.alert),
    signal:
      row.signal && typeof row.signal === "object"
        ? (row.signal as Record<string, unknown>)
        : {},
    baselineValue:
      row.baseline_value == null ? null : Number(row.baseline_value),
    currentValue:
      row.current_value == null ? null : Number(row.current_value),
    error: row.error ?? null,
    lastSuccessAt: toIso(row.last_success_at),
    probedAt: toIso(row.probed_at) ?? new Date().toISOString(),
  }));

  const probedAt = probes.reduce(
    (max, p) => (p.probedAt > max ? p.probedAt : max),
    probes[0]!.probedAt,
  );

  return {
    pack,
    probedAt,
    alertCount: probes.filter((p) => p.alert).length,
    probes,
  };
}

/**
 * Last successful (status=firing) current_value per probe_id — live baselines.
 * Falls back to caller seed when absent.
 */
export async function loadLastSuccessBaselines(
  sql: Sql,
  pack: string = BASTROP_PACK,
): Promise<Record<string, number>> {
  const rows = await sql<
    Array<{ probe_id: string; current_value: number | null }>
  >`
    SELECT DISTINCT ON (probe_id)
      probe_id,
      current_value
    FROM spine_health_probe
    WHERE pack = ${pack}
      AND status = 'firing'
      AND current_value IS NOT NULL
      AND current_value > 0
    ORDER BY probe_id, probed_at DESC
  `;
  const out: Record<string, number> = {};
  for (const row of rows) {
    if (row.current_value != null) {
      out[row.probe_id] = Number(row.current_value);
    }
  }
  return out;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}
