import type { StoragePort } from "@hauska-engine/storage";

import {
  probeSubstrateDb,
  resolveSubstrateDatabaseUrl,
} from "./substrate-db-probe.js";

export type HealthzStatus = "ok" | "warn" | "fail";

export interface HealthzDb {
  ok: boolean;
  status: "up" | "down" | "not_configured";
  source: string;
  latencyMs?: number;
  error?: string;
}

export interface HealthzCorpus {
  ok: boolean;
  atomCount: number;
  source: string;
}

export interface HealthzPayload {
  status: HealthzStatus;
  db: HealthzDb;
  corpus: HealthzCorpus;
}

export interface HealthzOptions {
  storage: StoragePort;
  substrateDatabaseUrl?: string;
}

const DB_SOURCE = "probe:substrate-neon SELECT 1";
const DB_NOT_CONFIGURED_SOURCE = "env:SUBSTRATE_DATABASE_URL|DATABASE_URL";
const CORPUS_SOURCE = "storage:countAtoms";

export async function buildHealthzPayload(
  options: HealthzOptions,
): Promise<HealthzPayload> {
  const databaseUrl = resolveSubstrateDatabaseUrl(options.substrateDatabaseUrl);
  let db: HealthzDb;

  if (!databaseUrl) {
    db = {
      ok: false,
      status: "not_configured",
      source: DB_NOT_CONFIGURED_SOURCE,
    };
  } else {
    const probe = await probeSubstrateDb(databaseUrl);
    db = probe.ok
      ? {
          ok: true,
          status: "up",
          source: DB_SOURCE,
          latencyMs: probe.latencyMs,
        }
      : {
          ok: false,
          status: "down",
          source: DB_SOURCE,
          error: probe.error,
        };
  }

  const atomCount = await options.storage.countAtoms();
  const corpus: HealthzCorpus = {
    ok: atomCount > 0,
    atomCount,
    source: CORPUS_SOURCE,
  };

  const status = deriveHealthzStatus(db, corpus);
  return { status, db, corpus };
}

function deriveHealthzStatus(
  db: HealthzDb,
  corpus: HealthzCorpus,
): HealthzStatus {
  if (!corpus.ok) return "fail";
  if (db.status === "down") return "fail";
  if (db.status === "not_configured") return "warn";
  return "ok";
}

export function httpStatusForHealthz(status: HealthzStatus): 200 | 503 {
  return status === "fail" ? 503 : 200;
}

/** Pinned signal-emit contract from 76e_platform_observability_sprint §Signal emit. */
export function emitHealthzSignal(payload: HealthzPayload): void {
  const dbValue =
    payload.db.status === "up"
      ? `up(${payload.db.latencyMs ?? "?"}ms)`
      : payload.db.status;
  console.log(
    JSON.stringify({
      hauska_health: true,
      check: "healthz",
      service: "hauska-retrieval-api",
      status: payload.status,
      value: `corpus=${payload.corpus.atomCount};db=${dbValue}`,
      threshold: "corpus>0;db=up",
      source: "GET /healthz",
      ts: new Date().toISOString(),
    }),
  );
}
