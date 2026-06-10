import { serve } from "@hono/node-server";
import { Hono, type Context, type Next } from "hono";

import type { EngineApiConfig } from "./config.js";
import {
  parseGateFrontHeaders,
  type GateFrontContext,
} from "./gate-front-context.js";
import { buildSiteContextRoutes } from "./routes/site-context.js";

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
      startedAt: config.startedAt,
    }),
  );

  app.get("/ready", (c) => c.json({ status: "ready", adapters: true }));

  // Site-context adapters (sprint 56 step 3 / GTM A1).
  app.route("/v1/site-context", buildSiteContextRoutes());

  // Remaining reasoning routes land in step 4 (engine-core lift).
  app.all("/v1/*", (c) =>
    c.json(
      {
        error: "not_implemented",
        message: "Reasoning endpoints scaffold only; engine lift pending",
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
      adapters: true,
      ts: new Date().toISOString(),
    }),
  );
}
