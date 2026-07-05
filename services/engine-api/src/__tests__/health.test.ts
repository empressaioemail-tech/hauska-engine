import { describe, expect, it } from "vitest";

import type { EngineApiConfig } from "../config.js";
import { GATE_FRONT_HEADERS } from "../gate-front-context.js";
import { buildApp } from "../server.js";

describe("engine-api scaffold", () => {
  const config: EngineApiConfig = {
    port: 8080,
    gateServiceToken: "",
    startedAt: "2026-06-07T00:00:00.000Z",
    gateContextSigningKey: "",
    gateContextMode: "off",
  };

  it("serves /health without gate context", async () => {
    const app = buildApp({ config });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body).toMatchObject({ status: "ok", service: "engine-api" });
  });

  it("rejects /v1 without gate-front headers when token is set", async () => {
    const gated = buildApp({
      config: { ...config, gateServiceToken: "test-gate-token" },
    });
    const res = await gated.request("/v1/brief", {
      headers: { Authorization: "Bearer test-gate-token" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts gate-front headers and returns 501 scaffold on /v1", async () => {
    const gated = buildApp({
      config: { ...config, gateServiceToken: "test-gate-token" },
    });
    const res = await gated.request("/v1/brief", {
      headers: {
        Authorization: "Bearer test-gate-token",
        [GATE_FRONT_HEADERS.product]: "cortex",
        [GATE_FRONT_HEADERS.tenantId]: "tenant-demo",
        [GATE_FRONT_HEADERS.packageId]: "plan-review",
        [GATE_FRONT_HEADERS.accessTier]: "tenant-private",
        [GATE_FRONT_HEADERS.credentialId]: "gate-cred-1",
        [GATE_FRONT_HEADERS.requestId]: "req-abc",
      },
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { gateFront: { tenantId: string } };
    expect(body.gateFront.tenantId).toBe("tenant-demo");
  });
});
