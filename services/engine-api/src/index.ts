/**
 * services/engine-api — gate-fronted reasoning HTTP service (ADR-008).
 *
 * Scaffold only (sprint 56, step 1). Sibling to retrieval-api, which
 * stays read-only and reasoning-free. No engine logic until the lift.
 *
 * Auth: `Authorization: Bearer <ENGINE_API_GATE_TOKEN>` plus gate-front
 * context headers (see docs/gate-front-seam.md). Only the MCP gate is
 * an intended caller during transition.
 */

import { loadConfig } from "./config.js";
import { buildApp, startServer } from "./server.js";

const argvPath = process.argv[1]?.replace(/\\/g, "/");
const isMain =
  !!argvPath && argvPath.endsWith("services/engine-api/src/index.ts");

if (isMain) {
  const config = loadConfig();
  const app = buildApp({ config });
  startServer(app, config.port);
}

export { buildApp, startServer, loadConfig };
export type { EngineApiConfig } from "./config.js";
export type { GateFrontContext } from "./gate-front-context.js";
export {
  GATE_FRONT_HEADERS,
  GATE_FRONT_PRODUCTS,
  parseGateFrontHeaders,
} from "./gate-front-context.js";
