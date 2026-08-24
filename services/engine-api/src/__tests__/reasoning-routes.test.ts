import { describe, expect, it } from "vitest";

import type { EngineApiConfig } from "../config.js";
import { GATE_FRONT_HEADERS } from "../gate-front-context.js";
import { buildApp } from "../server.js";

function gateHeaders(): Record<string, string> {
  return {
    Authorization: "Bearer test-gate-token",
    [GATE_FRONT_HEADERS.product]: "cortex",
    [GATE_FRONT_HEADERS.tenantId]: "tenant-demo",
    [GATE_FRONT_HEADERS.packageId]: "plan-review",
    [GATE_FRONT_HEADERS.accessTier]: "tenant-private",
    [GATE_FRONT_HEADERS.credentialId]: "gate-cred-1",
    [GATE_FRONT_HEADERS.requestId]: "req-reasoning-1",
  };
}

describe("engine-api reasoning routes", () => {
  const config: EngineApiConfig = {
    port: 8080,
    gateServiceToken: "test-gate-token",
    startedAt: "2026-06-10T00:00:00.000Z",
    gateContextSigningKey: "",
    gateContextMode: "off",
  };

  it("rejects mock findings mode at the schema boundary", async () => {
    const app = buildApp({ config });
    const res = await app.request("/v1/findings/generate", {
      method: "POST",
      headers: { ...gateHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        mode: "mock",
        input: {
          submission: {
            id: "sub-1",
            jurisdiction: "Bastrop, TX",
            projectName: "Test",
            note: null,
          },
          sources: [],
          codeSections: [],
          bimElements: [],
        },
      }),
    });
    expect(res.status).toBe(400);
  });
});
