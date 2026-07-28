import { serve } from "@hono/node-server";
import { Hono, type Context, type Next } from "hono";
import { z } from "zod";

import { HybridRetrieval } from "@hauska-engine/retrieval";
import type { Scope } from "@hauska-engine/atom-contract-pin";
import type { CalibrationOverlayPort } from "@hauska-engine/engine-core/property-reasoning";
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
import { runCentralTxNodeGraphTally } from "./central-tx-tally.js";
import { resolveSubstrateDatabaseUrl } from "./substrate-db-probe.js";
import {
  readSpineHealthSummary,
  runBastropSpineHealthPack,
} from "./spine-health/run-pack.js";

function isPublicHealthPath(path: string): boolean {
  return (
    path === "/health" ||
    path === "/healthz" ||
    path === "/healthz/" ||
    path === "/health/spine" ||
    path === "/health/spine/run" ||
    path === "/ready"
  );
}

/**
 * The full `AccessPolicy` union from `@hauska/atom-contract` (via the
 * storage re-export). The contract exports the union as a *type only*
 * (no runtime value list), so a runtime array is unavoidable here; the
 * `satisfies` clause rejects typos and the exhaustiveness assertion
 * below fails compilation if the contract ever adds a value this list
 * does not carry. That is the guard against the original landmine: a
 * hand-rolled four-value copy of the union silently missing
 * `tenant-shared` (added in contract 1.2.0).
 */
const ACCESS_POLICY_VALUES = [
  "public-free",
  "public-paid",
  "platform-internal",
  "tenant-private",
  "tenant-shared",
] as const satisfies ReadonlyArray<AccessPolicy>;

// Compile-time exhaustiveness check: if @hauska/atom-contract adds a
// new AccessPolicy value, this assignment stops compiling until
// ACCESS_POLICY_VALUES above picks it up.
type ListedAccessPolicy = (typeof ACCESS_POLICY_VALUES)[number];
type AssertAccessPolicyListExhaustive = [
  Exclude<AccessPolicy, ListedAccessPolicy>,
] extends [never]
  ? true
  : "ACCESS_POLICY_VALUES is missing values from the AccessPolicy contract union";
const _accessPolicyListExhaustive: AssertAccessPolicyListExhaustive = true;
void _accessPolicyListExhaustive;

function isAccessPolicy(value: string): value is AccessPolicy {
  return (ACCESS_POLICY_VALUES as ReadonlyArray<string>).includes(value);
}

type ParseAccessPoliciesResult =
  | { ok: true; policies: ReadonlyArray<AccessPolicy> | undefined }
  | { ok: false; invalidValues: ReadonlyArray<string> };

/**
 * Parse a comma-separated `accessPolicies` query parameter into a typed
 * array. Returns `{ ok: true, policies: undefined }` when the param is
 * absent (no filter — unchanged default behavior).
 *
 * Fails CLOSED on anything else that is not a clean list of known
 * policy values:
 *
 * - Any unrecognized value → `{ ok: false }` (caller returns 400).
 *   Values must never be silently dropped: the storage layer treats an
 *   empty filter array as "no filter", so dropping the only requested
 *   value would return the ENTIRE corpus to a caller who asked for a
 *   restricted slice (fail-open on an access-policy filter).
 * - Param present but empty (e.g. `?accessPolicies=`) → `{ ok: false }`
 *   for the same reason: it would reach storage as an empty array and
 *   be interpreted as "no filter".
 */
function parseAccessPolicies(
  raw: string | undefined,
): ParseAccessPoliciesResult {
  if (raw === undefined) return { ok: true, policies: undefined };
  const tokens = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const invalidValues = tokens.filter((t) => !isAccessPolicy(t));
  if (invalidValues.length > 0) return { ok: false, invalidValues };
  if (tokens.length === 0) {
    // Present-but-empty param: never forward an empty array (storage
    // reads that as "no filter").
    return { ok: false, invalidValues: [raw] };
  }
  return { ok: true, policies: tokens as ReadonlyArray<AccessPolicy> };
}

export interface ServerOptions {
  storage?: StoragePort;
  /** Required `Authorization: Bearer` value. Empty disables the check (dev). */
  apiKey?: string;
  /** Substrate Neon URL for `/healthz` db liveness; falls back to env. */
  substrateDatabaseUrl?: string;
  /**
   * Cortex / overlay Neon URL for spine-health txgio + place_layer_snapshots
   * probes. Falls back to OVERLAY_DATABASE_URL / CORTEX_DATABASE_URL.
   */
  overlayDatabaseUrl?: string;
  /**
   * Migration 0037 overlay port (cortex Neon). When set, property-atom
   * READ resolves calibratedConfidence via parcel-node / atom DID keys.
   */
  calibrationOverlay?: CalibrationOverlayPort | null;
}

export function buildApp(options: ServerOptions = {}): Hono {
  const storage = options.storage ?? new InMemoryStorage();
  const retrieval = new HybridRetrieval(storage, {
    calibrationOverlay: options.calibrationOverlay ?? null,
  });
  const apiKey = options.apiKey ?? process.env.RETRIEVAL_API_KEY ?? "";
  const substrateDatabaseUrl = options.substrateDatabaseUrl;
  const overlayDatabaseUrl = options.overlayDatabaseUrl;
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
    c.json({
      status: "ok",
      service: "retrieval-api",
      startedAt,
      links: {
        spineHealth: "/health/spine",
        spineHealthRun: "/health/spine/run",
      },
    }),
  );

  /**
   * COMPLETE-BASTROP B1 — latest persisted spine source+engine probe summary.
   * Returns empty pack shell when nothing has been probed yet.
   */
  app.get("/health/spine", async (c) => {
    try {
      const summary = await readSpineHealthSummary({
        substrateDatabaseUrl,
        pack: c.req.query("pack") ?? "bastrop",
      });
      if (!summary) {
        return c.json({
          pack: c.req.query("pack") ?? "bastrop",
          probedAt: null,
          alertCount: 0,
          probes: [],
          note: "no probe rows yet — POST /health/spine/run",
        });
      }
      return c.json(summary);
    } catch (err) {
      return c.json(
        {
          error: "spine_health_read_failed",
          message: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
  });

  async function spineHealthRunHandler(c: Context) {
    try {
      const result = await runBastropSpineHealthPack({
        substrateDatabaseUrl,
        overlayDatabaseUrl,
        storage,
        persist: true,
      });
      return c.json(result);
    } catch (err) {
      return c.json(
        {
          error: "spine_health_run_failed",
          message: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
  }

  app.get("/health/spine/run", spineHealthRunHandler);
  app.post("/health/spine/run", spineHealthRunHandler);

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

  /**
   * Live Central-TX node-graph tally (G1 / WDLL 9). Same SELECT as the Gate A
   * offline script — coverage numbers for Command Center must come from here,
   * never a committed static artifact.
   */
  app.get("/stats/central-tx-node-graph", async (c) => {
    const databaseUrl = resolveSubstrateDatabaseUrl(substrateDatabaseUrl);
    if (!databaseUrl) {
      return c.json(
        {
          error: "substrate database not configured",
          missing: "SUBSTRATE_DATABASE_URL|DATABASE_URL",
        },
        503,
      );
    }
    try {
      const tally = await runCentralTxNodeGraphTally(databaseUrl);
      return c.json(tally);
    } catch (err) {
      return c.json(
        {
          error: "tally_failed",
          message: err instanceof Error ? err.message : String(err),
        },
        502,
      );
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

  /**
   * Property reasoning chain for a parcel node (MCP get_property_atom_chain).
   * Always-on read of StoragePort; empty slots when no property atoms baked.
   * Dual-serve: PROPERTY_ATOM_PATH gates writers; this route never invents values.
   */
  app.get("/property-nodes/:parcelNodeId{.+}/atom-chain", async (c) => {
    const parcelNodeId = decodeURIComponent(c.req.param("parcelNodeId"));
    if (!/^\d{5}:[A-Za-z0-9._-]+$/.test(parcelNodeId)) {
      return c.json(
        {
          error: "invalid parcelNodeId",
          hint: "expected {county_fips}:{prop_id} e.g. 48209:156346",
          parcelNodeId,
        },
        400,
      );
    }
    const chain = await retrieval.getPropertyAtomChain(parcelNodeId);
    return c.json(chain);
  });

  /**
   * CC-A U1 / WDLL 6 — serve stranded boundary-edge graph from StoragePort.
   * Phase 0 live 404 on /boundary-edges; this is the fix.
   */
  app.get("/property-nodes/:parcelNodeId{.+}/boundary-edges", async (c) => {
    const parcelNodeId = decodeURIComponent(c.req.param("parcelNodeId"));
    if (!/^\d{5}:[A-Za-z0-9._-]+$/.test(parcelNodeId) || parcelNodeId.includes(":boundary:")) {
      return c.json(
        {
          error: "invalid parcelNodeId",
          hint: "expected {county_fips}:{prop_id} e.g. 48021:28286",
          parcelNodeId,
        },
        400,
      );
    }
    const body = await retrieval.listBoundaryEdgesByParcelNodeId(parcelNodeId);
    return c.json(body);
  });

  /**
   * Attaching road-nodes for STREET/map render (Track B1). Optional ring in
   * the body enables proximity fallback when boundary-edge refs are absent.
   */
  app.post("/property-nodes/:parcelNodeId{.+}/attaching-roads", async (c) => {
    const parcelNodeId = decodeURIComponent(c.req.param("parcelNodeId"));
    if (!/^\d{5}:[A-Za-z0-9._-]+$/.test(parcelNodeId)) {
      return c.json(
        {
          error: "invalid parcelNodeId",
          hint: "expected {county_fips}:{prop_id} e.g. 48021:34785",
          parcelNodeId,
        },
        400,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      ringWgs84?: Array<[number, number]>;
    };
    const ring = Array.isArray(body.ringWgs84) ? body.ringWgs84 : [];
    const result = await retrieval.getAttachingRoads(parcelNodeId, ring);
    return c.json(result);
  });

  /**
   * Viewport road layer (Track B1-map reopen). Unstrands listRoadAtomsNearBbox
   * over HTTP — PE map draws the road NETWORK in view, not one attaching road.
   * Registered before /road-nodes/:id/atom-chain so "near-bbox" is not captured.
   */
  app.get("/road-nodes/near-bbox", async (c) => {
    const countyFips = (c.req.query("countyFips") ?? "").trim();
    if (!/^\d{5}$/.test(countyFips)) {
      return c.json(
        {
          error: "invalid countyFips",
          hint: "expected 5-digit FIPS e.g. 48021",
        },
        400,
      );
    }
    const westLng = Number(c.req.query("westLng"));
    const southLat = Number(c.req.query("southLat"));
    const eastLng = Number(c.req.query("eastLng"));
    const northLat = Number(c.req.query("northLat"));
    if (
      ![westLng, southLat, eastLng, northLat].every((n) => Number.isFinite(n)) ||
      westLng >= eastLng ||
      southLat >= northLat
    ) {
      return c.json(
        {
          error: "invalid bbox",
          hint: "westLng,southLat,eastLng,northLat required; west<east and south<north",
        },
        400,
      );
    }
    // Guard runaway payloads (whole-county bbox).
    const spanLng = eastLng - westLng;
    const spanLat = northLat - southLat;
    if (spanLng > 0.5 || spanLat > 0.5) {
      return c.json(
        {
          error: "bbox too large",
          hint: "max span 0.5 deg lng/lat — zoom in for the road layer",
        },
        400,
      );
    }
    const limitRaw = c.req.query("limit");
    const limit =
      limitRaw !== undefined && limitRaw !== ""
        ? Number(limitRaw)
        : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      return c.json({ error: "invalid limit" }, 400);
    }
    const result = await retrieval.listRoadNodesNearBbox({
      countyFips,
      westLng,
      southLat,
      eastLng,
      northLat,
      ...(limit !== undefined ? { limit } : {}),
    });
    return c.json(result);
  });

  app.get("/road-nodes/:roadNodeId{.+}/atom-chain", async (c) => {
    const roadNodeId = decodeURIComponent(c.req.param("roadNodeId"));
    if (!/^\d{5}:road:\d+$/.test(roadNodeId)) {
      return c.json(
        {
          error: "invalid roadNodeId",
          hint: "expected {county_fips}:road:{osm_way_id} e.g. 48021:road:123456789",
          roadNodeId,
        },
        400,
      );
    }
    const chain = await retrieval.getRoadAtomChain(roadNodeId);
    return c.json(chain);
  });

  /**
   * County → node roster LIST (CC browse; Trading Control Tower flow port).
   * Registered BEFORE /nodes/:nodeId so the bare collection path is never
   * captured by the param route (same pattern as road-nodes/near-bbox).
   * County is required + parameterized — uniform public-record pattern, no
   * per-jurisdiction special path. Honest-degrade: { available: false,
   * reason } when the county has no nodes of the requested type.
   */
  app.get("/nodes", async (c) => {
    const county = (c.req.query("county") ?? "").trim();
    if (!/^\d{5}$/.test(county)) {
      return c.json(
        {
          error: "invalid county",
          hint: "county is required — 5-digit FIPS e.g. 48021",
        },
        400,
      );
    }
    const nodeTypeRaw = c.req.query("nodeType") ?? "parcel";
    if (nodeTypeRaw !== "parcel" && nodeTypeRaw !== "road") {
      return c.json(
        {
          error: "invalid nodeType",
          hint: "expected parcel|road (default parcel)",
          nodeType: nodeTypeRaw,
        },
        400,
      );
    }
    const limitRaw = c.req.query("limit");
    let limit = 50;
    if (limitRaw !== undefined && limitRaw !== "") {
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        return c.json(
          { error: "invalid limit", hint: "integer 1..200 (default 50)" },
          400,
        );
      }
    }
    const offsetRaw = c.req.query("offset");
    let offset = 0;
    if (offsetRaw !== undefined && offsetRaw !== "") {
      offset = Number(offsetRaw);
      if (!Number.isInteger(offset) || offset < 0) {
        return c.json(
          { error: "invalid offset", hint: "integer >= 0 (default 0)" },
          400,
        );
      }
    }
    const qRaw = c.req.query("q");
    const q = qRaw?.trim();
    if (q !== undefined && q.length > 200) {
      return c.json({ error: "invalid q", hint: "max 200 chars" }, 400);
    }
    const body = await retrieval.listGraphNodes({
      county,
      nodeType: nodeTypeRaw,
      ...(q ? { q } : {}),
      limit,
      offset,
    });
    return c.json(body);
  });

  /**
   * CC-A U1 / WDLL 1+2+6 — Control-Tower-shaped node detail for parcel /
   * road / property-boundary-edge. Walkable edges_out / edges_in.
   */
  app.get("/nodes/:nodeId{.+}", async (c) => {
    const nodeId = decodeURIComponent(c.req.param("nodeId"));
    const detail = await retrieval.getPropertyNodeDetail(nodeId);
    if (!detail.available && detail.reason?.startsWith("invalid node id")) {
      return c.json(detail, 400);
    }
    if (!detail.available) {
      return c.json(detail, 404);
    }
    return c.json(detail);
  });

  app.get("/boundary-edges/:boundaryEdgeId{.+}", async (c) => {
    const boundaryEdgeId = decodeURIComponent(c.req.param("boundaryEdgeId"));
    if (!/^\d{5}:[A-Za-z0-9._-]+:boundary:\d+$/.test(boundaryEdgeId)) {
      return c.json(
        {
          error: "invalid boundaryEdgeId",
          hint: "expected {fips}:{propId}:boundary:{edgeIndex} e.g. 48021:28286:boundary:1",
          boundaryEdgeId,
        },
        400,
      );
    }
    const detail = await retrieval.getPropertyNodeDetail(boundaryEdgeId);
    if (!detail.available) return c.json(detail, 404);
    return c.json(detail);
  });

  app.get("/jurisdictions", async (c) => {
    const qualityBarOnly = c.req.query("qualityBarOnly") === "true";
    const parsedPolicies = parseAccessPolicies(c.req.query("accessPolicies"));
    if (!parsedPolicies.ok) {
      return c.json(
        {
          error: "invalid accessPolicies value(s)",
          invalidValues: parsedPolicies.invalidValues,
          allowedValues: ACCESS_POLICY_VALUES,
        },
        400,
      );
    }
    const { policies } = parsedPolicies;
    const statuses = await retrieval.listJurisdictions({
      qualityBarOnly,
      ...(policies !== undefined ? { accessPolicies: policies } : {}),
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
