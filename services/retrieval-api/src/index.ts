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
 * Corpus loading (Lane E Phase E0): when `CORPUS_SNAPSHOT_PATH` is set,
 * the service boots an `InMemoryStorage` hydrated from that committed
 * snapshot artifact rather than the empty dev-mode storage. The
 * production read-only catalog is small enough to hold in memory; the
 * Postgres-backed StoragePort is a separate sprint and swaps in behind
 * the same `buildApp({ storage })` seam without touching this file.
 */

import { readFile } from "node:fs/promises";

import { InMemoryStorage, isCorpusSnapshot } from "@hauska-engine/storage";

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

  const storage = snapshotPath
    ? await loadCorpusSnapshot(snapshotPath)
    : undefined;

  if (storage) {
    const jurisdictions = await storage.listJurisdictionStatus();
    console.log(
      JSON.stringify({
        level: "info",
        service: "retrieval-api",
        event: "corpus.loaded",
        snapshotPath,
        jurisdictions: jurisdictions.length,
        ts: new Date().toISOString(),
      }),
    );
  } else {
    console.log(
      JSON.stringify({
        level: "warn",
        service: "retrieval-api",
        event: "corpus.empty",
        message: "CORPUS_SNAPSHOT_PATH not set — serving empty dev-mode storage",
        ts: new Date().toISOString(),
      }),
    );
  }

  const app = buildApp(storage ? { storage } : {});
  startServer(app, port);
}

export { buildApp, startServer };
