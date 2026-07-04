import { serve } from "@hono/node-server";
import { Hono, type Context, type Next } from "hono";
import { z } from "zod";

import { HybridRetrieval } from "@hauska-engine/retrieval";
import type { Scope } from "@hauska-engine/atom-contract-pin";
import {
  InMemoryStorage,
  type AccessPolicy,
  type StoragePort,
} from "@hauska-engine/storage";

import {
  buildHealthzPayload,
  emitHealthzSignal,
  httpStatusForHealthz,
} from "./healthz.js";

function isPublicHealthPath(path: string): boolean {
  return (
    path === "/health" ||
    path === "/healthz" ||
    path === "/healthz/" ||
    path === "/ready"
  );
}

// Full five-value union (public-paid + tenant-shared added in atom-contract
// 1.2.0). The exhaustiveness guard below fails compilation if the contract's
// AccessPolicy type ever gains a value not listed here, so this array can no
// longer silently fall behind the contract — the source of the fail-open bug
// this replaces.
const ACCESS_POLICY_VALUES = [
  "public-free",
  "public-paid",
  "platform-internal",
  "tenant-private",
  "tenant-shared",
] as const satisfies ReadonlyArray<AccessPolicy>;

// Compile-time exhaustiveness: every AccessPolicy must appear above.
type _AccessPolicyCoverage =
  Exclude<AccessPolicy, (typeof ACCESS_POLICY_VALUES)[number]> extends never
    ? true
    : ["ACCESS_POLICY_VALUES is missing a policy value", AccessPolicy];
const _accessPolicyCoverage: _AccessPolicyCoverage = true;
void _accessPolicyCoverage;

function isAccessPolicy(value: string): value is AccessPolicy {
  return (ACCESS_POLICY_VALUES as ReadonlyArray<string>).includes(value);
}

type ParsedAccessPolicies =
  | { ok: true; value: ReadonlyArray<AccessPolicy> | undefined }
  | { ok: false; error: string };

/**
 * Parse a comma-separated `accessPolicies` query parameter into a typed
 * array. Absent param -> `{ ok: true, value: undefined }` (no filter).
 * Present param with >=1 recognized value -> `{ ok: true, value: [...] }`.
 * Present param that resolves to zero recognized values -> `{ ok: false }`;
 * the caller returns 400. This is the fail-closed contract: a request that
 * asks only for policies we do not recognize must NOT be silently widened to
 * "no filter" (which the storage layer treats as "return everything"). A mix
 * of recognized and unrecognized values keeps the recognized ones.
 */
function parseAccessPolicies(raw: string | undefined): ParsedAccessPolicies {
  if (raw === undefined) return { ok: true, value: undefined };
  const requested = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const recognized = requested.filter((s): s is AccessPolicy =>
    isAccessPolicy(s),
  );
  if (requested.length > 0 && recognized.length === 0) {
    return {
      ok: false,
      error: `no recognized accessPolicies in "${raw}"; valid values: ${ACCESS_POLICY_VALUES.join(", ")}`,
    };
  }
  return { ok: true, value: recognized.length > 0 ? recognized : undefined };
}

export interface ServerOptions {
  storage?: StoragePort;
  /** Required `Authorization: Bearer` value. Empty disables the check (dev). */
  apiKey?: string;
  /** Substrate Neon URL for `/healthz` db liveness; falls back to env. */
  substrateDatabaseUrl?: string;
}

export function buildApp(options: ServerOptions = {}): Hono {
  const storage = options.storage ?? new InMemoryStorage();
  const retrieval = new HybridRetrieval(storage);
  const apiKey = options.apiKey ?? process.env.RETRIEVAL_API_KEY ?? "";
  const substrateDatabaseUrl = options.substrateDatabaseUrl;
  const startedAt = new Date().toISOString();

  const app = new Hono();

  app.use("*", async (c: Context, next: Next) => {
    const path = c.req.path;
    if (isPublicHealthPath(path)) return next();
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

  async function healthzHandler(c: Context) {
    const payload = await buildHealthzPayload({
      storage,
      substrateDatabaseUrl,
    });
    emitHealthzSignal(payload);
    return c.json(payload, httpStatusForHealthz(payload.status));
  }

  app.get("/healthz", healthzHandler);
  // Cloud Run's GFE reserves exact `/healthz` (no trailing slash); `/healthz/`
  // reaches the container and satisfies the observability contract.
  app.get("/healthz/", healthzHandler);

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

  app.get("/atoms/trace/:did{.+}", async (c) => {
    const did = c.req.param("did");
    const audienceRaw = c.req.query("audience");
    const audience: Scope["audience"] =
      audienceRaw === "ai" || audienceRaw === "internal" || audienceRaw === "user"
        ? audienceRaw
        : "user";
    const trace = await retrieval.getAtomTrace({ atomDid: did, audience });
    if (!trace) return c.json({ error: "atom not found", did }, 404);
    return c.json(trace);
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
    const parsed = parseAccessPolicies(c.req.query("accessPolicies"));
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }
    const accessPolicies = parsed.value;
    const statuses = await retrieval.listJurisdictions({
      qualityBarOnly,
      ...(accessPolicies !== undefined ? { accessPolicies } : {}),
    });
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
