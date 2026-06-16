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
    [GATE_FRONT_HEADERS.requestId]: "req-rail-quiet-1",
  };
}

describe("rail-quiet (I7)", () => {
  const config: EngineApiConfig = {
    port: 8080,
    gateServiceToken: "test-gate-token",
    startedAt: "2026-06-10T00:00:00.000Z",
  };

  it("buyer-facing engine-api responses omit calibration grade in payload", async () => {
    const app = buildApp({ config });
    const res = await app.request("/v1/findings/generate", {
      method: "POST",
      headers: { ...gateHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        mode: "mock",
        input: {
          submission: {
            id: "sub-rail",
            jurisdiction: "Bastrop, TX",
            projectName: "Rail quiet",
            note: null,
          },
          sources: [],
          codeSections: [{ atomId: "code-1", label: "Sample Rule" }],
          bimElements: [],
        },
      }),
    });
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    expect(bodyText).not.toMatch(/calibrationGrade/i);
    expect(bodyText).not.toMatch(/calibration_grade/i);
    expect(bodyText).toMatch(/"confidence":\s*\{/);
    expect(bodyText).toMatch(/"kind":\s*"(asserted|calibrated|deterministic)"/);
  });
});
