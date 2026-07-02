import { serve } from "@hono/node-server";
import { Hono, type Context, type Next } from "hono";

import type { EngineApiConfig } from "./config.js";
import {
  parseGateFrontHeaders,
  type GateFrontContext,
} from "./gate-front-context.js";
import { buildBriefingRoutes } from "./routes/briefing.js";
import { buildChatRoutes } from "./routes/chat.js";
import { buildDocumentIngestRoutes } from "./routes/document-ingest.js";
import { documentIngestStoreKind } from "@hauska-engine/document-ingest";
import { buildEncumbrancesRoutes } from "./routes/encumbrances.js";
import { buildFindingsRoutes } from "./routes/findings.js";
import { buildHydrologyRoutes } from "./routes/hydrology.js";
import { buildSiteContextRoutes } from "./routes/site-context.js";
import { buildTopographyRoutes } from "./routes/topography.js";
import { buildMapLayersRoutes } from "./routes/map-layers.js";
import { validateEnvelopeMiddleware } from "./middleware/validateEnvelope.js";

export interface ServerOptions {
  config: EngineApiConfig;
}

declare module "hono" {
  interface ContextVariableMap {
    gateFront: GateFrontContext;
  }
}

export function buildApp(options: ServerOptions): Hono {
  const { config } = options;
  const app = new Hono();

  app.use("*", async (c: Context, next: Next) => {
    const path = c.req.path;
    if (path === "/health" || path === "/ready") return next();

    if (config.gateServiceToken) {
      const auth = c.req.header("authorization");
      if (auth !== `Bearer ${config.gateServiceToken}`) {
        return c.json({ error: "unauthorized" }, 401);
      }
    }

    const gateFront = parseGateFrontHeaders(c.req.raw.headers);
    if (!gateFront) {
      return c.json(
        {
          error: "gate_front_context_required",
          message:
            "Missing or invalid gate-front headers; engine-api accepts only gate-proxied calls",
        },
        401,
      );
    }

    c.set("gateFront", gateFront);
    return next();
  });

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "engine-api",
      adapters: true,
      engineCore: true,
      envelope: true,
      documentIngest: true,
      documentIngestStore: documentIngestStoreKind(process.env),
      startedAt: config.startedAt,
    }),
  );

  app.get("/ready", (c) => c.json({ status: "ready", engineCore: true }));

  const v1 = new Hono();
  v1.use("*", validateEnvelopeMiddleware);
  v1.route("/site-context", buildSiteContextRoutes());
  v1.route("/briefing", buildBriefingRoutes());
  v1.route("/findings", buildFindingsRoutes());
  v1.route("/hydrology", buildHydrologyRoutes());
  v1.route("/topography", buildTopographyRoutes());
  v1.route("/encumbrances", buildEncumbrancesRoutes());
  v1.route("/chat", buildChatRoutes());
  v1.route("/map-layers", buildMapLayersRoutes());
  v1.route("/document-ingest", buildDocumentIngestRoutes());
  app.route("/v1", v1);

  app.all("/v1/*", (c) =>
    c.json(
      {
        error: "not_implemented",
        message: "Unknown engine-api route",
        gateFront: c.get("gateFront"),
      },
      501,
    ),
  );

  return app;
}

export function startServer(app: Hono, port: number): void {
  serve({ fetch: app.fetch, port });
  console.log(
    JSON.stringify({
      level: "info",
      service: "engine-api",
      event: "server.started",
      port,
      engineCore: true,
      envelope: true,
      ts: new Date().toISOString(),
    }),
  );
}
