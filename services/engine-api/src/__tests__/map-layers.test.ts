import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { engineEnvelopeSchema } from "@hauska-engine/engine-core/envelope";
import type { EngineApiConfig } from "../config.js";
import { GATE_FRONT_HEADERS } from "../gate-front-context.js";
import { buildApp } from "../server.js";

// The /assemble fan-out (Cotality parcels/zoning, FEMA NFHL, USGS 3DEP
// via the wave-3 slots) otherwise escapes to the REAL network — this
// suite had no fetch mock at all. That made the assemble test
// nondeterministic: upstream latency above vitest's 5s default timeout
// is an observed failure mode (PR #92 CI, and a local repro of the
// identical 5s timeout on origin/main). Stub every upstream with an
// instant, non-retryable 404 (fetchWithRetry retries 408/429/5xx, so a
// 404 guarantees a single attempt); the assembler degrades each layer
// to a pending/failed slot with a sealed envelope, which is exactly the
// contract the assemble test asserts. Hono's app.request dispatches
// handlers in-process and never touches global fetch, so the stub only
// intercepts adapter/upstream calls.
beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: "unit-test: outbound network disabled" }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    ),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function gateHeaders(
  overrides: Partial<Record<string, string>> = {},
): Record<string, string> {
  return {
    Authorization: "Bearer test-gate-token",
    [GATE_FRONT_HEADERS.product]: "cortex",
    [GATE_FRONT_HEADERS.tenantId]: "tenant-map-1",
    [GATE_FRONT_HEADERS.packageId]: "map-layers",
    [GATE_FRONT_HEADERS.accessTier]: "public-paid",
    [GATE_FRONT_HEADERS.credentialId]: "gate-cred-map",
    [GATE_FRONT_HEADERS.requestId]: "req-map-layers-1",
    ...overrides,
  };
}

const config: EngineApiConfig = {
  port: 8080,
  gateServiceToken: "test-gate-token",
  startedAt: "2026-06-17T00:00:00.000Z",
  gateContextSigningKey: "",
  gateContextMode: "off",
};

const austinParcel = {
  parcel: {
    latitude: 30.2672,
    longitude: -97.7431,
    address: "501 Congress Ave, Austin, TX",
    parcelKey: "austin-demo-1",
  },
  jurisdiction: { stateKey: "texas", localKey: null },
};

describe("engine-api map-layers capability", () => {
  const app = buildApp({ config });

  it("GET /contract describes gate + consumer coordination", async () => {
    const res = await app.request("/v1/map-layers/contract", {
      headers: gateHeaders(),
    });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const parsed = engineEnvelopeSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    const payload = parsed.data!.payload as {
      packageId: string;
      gateExposure: { owner: string };
      consumer: { owner: string };
      pendingWave3: string[];
    };
    expect(payload.packageId).toBe("map-layers");
    expect(payload.gateExposure.owner).toBe("cc-agent-M");
    expect(payload.consumer.owner).toBe("cc-agent-C");
    expect(payload.pendingWave3).toEqual([]);
  });

  it("POST /assemble returns per-layer EngineEnvelopes", async () => {
    const res = await app.request("/v1/map-layers/assemble", {
      method: "POST",
      headers: { ...gateHeaders(), "content-type": "application/json" },
      body: JSON.stringify(austinParcel),
    });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const parsed = engineEnvelopeSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(body, null, 2)).toBe(true);
    const payload = parsed.data!.payload as {
      tenantScope: string;
      parcelKey: string;
      layers: Array<{ layerKey: string; status: string; envelope: unknown }>;
    };
    expect(payload.tenantScope).toBe("tenant-map-1");
    expect(payload.parcelKey).toBe("austin-demo-1");
    // parcel-polygon, flood-zone, floodway, dem, topography, topography-1ft,
    // hydrology-flow, opportunity-zone-tract, zoning
    expect(payload.layers.length).toBe(9);
    expect(payload.layers.map((l) => l.layerKey)).toEqual(
      expect.arrayContaining(["topography-1ft", "hydrology-flow"]),
    );

    for (const slot of payload.layers) {
      expect(slot.envelope).not.toBeNull();
      const layerParsed = engineEnvelopeSchema.safeParse(slot.envelope);
      expect(layerParsed.success, slot.layerKey).toBe(true);
    }

    const pending = payload.layers.filter((l) => l.status === "pending");
    expect(pending.length).toBeGreaterThan(0);
    expect(parsed.data!.coverage.degraded).toBe(true);
  });

  it("rejects assemble without gate-front headers", async () => {
    const res = await app.request("/v1/map-layers/assemble", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-gate-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(austinParcel),
    });
    expect(res.status).toBe(401);
  });

  it("rejects invalid parcel body", async () => {
    const res = await app.request("/v1/map-layers/assemble", {
      method: "POST",
      headers: { ...gateHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ parcel: { latitude: "bad" } }),
    });
    expect(res.status).toBe(400);
  });
});
