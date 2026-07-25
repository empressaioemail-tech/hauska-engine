/**
 * services/retrieval-api — Stream 1C HTTP service.
 *
 * **This is the Sync 3 deliverable.** The endpoint shapes are the
 * locked contract consumed by `hauska-mcp-server` Stream 2A (cc-agent-M
 * swaps from mocked client to this on Sync 3 signal).
 *
 * Latency contract per dispatch:
 *   P99 ≤ 500ms for index queries
 *   P99 ≤ 2s when IPFS fetch needed
 *
 * Auth: internal `Authorization: Bearer <RETRIEVAL_API_KEY>` between
 * the MCP server and this service. Production deploys behind Cloud
 * Run's identity-aware proxy; the header check is a defense-in-depth
 * second layer.
 *
 * Corpus loading (F1 Phase 0 / G2): when SUBSTRATE_DATABASE_URL (or
 * DATABASE_URL) is set, the service serves Postgres PgStorage ONLY and
 * does NOT hydrate CORPUS_SNAPSHOT_PATH into the heap. The in-memory
 * snapshot boot path is retired for production. Snapshot-only remains
 * for local/dev without a substrate URL, gated by the resource-headroom
 * check. ALLOW_SNAPSHOT_OVERLAY=1 is an explicit legacy escape hatch.
 */

import { readFile } from "node:fs/promises";

import {
  InMemoryStorage,
  isCorpusSnapshot,
  resolveSubstrateDatabaseUrl,
} from "@hauska-engine/storage";

import { bootRetrievalStorage } from "./boot-storage.js";
import {
  createPgCalibrationOverlayPort,
  resolveOverlayDatabaseUrl,
} from "./pg-calibration-overlay.js";
import {
  assertSnapshotHeadroom,
  resolveMemoryLimitMib,
} from "./resource-headroom.js";
import { startServer, buildApp } from "./server.js";

/**
 * Hydrate an `InMemoryStorage` from a committed `CorpusSnapshot` file.
 * Throws on a missing or malformed artifact — a retrieval-api that
 * silently served an empty corpus would be worse than a failed boot.
 */
export async function loadCorpusSnapshot(path: string): Promise<InMemoryStorage> {
  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isCorpusSnapshot(parsed)) {
    throw new Error(
      `CORPUS_SNAPSHOT_PATH does not point at a valid corpus snapshot: ${path}`,
    );
  }
  return InMemoryStorage.fromSnapshot(parsed);
}

// Normalize backslashes so the endsWith check matches on Windows where
// process.argv[1] is the OS-native path (e.g. P:\hauska-engine\...).
const argvPath = process.argv[1]?.replace(/\\/g, "/");
const isMain =
  !!argvPath && argvPath.endsWith("services/retrieval-api/src/index.ts");

if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  const snapshotPath = process.env.CORPUS_SNAPSHOT_PATH;
  const databaseUrl = resolveSubstrateDatabaseUrl();
  const allowSnapshotOverlay = process.env.ALLOW_SNAPSHOT_OVERLAY === "1";
  const memoryLimitMib = resolveMemoryLimitMib();

  let snapshot: InMemoryStorage | undefined;

  if (databaseUrl && !allowSnapshotOverlay) {
    // G2: Postgres-only serve. Never JSON.parse the corpus into the heap.
    console.log(
      JSON.stringify({
        level: "info",
        service: "retrieval-api",
        event: "corpus.snapshot_skipped",
        reason: "postgres-serve",
        snapshotPath: snapshotPath ?? null,
        memoryLimitMib,
        ts: new Date().toISOString(),
      }),
    );
  } else if (snapshotPath) {
    await assertSnapshotHeadroom(snapshotPath, memoryLimitMib);
    snapshot = await loadCorpusSnapshot(snapshotPath);
  }

  const boot = bootRetrievalStorage({
    snapshot,
    substrateDatabaseUrl: databaseUrl,
    allowSnapshotOverlay,
  });
  const storage = boot.storage;

  const overlayUrl = resolveOverlayDatabaseUrl();
  const overlayHandle = overlayUrl
    ? createPgCalibrationOverlayPort({ databaseUrl: overlayUrl })
    : null;

  console.log(
    JSON.stringify({
      level: "info",
      service: "retrieval-api",
      event: "corpus.loaded",
      mode: boot.mode,
      snapshotPath: snapshot ? snapshotPath : null,
      layered: boot.mode === "layered",
      calibrationOverlay: Boolean(overlayHandle),
      jurisdictions: (await storage.listJurisdictionStatus()).length,
      atomCount: await storage.countAtoms(),
      memoryLimitMib,
      ts: new Date().toISOString(),
    }),
  );

  if (!overlayHandle) {
    console.log(
      JSON.stringify({
        level: "warn",
        service: "retrieval-api",
        event: "calibration.overlay.not_configured",
        message:
          "OVERLAY_DATABASE_URL / CORTEX_DATABASE_URL unset — property calibratedConfidence stays asserted placeholder",
        ts: new Date().toISOString(),
      }),
    );
  }

  const app = buildApp({
    storage,
    calibrationOverlay: overlayHandle?.port ?? null,
  });
  startServer(app, port);

  const shutdown = async () => {
    await boot.close();
    if (overlayHandle) await overlayHandle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export { buildApp, startServer };
export { bootRetrievalStorage } from "./boot-storage.js";
export {
  assertSnapshotHeadroom,
  evaluateSnapshotHeadroom,
  resolveMemoryLimitMib,
} from "./resource-headroom.js";
