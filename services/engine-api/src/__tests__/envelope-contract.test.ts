import { describe, expect, it } from "vitest";

import type { EngineApiConfig } from "../config.js";
import { GATE_FRONT_HEADERS } from "../gate-front-context.js";
import { buildApp } from "../server.js";
import { engineEnvelopeSchema } from "@hauska-engine/engine-core/envelope";

function gateHeaders(): Record<string, string> {
  return {
    Authorization: "Bearer test-gate-token",
    [GATE_FRONT_HEADERS.product]: "cortex",
    [GATE_FRONT_HEADERS.tenantId]: "tenant-demo",
    [GATE_FRONT_HEADERS.packageId]: "plan-review",
    [GATE_FRONT_HEADERS.accessTier]: "tenant-private",
    [GATE_FRONT_HEADERS.credentialId]: "gate-cred-1",
    [GATE_FRONT_HEADERS.requestId]: "req-envelope-contract-1",
  };
}

const config: EngineApiConfig = {
  port: 8080,
  gateServiceToken: "test-gate-token",
  startedAt: "2026-06-16T00:00:00.000Z",
  gateContextSigningKey: "",
  gateContextMode: "off",
};

const findingsInput = {
  submission: {
    id: "sub-env",
    jurisdiction: "Austin, TX",
    projectName: "Envelope contract",
    note: null,
  },
  sources: [
    {
      id: "src-1",
      layerKind: "qgis-zoning",
      sourceKind: "manual-upload",
      provider: "Test",
      snapshotDate: "2026-01-01",
      note: null,
    },
  ],
  codeSections: [
    {
      atomId: "federal-accessibility-standards/2010-ada-standards-for-accessible-design/404.2.3-clear-width",
      label: "ADA door clearance",
      webProvenance: { confidence: 0.94 },
    },
    {
      atomId: "federal-accessibility-standards/fair-housing-act-design-manual-april-1998/ch4-door-clear-width",
      label: "FHA door clearance",
      webProvenance: { confidence: 0.91 },
    },
  ],
  bimElements: [],
};

describe("EngineEnvelope contract — all reasoning surfaces", () => {
  const app = buildApp({ config });

  async function assertEnvelope(
    path: string,
    init: RequestInit,
  ): Promise<void> {
    const res = await app.request(path, {
      ...init,
      headers: {
        ...gateHeaders(),
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = engineEnvelopeSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(body, null, 2)).toBe(true);
    expect(parsed.data?.confidence.kind).toBeTruthy();
    expect(typeof parsed.data?.coverage.degraded).toBe("boolean");
    expect(
      parsed.data?.dataVintage === null ||
        typeof parsed.data?.dataVintage === "string",
    ).toBe(true);
  }

  it("POST /v1/findings/generate", async () => {
    await assertEnvelope("/v1/findings/generate", {
      method: "POST",
      body: JSON.stringify({ mode: "mock", input: findingsInput }),
    });
  });

  it("POST /v1/briefing/generate", async () => {
    await assertEnvelope("/v1/briefing/generate", {
      method: "POST",
      body: JSON.stringify({
        mode: "mock",
        input: {
          generatedBy: "test",
          sources: findingsInput.sources,
          codeSections: findingsInput.codeSections,
        },
      }),
    });
  });

  it("POST /v1/hydrology/rainfall-forcing", async () => {
    await assertEnvelope("/v1/hydrology/rainfall-forcing", {
      method: "POST",
      body: JSON.stringify({ latitude: 30.27, longitude: -97.74 }),
    });
  });

  it("POST /v1/hydrology/drainage (native path)", async () => {
    const width = 12;
    const height = 12;
    const elevation = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        elevation[row * width + col] = 100 + col * 0.5 + row * 0.2;
      }
    }
    const demBytes = Buffer.from(elevation.buffer);
    await assertEnvelope("/v1/hydrology/drainage", {
      method: "POST",
      body: JSON.stringify({
        demBytesBase64: demBytes.toString("base64"),
        pourLng: -97.675,
        pourLat: 30.505,
        catchmentBbox: {
          westLng: -97.68,
          southLat: 30.5,
          eastLng: -97.67,
          northLat: 30.51,
        },
        width,
        height,
        accumulationThreshold: 2,
      }),
    });
  });

  it("POST /v1/topography/contours", async () => {
    const width = 10;
    const height = 10;
    const values = new Float32Array(width * height);
    for (let i = 0; i < values.length; i++) {
      values[i] = 100 + (i % width);
    }
    await assertEnvelope("/v1/topography/contours", {
      method: "POST",
      body: JSON.stringify({
        rawGrid: {
          width,
          height,
          valuesBase64: Buffer.from(values.buffer).toString("base64"),
        },
        bbox: {
          westLng: -97.8,
          southLat: 30.1,
          eastLng: -97.7,
          northLat: 30.2,
        },
        intervalMeters: 2,
      }),
    });
  });

  it("POST /v1/site-context/place", async () => {
    await assertEnvelope("/v1/site-context/place", {
      method: "POST",
      body: JSON.stringify({
        latitude: 29.883,
        longitude: -97.94,
        address: "San Marcos, TX",
      }),
    });
  });

  it("POST /v1/site-context/run-adapters (empty jurisdiction)", async () => {
    await assertEnvelope("/v1/site-context/run-adapters", {
      method: "POST",
      body: JSON.stringify({
        parcel: { latitude: null, longitude: null },
        jurisdiction: { stateKey: null, localKey: null },
      }),
    });
  }, 10_000);

  it("POST /v1/encumbrances/query", async () => {
    await assertEnvelope("/v1/encumbrances/query", {
      method: "POST",
      body: JSON.stringify({
        latitude: 30.27,
        longitude: -97.74,
      }),
    });
  });

  it("POST /v1/chat/complete", async () => {
    await assertEnvelope("/v1/chat/complete", {
      method: "POST",
      body: JSON.stringify({
        mode: "mock",
        messages: [{ role: "user", content: "Summarize drainage risk." }],
      }),
    });
  });
});
