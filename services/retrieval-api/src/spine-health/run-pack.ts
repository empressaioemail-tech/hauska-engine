/**
 * Run + read the Bastrop spine-health pack (substrate + overlay).
 */

import postgres from "postgres";

import {
  createPgStorage,
  resolveSubstrateDatabaseUrl,
  type StoragePort,
} from "@hauska-engine/storage";

import { resolveOverlayDatabaseUrl } from "../pg-calibration-overlay.js";
import { BASTROP_PACK, SEED_BASELINES } from "./baselines.js";
import {
  ensureSpineHealthSchema,
  insertProbeResults,
  loadLastSuccessBaselines,
  loadLatestProbeSummary,
} from "./persist.js";
import { runAllBastropProbes } from "./probes.js";
import type { SpineHealthSummary } from "./types.js";

function openSql(databaseUrl: string): postgres.Sql {
  const ssl =
    databaseUrl.includes("sslmode=require") ||
    databaseUrl.includes("neon.tech")
      ? ("require" as const)
      : false;
  return postgres(databaseUrl, { ssl, max: 2, idle_timeout: 5 });
}

export interface RunBastropSpineHealthPackOptions {
  substrateDatabaseUrl?: string;
  overlayDatabaseUrl?: string;
  /** Injected storage (tests); otherwise PgStorage from substrate URL. */
  storage?: StoragePort | null;
  fetchImpl?: typeof fetch;
  persist?: boolean;
}

export interface RunBastropSpineHealthPackResult {
  summary: SpineHealthSummary;
  persisted: boolean;
  persistedCount: number;
}

/**
 * Open substrate + overlay, run all Bastrop probes, optionally persist.
 */
export async function runBastropSpineHealthPack(
  options: RunBastropSpineHealthPackOptions = {},
): Promise<RunBastropSpineHealthPackResult> {
  const substrateUrl = resolveSubstrateDatabaseUrl(
    options.substrateDatabaseUrl,
  );
  const overlayUrl = resolveOverlayDatabaseUrl(options.overlayDatabaseUrl);

  const substrateSql = substrateUrl ? openSql(substrateUrl) : null;
  const overlaySql = overlayUrl ? openSql(overlayUrl) : null;

  let storageClose: (() => Promise<void>) | null = null;
  let storage: StoragePort | null = options.storage ?? null;
  if (!storage && substrateUrl) {
    const pg = createPgStorage({ databaseUrl: substrateUrl });
    storage = pg.storage;
    storageClose = pg.close;
  }

  try {
    const liveBaselines: Record<string, number> = { ...SEED_BASELINES };
    if (substrateSql) {
      await ensureSpineHealthSchema(substrateSql);
      const last = await loadLastSuccessBaselines(substrateSql, BASTROP_PACK);
      Object.assign(liveBaselines, last);
    }

    for (const [k, v] of Object.entries(SEED_BASELINES)) {
      if (liveBaselines[k] == null) liveBaselines[k] = v;
    }

    const probes = await runAllBastropProbes({
      substrateSql,
      overlaySql,
      storage,
      fetchImpl: options.fetchImpl,
      baselines: liveBaselines,
    });

    const probedAt =
      probes.reduce(
        (max, p) => (p.probedAt > max ? p.probedAt : max),
        probes[0]?.probedAt ?? new Date().toISOString(),
      ) ?? new Date().toISOString();

    const summary: SpineHealthSummary = {
      pack: BASTROP_PACK,
      probedAt,
      alertCount: probes.filter((p) => p.alert).length,
      probes,
    };

    let persisted = false;
    let persistedCount = 0;
    const shouldPersist = options.persist !== false && substrateSql != null;
    if (shouldPersist && substrateSql) {
      persistedCount = await insertProbeResults(substrateSql, probes);
      persisted = true;
    }

    return { summary, persisted, persistedCount };
  } finally {
    if (storageClose) await storageClose().catch(() => {});
    if (substrateSql) await substrateSql.end({ timeout: 5 }).catch(() => {});
    if (overlaySql) await overlaySql.end({ timeout: 5 }).catch(() => {});
  }
}

/**
 * Read latest persisted summary (or null when empty / no substrate).
 */
export async function readSpineHealthSummary(options: {
  substrateDatabaseUrl?: string;
  pack?: string;
}): Promise<SpineHealthSummary | null> {
  const substrateUrl = resolveSubstrateDatabaseUrl(
    options.substrateDatabaseUrl,
  );
  if (!substrateUrl) return null;
  const sql = openSql(substrateUrl);
  try {
    await ensureSpineHealthSchema(sql);
    return await loadLatestProbeSummary(sql, options.pack ?? BASTROP_PACK);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export { BASTROP_PACK };
