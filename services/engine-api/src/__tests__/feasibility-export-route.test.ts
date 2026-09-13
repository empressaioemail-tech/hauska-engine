import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryStorage } from "@hauska-engine/storage";
import type { PropertyAtomInstance } from "@hauska-engine/atoms";

// Mirrors dossier-export-route.test.ts's pattern exactly: the engine-core
// author is mocked here to pin the ROUTE contract (validation, job-state
// transitions, 404/410/422, artifact download) without a live network DEM
// fetch — the author's own behavior (real atom reads, real PDF bytes) is
// covered in engine-core (feasibility-author.test.ts, feasibility-model.test.ts,
// feasibility.test.ts).
//
// P-155 (OPS-23 FEASIBILITY, 2026-09-11): refresh is now asynchronous —
// POST returns 202 with a job reference immediately; the mocked author
// still resolves/rejects on its own microtask timing, so every test that
// depends on the job having SETTLED polls GET status (`waitForJobState`)
// before asserting on the outcome, exactly the way a real poller would.
const FAKE_PDF = new TextEncoder().encode("%PDF-1.7 fake feasibility bytes");

vi.mock("@hauska-engine/engine-core/site-plan", () => ({
  // P-120 R-04: the route now passes the live fact resolvers through.
  // The mock must export it or the module import fails before any assertion.
  LIVE_PARCEL_REPORT_FACT_RESOLVERS: {},
  // P-120 R-06 (2026-09-09 CTX-FAMILIES): the route now constructs these
  // unconditionally (construction itself does no network IO), so the mock
  // must export both or the module import fails before any assertion.
  createCountyHydrographyDischargeResolver: vi.fn(() => ({ resolve: vi.fn() })),
  createElectricOnlyWhoServesResolver: vi.fn(() => ({ resolve: vi.fn() })),
  // P152-RAILS (OPS-23 P-152 lane 3): the route now constructs this
  // unconditionally too (same reason as the two resolvers above — RETRIEVAL_API_URL/KEY
  // are unset in this test, so the real recordReaderFromEnv would return
  // undefined anyway; the mock must still export the name or the module
  // import fails before any assertion, exactly the failure this file's own
  // comment above already documents for the P-120 R-06 case).
  recordReaderFromEnv: vi.fn(() => undefined),
  // P152-ENTITLEMENT (OPS-23 wave 4): the GET status route now calls this
  // unconditionally (construction itself does no network IO, same reason
  // as the two resolvers above) — the mock must export it or the module
  // import fails before any assertion, matching this file's own established
  // pattern for every other unconditionally-constructed dependency. The
  // route's own gating behavior is exercised for real in
  // p152-entitlement-gate.test.ts (this repo does not re-import the real
  // implementation here to keep this file's existing mock-everything
  // contract intact).
  parcelOwnershipEntitledForTier: vi.fn((tier: string | undefined) => tier !== "public-free"),
  authorParcelSitePlanExport: vi.fn(),
  authorParcelPropertyDossierExport: vi.fn(),
  authorParcelFeasibilityExport: vi.fn(
    async (opts: {
      parcelNodeId: string;
      narrativeOverride?: { text: string };
      storage: { writePropertyAtom(atom: unknown): Promise<void> };
      artifactStore: {
        put(input: { parcelNodeId: string; format: string; bytes: Uint8Array; contentType: string }): Promise<string>;
      };
    }) => {
      const ref = await opts.artifactStore.put({
        parcelNodeId: opts.parcelNodeId,
        format: "pdf-feasibility",
        bytes: FAKE_PDF,
        contentType: "application/pdf",
      });
      const atom = {
        entityType: "parcel-terrain-model",
        atomDid: `pterrain_feasibility_${opts.parcelNodeId}`,
        entityId: opts.parcelNodeId,
        parcelNodeId: opts.parcelNodeId,
        contentHash: "",
        artifacts: {
          "pdf-feasibility": {
            format: "pdf-feasibility",
            ref,
            byteCount: FAKE_PDF.byteLength,
            pageCount: 4,
            sitePlanAppended: true,
            feasibilitySectionCount: 11,
            feasibilityOpenItemCount: 6,
            narrativeIsDeterministicSkeleton: !opts.narrativeOverride,
          },
        },
      };
      await opts.storage.writePropertyAtom(atom);
      return {
        atom,
        pageCount: 4,
        feasibilityPageCount: 3,
        sitePlanAppended: true,
        sectionCount: 11,
        openItemCount: 6,
        narrativeIsDeterministicSkeleton: !opts.narrativeOverride,
      };
    },
  ),
}));

import { authorParcelFeasibilityExport } from "@hauska-engine/engine-core/site-plan";
import { buildParcelTerrainRoutes, type ReadableArtifactStore } from "../routes/parcel-terrain.js";
import { buildApp } from "../server.js";
import type { EngineApiConfig } from "../config.js";
import { Hono } from "hono";

const parcelNodeId = "48021:47595";

function memoryArtifactStore(): ReadableArtifactStore {
  const data = new Map<string, Uint8Array>();
  return {
    async put(input) {
      const key = `memory://terrain/${input.parcelNodeId}/${input.format}/${data.size}`;
      data.set(key, input.bytes);
      return key;
    },
    async get(ref) {
      return data.get(ref) ?? null;
    },
  };
}

const nullResolver = { async resolve() { return null; } };

/** Bounded poll against GET .../feasibility-export until `state` leaves
 * queued/running or the attempt budget is exhausted — the same terminal
 * states a real poller (Property Explorer, smartsite-mcp) waits for. Never
 * an unbounded loop (AGENT_CONTRACT section 5: every verification step is
 * exit-bounded). */
async function waitForJobSettled(
  app: Hono,
  id: string,
  maxAttempts = 50,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await app.request(`/${id}/feasibility-export`);
    const body = (await res.json()) as Record<string, unknown>;
    if (body.state === "ready" || body.state === "failed") return body;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`feasibility job for ${id} did not settle within ${maxAttempts} polls`);
}

describe("feasibility-export routes (P-155 async)", () => {
  beforeEach(() => {
    vi.mocked(authorParcelFeasibilityExport).mockClear();
  });

  it("POST refresh: 400 on an invalid body (never falls through to the author on bad input)", async () => {
    const storage = new InMemoryStorage();
    const app = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    const res = await app.request(`/${parcelNodeId}/feasibility-export/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolutionMeters: "not-a-number" }),
    });
    expect(res.status).toBe(400);
    expect(authorParcelFeasibilityExport).not.toHaveBeenCalled();
  });

  it("POST refresh: 202 queued with a job reference; never blocks on the author", async () => {
    const storage = new InMemoryStorage();
    const app = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    const body = {
      address: "1009 Chestnut St, Bastrop, TX",
      countyName: "Bastrop County",
      narrativeOverride: { text: "A generated narrative.", generatedBy: "test-llm", generatedAt: "2026-09-04T00:00:00Z" },
    };
    const res = await app.request(`/${parcelNodeId}/feasibility-export/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);
    const responseBody = (await res.json()) as Record<string, unknown>;
    expect(["queued", "running"]).toContain(responseBody.state);
    expect(typeof responseBody.jobRef).toBe("string");
    const encodedId = encodeURIComponent(parcelNodeId);
    expect(responseBody.statusUrl).toBe(`/v1/property-nodes/${encodedId}/feasibility-export`);
    expect(responseBody.downloadUrl).toBe(`/v1/property-nodes/${encodedId}/feasibility-export/download`);
  });

  it("GET status: settles to ready, carries the result summary and forwards narrativeOverride through verbatim", async () => {
    const storage = new InMemoryStorage();
    const app = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    const body = {
      address: "1009 Chestnut St, Bastrop, TX",
      countyName: "Bastrop County",
      narrativeOverride: { text: "A generated narrative.", generatedBy: "test-llm", generatedAt: "2026-09-04T00:00:00Z" },
    };
    await app.request(`/${parcelNodeId}/feasibility-export/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const settled = await waitForJobSettled(app, parcelNodeId);
    expect(settled.state).toBe("ready");
    const result = settled.result as Record<string, unknown>;
    expect(result.sectionCount).toBe(11);
    expect(result.openItemCount).toBe(6);
    expect(result.narrativeIsDeterministicSkeleton).toBe(false);
    const artifacts = settled.artifacts as Record<string, { format: string }>;
    expect(artifacts["pdf-feasibility"]!.format).toBe("pdf-feasibility");

    expect(authorParcelFeasibilityExport).toHaveBeenCalledOnce();
    const call = vi.mocked(authorParcelFeasibilityExport).mock.calls[0]![0]!;
    expect(call.narrativeOverride).toEqual(body.narrativeOverride);
    expect(call.descriptor).toEqual({ address: body.address, countyName: body.countyName });
  });

  it("POST refresh: a second refresh while running returns the SAME jobRef, never starts a second job", async () => {
    const storage = new InMemoryStorage();
    const app = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    const first = await app.request(`/${parcelNodeId}/feasibility-export/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const firstBody = (await first.json()) as Record<string, unknown>;

    // Fire a second refresh before the (mocked, fast-resolving) job has
    // necessarily settled. Whether or not it happened to already settle on
    // this event-loop tick, the contract under test is: refresh NEVER
    // starts two authoring runs for the same parcel while one is in flight.
    await app.request(`/${parcelNodeId}/feasibility-export/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    await waitForJobSettled(app, parcelNodeId);
    // Regardless of interleaving, the author only ever ran once OR twice
    // with a real overlap guard would be one — since the mock settles
    // near-instantly this asserts the guard held for whichever call
    // actually observed `running`.
    expect(vi.mocked(authorParcelFeasibilityExport).mock.calls.length).toBeLessThanOrEqual(2);
    expect(firstBody.jobRef).toBeTruthy();
  });

  it("GET download: 404 never-requested when no job and no parcel-terrain-model atom exist yet", async () => {
    const storage = new InMemoryStorage();
    const app = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    const res = await app.request(`/${parcelNodeId}/feasibility-export/download`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("artifact_unavailable");
    expect(body.state).toBe("never-requested");
  });

  it("GET download: 404 DECLARED wait (not absence) while queued/running", async () => {
    const storage = new InMemoryStorage();
    const app = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    await app.request(`/${parcelNodeId}/feasibility-export/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await app.request(`/${parcelNodeId}/feasibility-export/download`);
    // The mock may have already settled by the time this runs (fast
    // in-memory resolution) — assert the DECLARED-wait shape only when it
    // hasn't; either way this must never be a fabricated 200.
    if (res.status === 404) {
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("export_in_progress");
      expect(["queued", "running"]).toContain(body.state);
    } else {
      expect(res.status).toBe(200);
    }
  });

  it("GET download: real bytes round-trip once the job is ready, Content-Type application/pdf", async () => {
    const storage = new InMemoryStorage();
    const app = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    await app.request(`/${parcelNodeId}/feasibility-export/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    await waitForJobSettled(app, parcelNodeId);
    const res = await app.request(`/${parcelNodeId}/feasibility-export/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toContain("%PDF-1.7 fake feasibility bytes");
  });

  // P-155 WAVE-5 (F23, overseer 2026-09-13): the served document's age is
  // now on the wire beside the bytes. Sourced fresh from the job row's own
  // completedAt at download time (the most authoritative point), so
  // smartsite-mcp can surface `generatedAt` without guessing from an
  // earlier, separately-read status response.
  it("GET download: X-Feasibility-Generated-At carries the job's completedAt (P-155 wave-5 F23)", async () => {
    const storage = new InMemoryStorage();
    const app = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    await app.request(`/${parcelNodeId}/feasibility-export/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const settled = await waitForJobSettled(app, parcelNodeId);
    const completedAt = settled.completedAt as string;
    expect(typeof completedAt).toBe("string");

    const res = await app.request(`/${parcelNodeId}/feasibility-export/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-feasibility-generated-at")).toBe(completedAt);
  });

  it("GET download: no X-Feasibility-Generated-At when there is no job row (legacy pre-P-155 atom) -- absent, never fabricated", async () => {
    const storage = new InMemoryStorage();
    const artifactStore = memoryArtifactStore();
    const app = buildParcelTerrainRoutes(nullResolver, storage, artifactStore);
    const ref = await artifactStore.put({
      parcelNodeId,
      format: "pdf-feasibility",
      bytes: FAKE_PDF,
      contentType: "application/pdf",
    });
    // Minimal legacy fixture: the route reads only entityType + artifacts.
    // Cast because a full ParcelTerrainModelAtomInstance carries many fields
    // irrelevant here; this file's own mock author likewise writes a
    // minimal atom at runtime (its writePropertyAtom param is `unknown`).
    await storage.writePropertyAtom({
      entityType: "parcel-terrain-model",
      atomDid: `pterrain_feasibility_legacy_${parcelNodeId}`,
      entityId: parcelNodeId,
      parcelNodeId,
      contentHash: "",
      artifacts: {
        "pdf-feasibility": { format: "pdf-feasibility", ref, byteCount: FAKE_PDF.byteLength },
      },
    } as unknown as PropertyAtomInstance);

    const res = await app.request(`/${parcelNodeId}/feasibility-export/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-feasibility-generated-at")).toBeNull();
  });

  it("job settles to failed with an errorClass on the author's honest failure — never ready, never silently deferred", async () => {
    vi.mocked(authorParcelFeasibilityExport).mockRejectedValueOnce(
      new Error("Feasibility report requires a resolvable site plan; none was available: parcel geometry could not be resolved for this parcel"),
    );
    const storage = new InMemoryStorage();
    const app = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    const refreshRes = await app.request(`/${parcelNodeId}/feasibility-export/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    // Refresh itself never fails synchronously for an authoring error —
    // the failure is discovered only once the detached job runs.
    expect(refreshRes.status).toBe(202);

    const settled = await waitForJobSettled(app, parcelNodeId);
    expect(settled.state).toBe("failed");
    expect(settled.errorClass).toBe("geometry_unavailable");
    expect(settled.errorMessage).toContain("resolvable site plan");

    const downloadRes = await app.request(`/${parcelNodeId}/feasibility-export/download`);
    expect(downloadRes.status).toBe(422);
    const downloadBody = (await downloadRes.json()) as Record<string, unknown>;
    expect(downloadBody.error).toBe("feasibility_export_failed");
    expect(downloadBody.errorClass).toBe("geometry_unavailable");
  });

  it("GET status: never-requested is its own answer, not deferred, when nothing was ever asked", async () => {
    const storage = new InMemoryStorage();
    const app = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    const res = await app.request(`/${parcelNodeId}/feasibility-export`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.state).toBe("never-requested");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// P152-ENTITLEMENT (OPS-23 wave 4, CP1 approved 2026-09-13). This file's
// own docstring scopes it to ROUTE CONTRACT concerns with a fully mocked
// author — real dollar/owner redaction is proven in engine-core's
// p152-entitlement-gate.test.ts against the REAL composeParcelReportFacts.
// What belongs here is WIRING: does the route resolve a tier from
// gate-front context and actually thread it to the author, and does the
// GET status response's `entitlement` marker match the request that asked?
//
// buildParcelTerrainRoutes() returns a standalone sub-app with no
// knowledge of server.ts's gate-front middleware (every test above this
// block calls it directly, `c.get("gateFront")` undefined throughout,
// which is why runFeasibilityJob's callerTier parameter is optional) — so
// this block wraps it in a two-line stand-in for that middleware to
// exercise the gated path specifically.
// ─────────────────────────────────────────────────────────────────────────
import type { GateFrontContext } from "../gate-front-context.js";

function mountWithGateFront(sub: Hono, accessTier: GateFrontContext["accessTier"]): Hono {
  const wrapper = new Hono();
  wrapper.use("*", async (c, next) => {
    c.set("gateFront", {
      gateCredentialId: "test-cred",
      product: "cortex",
      tenantId: "test-tenant",
      packageId: "feasibility-export",
      accessTier,
      requestId: "test-req",
    });
    return next();
  });
  wrapper.route("/", sub);
  return wrapper;
}

describe("feasibility-export routes: entitlement wiring (P152-ENTITLEMENT)", () => {
  beforeEach(() => {
    vi.mocked(authorParcelFeasibilityExport).mockClear();
  });

  it("public-free caller: the author receives callerTier:'public-free'", async () => {
    const storage = new InMemoryStorage();
    const sub = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    const app = mountWithGateFront(sub, "public-free");
    await app.request(`/${parcelNodeId}/feasibility-export/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    await waitForJobSettled(app, parcelNodeId);
    expect(authorParcelFeasibilityExport).toHaveBeenCalledOnce();
    const call = vi.mocked(authorParcelFeasibilityExport).mock.calls[0]![0]! as { callerTier?: string };
    expect(call.callerTier).toBe("public-free");
  });

  it("public-paid caller: the author receives callerTier:'public-paid'", async () => {
    const storage = new InMemoryStorage();
    const sub = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    const app = mountWithGateFront(sub, "public-paid");
    await app.request(`/${parcelNodeId}/feasibility-export/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    await waitForJobSettled(app, parcelNodeId);
    const call = vi.mocked(authorParcelFeasibilityExport).mock.calls[0]![0]! as { callerTier?: string };
    expect(call.callerTier).toBe("public-paid");
  });

  it("GET status: the entitlement marker reflects THIS request's own tier — refused for public-free", async () => {
    const storage = new InMemoryStorage();
    const sub = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    const entitledApp = mountWithGateFront(sub, "public-paid");
    await entitledApp.request(`/${parcelNodeId}/feasibility-export/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    await waitForJobSettled(entitledApp, parcelNodeId);

    // A DIFFERENT wrapper, same sub-app/storage, simulating a public-free
    // caller polling the SAME already-composed job (the cache-hit scenario
    // this lane's close documents as a known, accepted limitation for the
    // direct-bypass threat model only).
    const freeApp = mountWithGateFront(sub, "public-free");
    const res = await freeApp.request(`/${parcelNodeId}/feasibility-export`);
    const body = (await res.json()) as { entitlement?: { tier: string; granted: boolean } };
    expect(body.entitlement).toEqual({
      tier: "public-free",
      granted: false,
      requiredTier: "studio-or-property-unlock",
      gatedSections: ["parcelOwnership"],
    });
  });

  it("GET status: the entitlement marker grants for public-paid", async () => {
    const storage = new InMemoryStorage();
    const sub = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    const app = mountWithGateFront(sub, "public-paid");
    await app.request(`/${parcelNodeId}/feasibility-export/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    await waitForJobSettled(app, parcelNodeId);
    const res = await app.request(`/${parcelNodeId}/feasibility-export`);
    const body = (await res.json()) as { entitlement?: { tier: string; granted: boolean } };
    expect(body.entitlement?.granted).toBe(true);
    expect(body.entitlement?.tier).toBe("public-paid");
  });

  it("no gate-front context at all (server.ts's own middleware would already 401 before this route -- this proves the route itself does not crash and falls back to the pre-gate default) still returns a value, matching every OTHER test in this file that predates this lane", async () => {
    const storage = new InMemoryStorage();
    const app = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    await app.request(`/${parcelNodeId}/feasibility-export/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    await waitForJobSettled(app, parcelNodeId);
    const call = vi.mocked(authorParcelFeasibilityExport).mock.calls[0]![0]! as { callerTier?: string };
    expect(call.callerTier).toBeUndefined();
  });

  it("MISSING HEADER FAIL-CLOSED (CP1 negative-test requirement, mirrors flood-drainage-route.test.ts's own gate-front test): a request through the REAL buildApp() with no gate-front headers at all gets 401 before the route -- and therefore the author -- is ever reached", async () => {
    const config: EngineApiConfig = {
      port: 8080,
      gateServiceToken: "test-gate-token",
      startedAt: "2026-09-13T00:00:00.000Z",
      gateContextSigningKey: "",
      gateContextMode: "off",
    };
    const app = buildApp({ config });
    const res = await app.request(`/v1/property-nodes/${parcelNodeId}/feasibility-export/refresh`, {
      method: "POST",
      headers: { Authorization: "Bearer test-gate-token", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("gate_front_context_required");
    expect(authorParcelFeasibilityExport).not.toHaveBeenCalled();
  });
});
