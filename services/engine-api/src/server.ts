import { serve } from "@hono/node-server";
import { Hono, type Context, type Next } from "hono";

import type { EngineApiConfig } from "./config.js";
import {
  parseGateFrontHeaders,
  type GateFrontContext,
} from "./gate-front-context.js";

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
      scaffold: true,
      startedAt: config.startedAt,
    }),
  );

  app.get("/ready", (c) => c.json({ status: "ready", scaffold: true }));

  // Reasoning routes land in the lift (sprint 56 steps 3–4). The
  // gate-front middleware above is wired now so the seam is testable.
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
      scaffold: true,
      ts: new Date().toISOString(),
    }),
  );
}
