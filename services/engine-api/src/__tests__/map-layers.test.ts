import { describe, expect, it } from "vitest";

import { engineEnvelopeSchema } from "@hauska-engine/engine-core/envelope";
import type { EngineApiConfig } from "../config.js";
import { GATE_FRONT_HEADERS } from "../gate-front-context.js";
import { buildApp } from "../server.js";

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
    const body = await res.json();
    const parsed = engineEnvelopeSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(body.payload.packageId).toBe("map-layers");
    expect(body.payload.gateExposure.owner).toBe("cc-agent-M");
    expect(body.payload.consumer.owner).toBe("cc-agent-C");
    expect(body.payload.pendingWave3).toEqual([]);
  });

  it("POST /assemble returns per-layer EngineEnvelopes", async () => {
    const res = await app.request("/v1/map-layers/assemble", {
      method: "POST",
      headers: { ...gateHeaders(), "content-type": "application/json" },
      body: JSON.stringify(austinParcel),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = engineEnvelopeSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(body, null, 2)).toBe(true);
    expect(body.payload.tenantScope).toBe("tenant-map-1");
    expect(body.payload.parcelKey).toBe("austin-demo-1");
    expect(body.payload.layers.length).toBe(7);

    for (const slot of body.payload.layers) {
      expect(slot.envelope).not.toBeNull();
      const layerParsed = engineEnvelopeSchema.safeParse(slot.envelope);
      expect(layerParsed.success, slot.layerKey).toBe(true);
    }

    const pending = body.payload.layers.filter(
      (l: { status: string }) => l.status === "pending",
    );
    expect(pending.length).toBeGreaterThan(0);
    expect(body.coverage.degraded).toBe(true);
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
