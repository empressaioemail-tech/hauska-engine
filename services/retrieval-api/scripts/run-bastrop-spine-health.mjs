#!/usr/bin/env node
/**
 * run-bastrop-spine-health.mjs — execute the Bastrop spine-health pack once.
 *
 *   DATABASE_URL=...hauska_mcp... \
 *   CORTEX_DATABASE_URL=...neondb... \
 *     pnpm --filter @hauska-engine/retrieval-api run run-bastrop-spine-health
 *
 * Invoked via `tsx` so TypeScript sources under src/ resolve.
 */

import { runBastropSpineHealthPack } from "../src/spine-health/run-pack.ts";

const result = await runBastropSpineHealthPack({ persist: true });
console.log(JSON.stringify(result.summary, null, 2));
console.error(
  JSON.stringify({
    event: "spine_health.run",
    pack: result.summary.pack,
    alertCount: result.summary.alertCount,
    probeCount: result.summary.probes.length,
    persisted: result.persisted,
    persistedCount: result.persistedCount,
  }),
);
process.exit(result.summary.alertCount > 0 ? 2 : 0);
