/**
 * Findings route refuses mock fabrication and missing LLM keys.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EngineApiConfig } from "../config.js";
import { GATE_FRONT_HEADERS } from "../gate-front-context.js";
import { buildApp } from "../server.js";

function gateHeaders(): Record<string, string> {
  return {
    Authorization: "Bearer test-gate-token",
    "content-type": "application/json",
    [GATE_FRONT_HEADERS.product]: "cortex",
    [GATE_FRONT_HEADERS.tenantId]: "tenant-demo",
    [GATE_FRONT_HEADERS.packageId]: "plan-review",
    [GATE_FRONT_HEADERS.accessTier]: "tenant-private",
    [GATE_FRONT_HEADERS.credentialId]: "gate-cred-1",
    [GATE_FRONT_HEADERS.requestId]: "req-findings-refuse-1",
  };
}

const config: EngineApiConfig = {
  port: 8080,
  gateServiceToken: "test-gate-token",
  startedAt: "2026-07-02T00:00:00.000Z",
  gateContextSigningKey: "",
  gateContextMode: "off",
};

const inputWithCodeSection = {
  submission: { id: "sub-1", jurisdiction: "Austin, TX", projectName: "Refuse test" },
  sources: [
    {
      id: "src-1",
      layerKind: "qgis-zoning",
      sourceKind: "manual-upload",
      provider: "Test",
      snapshotDate: "2026-01-01",
    },
  ],
  codeSections: [
    {
      atomId: "did:hauska:code-section:test/1",
      label: "R301 Design Criteria",
    },
  ],
  bimElements: [],
};

function findingsInBody(body: unknown): unknown[] {
  const payload = (body as { payload?: { result?: { findings?: unknown[] } } }).payload;
  return payload?.result?.findings ?? [];
}

function hasFabricatedBlocker(findings: unknown[]): boolean {
  return findings.some(
    (f) =>
      typeof f === "object" &&
      f !== null &&
      (f as { severity?: string }).severity === "blocker" &&
      typeof (f as { confidence?: number }).confidence === "number" &&
      ((f as { confidence?: number }).confidence ?? 0) >= 0.9,
  );
}

describe("Findings route fail-closed (E-2)", () => {
  const app = buildApp({ config });
  let savedMode: string | undefined;
  let savedXai: string | undefined;
  let savedGrok: string | undefined;

  beforeEach(() => {
    savedMode = process.env.AIR_FINDING_LLM_MODE;
    savedXai = process.env.XAI_API_KEY;
    savedGrok = process.env.GROK_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_API_KEY;
  });

  afterEach(() => {
    if (savedMode === undefined) delete process.env.AIR_FINDING_LLM_MODE;
    else process.env.AIR_FINDING_LLM_MODE = savedMode;
    if (savedXai === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = savedXai;
    if (savedGrok === undefined) delete process.env.GROK_API_KEY;
    else process.env.GROK_API_KEY = savedGrok;
  });

  it("rejects mock mode in the request body with no fabricated blocker findings", async () => {
    process.env.AIR_FINDING_LLM_MODE = "grok";
    process.env.XAI_API_KEY = "test-key";
    const res = await app.request("/v1/findings/generate", {
      method: "POST",
      headers: gateHeaders(),
      body: JSON.stringify({ mode: "mock", input: inputWithCodeSection }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(hasFabricatedBlocker(findingsInBody(body))).toBe(false);
  });

  it("refuses when AIR_FINDING_LLM_MODE is unset", async () => {
    delete process.env.AIR_FINDING_LLM_MODE;
    const res = await app.request("/v1/findings/generate", {
      method: "POST",
      headers: gateHeaders(),
      body: JSON.stringify({ input: inputWithCodeSection }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(hasFabricatedBlocker(findingsInBody(body))).toBe(false);
  });

  it("refuses grok mode when XAI_API_KEY is absent", async () => {
    process.env.AIR_FINDING_LLM_MODE = "grok";
    const res = await app.request("/v1/findings/generate", {
      method: "POST",
      headers: gateHeaders(),
      body: JSON.stringify({ mode: "grok", input: inputWithCodeSection }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect((body as { error?: string }).error).toBe("llm_resolution_refusal");
    expect(hasFabricatedBlocker(findingsInBody(body))).toBe(false);
  });
});
