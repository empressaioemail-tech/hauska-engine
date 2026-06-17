import { describe, expect, it } from "vitest";

import type { EngineApiConfig } from "../config.js";
import { GATE_FRONT_HEADERS } from "../gate-front-context.js";
import { buildApp } from "../server.js";

function gateHeaders(): Record<string, string> {
  return {
    Authorization: "Bearer test-gate-token",
    [GATE_FRONT_HEADERS.product]: "cortex",
    [GATE_FRONT_HEADERS.tenantId]: "tenant-demo",
    [GATE_FRONT_HEADERS.packageId]: "site-context",
    [GATE_FRONT_HEADERS.accessTier]: "tenant-private",
    [GATE_FRONT_HEADERS.credentialId]: "gate-cred-1",
    [GATE_FRONT_HEADERS.requestId]: "req-site-context-1",
  };
}

describe("engine-api site-context adapters", () => {
  const config: EngineApiConfig = {
    port: 8080,
    gateServiceToken: "test-gate-token",
    startedAt: "2026-06-10T00:00:00.000Z",
  };

  it("lists the adapter registry", async () => {
    const app = buildApp({ config });
    const res = await app.request("/v1/site-context/registry", {
      headers: gateHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      payload: {
        adapterCount: number;
        adapters: Array<{ adapterKey: string }>;
      };
    };
    expect(body.payload.adapterCount).toBeGreaterThan(0);
    expect(
      body.payload.adapters.some((a) => a.adapterKey === "fema:nfhl-flood-zone"),
    ).toBe(true);
  });

  it("returns honest empty state when no adapters apply", async () => {
    const app = buildApp({ config });
    const res = await app.request("/v1/site-context/run-adapters", {
      method: "POST",
      headers: { ...gateHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        parcel: { latitude: null, longitude: null },
        jurisdiction: { stateKey: null, localKey: null },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      payload: { status: string };
      coverage: { degraded: boolean };
    };
    expect(body.payload.status).toBe("empty");
    expect(body.coverage.degraded).toBe(true);
  });
});
