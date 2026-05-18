import { serve } from "@hono/node-server";
import { Hono, type Context, type Next } from "hono";
import { z } from "zod";

import { HybridRetrieval } from "@hauska-engine/retrieval";
import { InMemoryStorage, type StoragePort } from "@hauska-engine/storage";

export interface ServerOptions {
  storage?: StoragePort;
  /** Required `Authorization: Bearer` value. Empty disables the check (dev). */
  apiKey?: string;
}

export function buildApp(options: ServerOptions = {}): Hono {
  const storage = options.storage ?? new InMemoryStorage();
  const retrieval = new HybridRetrieval(storage);
  const apiKey = options.apiKey ?? process.env.RETRIEVAL_API_KEY ?? "";
  const startedAt = new Date().toISOString();

  const app = new Hono();

  app.use("*", async (c: Context, next: Next) => {
    const path = c.req.path;
    if (path === "/health" || path === "/ready") return next();
    if (!apiKey) return next();
    const auth = c.req.header("authorization");
    if (auth !== `Bearer ${apiKey}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  app.get("/health", (c) =>
    c.json({ status: "ok", service: "retrieval-api", startedAt }),
  );

  app.get("/ready", async (c) => {
    // Sanity-poll: storage.listJurisdictionStatus must answer (even with []).
    try {
      await storage.listJurisdictionStatus();
      return c.json({ status: "ready" });
    } catch (err) {
      return c.json({ status: "degraded", error: String(err) }, 503);
    }
  });

  const searchSchema = z.object({
    q: z.string().default(""),
    jurisdiction: z.string().optional(),
    entityType: z
      .enum([
        "code-section",
        "code-definition",
        "code-amendment",
        "code-cross-reference",
        "code-edition",
        "jurisdiction-corpus",
      ])
      .optional(),
    limit: z.coerce.number().min(1).max(100).default(25),
  });

  app.get("/search", async (c) => {
    const parsed = searchSchema.safeParse({
      q: c.req.query("q") ?? "",
      jurisdiction: c.req.query("jurisdiction") ?? undefined,
      entityType: c.req.query("entityType") ?? undefined,
      limit: c.req.query("limit") ?? undefined,
    });
    if (!parsed.success) {
      return c.json(
        { error: "invalid query", issues: parsed.error.flatten() },
        400,
      );
    }
    const result = await retrieval.search(parsed.data);
    return c.json(result);
  });

  app.get("/atoms/:did{.+}", async (c) => {
    const did = c.req.param("did");
    const includeComposition = c.req.query("includeComposition") === "true";
    const result = await retrieval.getAtom({ atomDid: did, includeComposition });
    if (!result.atom) return c.json({ error: "atom not found", did }, 404);
    return c.json(result);
  });

  app.get("/jurisdictions", async (c) => {
    const qualityBarOnly = c.req.query("qualityBarOnly") === "true";
    const statuses = await retrieval.listJurisdictions({ qualityBarOnly });
    return c.json({ jurisdictions: statuses });
  });

  app.get("/jurisdictions/:id", async (c) => {
    const id = c.req.param("id");
    const queryType = c.req.query("queryType") === "permits" ? "permits" : "summary";
    const result = await retrieval.queryJurisdiction({
      jurisdictionTenant: id,
      queryType,
    });
    if (!result.status) return c.json({ error: "jurisdiction not found", id }, 404);
    return c.json(result);
  });

  app.get("/jurisdictions/:id/permits", async (c) => {
    const id = c.req.param("id");
    const projectType = c.req.query("projectType") ?? "";
    if (!projectType) {
      return c.json({ error: "projectType query param required" }, 400);
    }
    const result = await retrieval.queryJurisdiction({
      jurisdictionTenant: id,
      queryType: "permits",
      projectType,
    });
    return c.json(result);
  });

  return app;
}

export function startServer(app: Hono, port: number): void {
  serve({ fetch: app.fetch, port });
  // Output kept minimal — Cloud Logging picks up structured JSON
  // emitted by Hono's own logger middleware (added in the Logging
  // sweep that follows Stream 2C wiring).
  console.log(
    JSON.stringify({
      level: "info",
      service: "retrieval-api",
      event: "server.started",
      port,
      ts: new Date().toISOString(),
    }),
  );
}
