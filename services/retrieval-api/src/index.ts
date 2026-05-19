/**
 * services/retrieval-api — Stream 1C HTTP service.
 *
 * **This is the Sync 3 deliverable.** The endpoint shapes below are
 * the locked contract consumed by `hauska-mcp-server` Stream 2A
 * (cc-agent-M swaps from mocked client to this on Sync 3 signal).
 *
 * Latency contract per dispatch:
 *   P99 ≤ 500ms for index queries
 *   P99 ≤ 2s when IPFS fetch needed
 *
 * Auth: internal `Authorization: Bearer <RETRIEVAL_API_KEY>` between
 * the MCP server and this service. Production deploys behind Cloud
 * Run's identity-aware proxy; the header check is a defense-in-depth
 * second layer.
 */

import { startServer, buildApp } from "./server.js";

const app = buildApp();

const port = Number(process.env.PORT ?? 8080);

// Normalize backslashes so the endsWith check matches on Windows where
// process.argv[1] is the OS-native path (e.g. P:\hauska-engine\...).
const argvPath = process.argv[1]?.replace(/\\/g, "/");
const isMain =
  !!argvPath && argvPath.endsWith("services/retrieval-api/src/index.ts");

if (isMain) {
  startServer(app, port);
}

export { app, buildApp, startServer };
export default app;
