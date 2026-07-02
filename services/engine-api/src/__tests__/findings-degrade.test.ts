/**
 * Fix 1 regression (findings surface) — the findings tile must NEVER
 * return a hard 500 because ANTHROPIC_API_KEY is absent, because the
 * live LLM throws, or because the input bundle is minimal/malformed
 * (company commitment #1). The route degrades: anthropic -> grok ->
 * deterministic mock, with a last-resort mock guard in the catch.
 *
 * These cases were the adversarial-review break of the first pass, when
 * the findings route degraded the *mode* but had no mock fallback in its
 * catch and the mock generator threw on missing input fields.
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
    [GATE_FRONT_HEADERS.requestId]: "req-findings-degrade-1",
  };
}

const config: EngineApiConfig = {
  port: 8080,
  gateServiceToken: "test-gate-token",
  startedAt: "2026-07-02T00:00:00.000Z",
};

const wellFormedInput = {
  submission: {
    id: "sub-1",
    jurisdiction: "Austin, TX",
    projectName: "Findings degrade",
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
  codeSections: [],
  bimElements: [],
};

describe("Findings graceful degradation (Fix 1 — no 500)", () => {
  const app = buildApp({ config });
  let savedAnthropic: string | undefined;
  let savedXai: string | undefined;
  let savedGrok: string | undefined;

  beforeEach(() => {
    savedAnthropic = process.env.ANTHROPIC_API_KEY;
    savedXai = process.env.XAI_API_KEY;
    savedGrok = process.env.GROK_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_API_KEY;
  });

  afterEach(() => {
    if (savedAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedAnthropic;
    if (savedXai === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = savedXai;
    if (savedGrok === undefined) delete process.env.GROK_API_KEY;
    else process.env.GROK_API_KEY = savedGrok;
  });

  it("does NOT 500 on mode=anthropic with no key and a WELL-FORMED input (adversarial F-ATTACK2)", async () => {
    const res = await app.request("/v1/findings/generate", {
      method: "POST",
      headers: gateHeaders(),
      body: JSON.stringify({ mode: "anthropic", input: wellFormedInput }),
    });
    expect(res.status).toBe(200);
  });

  it("does NOT 500 on mode=anthropic with no key and a minimal input", async () => {
    const res = await app.request("/v1/findings/generate", {
      method: "POST",
      headers: gateHeaders(),
      body: JSON.stringify({ mode: "anthropic", input: {} }),
    });
    expect(res.status).toBe(200);
  });

  it("does NOT 500 when a fake grok key makes the live call throw (last-resort mock guard)", async () => {
    process.env.XAI_API_KEY = "xai-fake-key";
    const res = await app.request("/v1/findings/generate", {
      method: "POST",
      headers: gateHeaders(),
      body: JSON.stringify({ mode: "grok", input: wellFormedInput }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      payload: { degraded?: boolean; mode?: string };
    };
    expect(body.payload.degraded).toBe(true);
    expect(body.payload.mode).toBe("mock");
  });

  it("does NOT 500 on the orchestrated route with no key and minimal input", async () => {
    const res = await app.request("/v1/findings/generate-orchestrated", {
      method: "POST",
      headers: gateHeaders(),
      body: JSON.stringify({
        mode: "anthropic",
        input: { baseInput: wellFormedInput },
      }),
    });
    expect(res.status).toBe(200);
  });
});
