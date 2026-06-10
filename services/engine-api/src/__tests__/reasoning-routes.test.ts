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
  };

  it("generates mock findings behind the gate", async () => {
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
          codeSections: [{ atomId: "code-1", label: "Sample Rule" }],
          bimElements: [{ ref: "wall:north", label: "North wall" }],
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      result: { findings: Array<{ atomId?: string; citations?: unknown[] }> };
    };
    expect(body.mode).toBe("mock");
    expect(body.result.findings.length).toBeGreaterThan(0);
    expect(body.result.findings[0]?.atomId).toMatch(/^finding:sub-1:/);
  });
});
