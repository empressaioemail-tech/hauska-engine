/**
 * POST /v1/document-ingest endpoint tests.
 *
 * Confirms the endpoint contract, the accessPolicy firewall (a
 * private-tier caller cannot escalate extracted atoms to public), envelope
 * conformance, idempotency across two requests against the same app
 * (shared in-process store), and honest degradation (never a 500).
 */

import { describe, expect, it } from "vitest";

import type { EngineApiConfig } from "../config.js";
import { GATE_FRONT_HEADERS } from "../gate-front-context.js";
import { buildApp } from "../server.js";
import { resolveExtractedAccessPolicy } from "../routes/document-ingest.js";

function gateHeaders(
  accessTier = "tenant-private",
  tenantId = "tenant-demo",
): Record<string, string> {
  return {
    Authorization: "Bearer test-gate-token",
    "content-type": "application/json",
    [GATE_FRONT_HEADERS.product]: "cortex",
    [GATE_FRONT_HEADERS.tenantId]: tenantId,
    [GATE_FRONT_HEADERS.packageId]: "dataroom",
    [GATE_FRONT_HEADERS.accessTier]: accessTier,
    [GATE_FRONT_HEADERS.credentialId]: "gate-cred-1",
    [GATE_FRONT_HEADERS.requestId]: "req-docingest-1",
  };
}

const config: EngineApiConfig = {
  port: 8080,
  gateServiceToken: "test-gate-token",
  startedAt: "2026-07-02T00:00:00.000Z",
};

const SURVEY_TEXT =
  "RECORD OF SURVEY\nLot 4, Block B, Whispering Oaks Subdivision\nContaining 2.35 acres more or less.\nPrepared by John Smith, R.P.L.S.";

function inlineDoc(body: string, sourceRef: string) {
  return {
    document: {
      kind: "inline",
      body,
      encoding: "utf8",
      contentType: "text/plain",
      sourceRef,
    },
  };
}

describe("POST /v1/document-ingest", () => {
  it("mints provenanced atoms and returns an EngineEnvelope", async () => {
    const app = buildApp({ config });
    const res = await app.request("/v1/document-ingest", {
      method: "POST",
      headers: gateHeaders(),
      body: JSON.stringify(inlineDoc(SURVEY_TEXT, "survey-1.pdf")),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      payload: {
        status: string;
        sourceDocument: { cid: string; accessPolicy: string };
        classification: { documentType: string };
        atoms: Array<{
          atomDid: string;
          sourceDocumentCid: string;
          accessPolicy: string;
          storageRelation: string;
          confidence: { kind: string; n: number };
        }>;
      };
      confidence: { kind: string };
      source: { adapter: string };
    };
    expect(body.payload.status).toBe("ok");
    expect(body.payload.classification.documentType).toBe("survey");
    expect(body.payload.sourceDocument.cid).toMatch(/^bafydoc-/);
    expect(body.payload.sourceDocument.accessPolicy).toBe("tenant-private");
    expect(body.payload.atoms.length).toBeGreaterThan(0);
    const atom = body.payload.atoms[0]!;
    expect(atom.sourceDocumentCid).toBe(body.payload.sourceDocument.cid);
    expect(atom.confidence.kind).toBe("asserted");
    expect(atom.confidence.n).toBe(0);
    // envelope confidence is never calibrated for freshly minted atoms
    expect(["asserted", "deterministic"]).toContain(body.confidence.kind);
  });

  it("firewall: a tenant-private caller cannot escalate extracted atoms to public-paid", async () => {
    const app = buildApp({ config });
    const res = await app.request("/v1/document-ingest", {
      method: "POST",
      headers: gateHeaders("tenant-private"),
      body: JSON.stringify({
        ...inlineDoc(SURVEY_TEXT, "survey-2.pdf"),
        accessPolicy: "public-paid", // attempted escalation
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      payload: { atoms: Array<{ accessPolicy: string }> };
    };
    // clamped back to tenant-private
    expect(
      body.payload.atoms.every((a) => a.accessPolicy === "tenant-private"),
    ).toBe(true);
  });

  it("firewall: a public-paid gate tier DOES allow marketplace public-paid atoms", async () => {
    const app = buildApp({ config });
    const res = await app.request("/v1/document-ingest", {
      method: "POST",
      headers: gateHeaders("public-paid", "hauska-marketplace"),
      body: JSON.stringify({
        ...inlineDoc(SURVEY_TEXT, "licensed-survey.pdf"),
        accessPolicy: "public-paid",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      payload: {
        sourceDocument: { accessPolicy: string };
        atoms: Array<{ accessPolicy: string }>;
      };
    };
    expect(body.payload.atoms.every((a) => a.accessPolicy === "public-paid")).toBe(
      true,
    );
    // source blob stays gated even for marketplace ingest
    expect(body.payload.sourceDocument.accessPolicy).toBe("tenant-private");
  });

  it("is idempotent across two identical requests (no duplicate atoms)", async () => {
    const app = buildApp({ config });
    const req = () =>
      app.request("/v1/document-ingest", {
        method: "POST",
        headers: gateHeaders(),
        body: JSON.stringify(inlineDoc(SURVEY_TEXT, "survey-idem.pdf")),
      });
    const first = (await (await req()).json()) as {
      payload: { atoms: Array<{ atomDid: string; created: boolean }> };
    };
    const second = (await (await req()).json()) as {
      payload: { atoms: Array<{ atomDid: string; created: boolean }> };
    };
    const firstIds = first.payload.atoms.map((a) => a.atomDid).sort();
    const secondIds = second.payload.atoms.map((a) => a.atomDid).sort();
    expect(secondIds).toEqual(firstIds);
    expect(first.payload.atoms.every((a) => a.created)).toBe(true);
    expect(second.payload.atoms.every((a) => !a.created)).toBe(true);
  });

  it("does NOT 500 on an unreadable document — honest degraded envelope", async () => {
    const app = buildApp({ config });
    const res = await app.request("/v1/document-ingest", {
      method: "POST",
      headers: gateHeaders(),
      body: JSON.stringify({
        document: {
          kind: "inline",
          body: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00]).toString("base64"),
          encoding: "base64",
          contentType: "application/pdf",
          sourceRef: "scan.pdf",
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      payload: { status: string; sourceDocument: { pinned: boolean }; reason?: string };
      coverage: { degraded: boolean };
    };
    expect(body.payload.status).toBe("degraded");
    expect(body.payload.sourceDocument.pinned).toBe(true);
    expect(body.coverage.degraded).toBe(true);
    expect(body.payload.reason).toBeTruthy();
  });

  it("400s (not 500) on a malformed request body", async () => {
    const app = buildApp({ config });
    const res = await app.request("/v1/document-ingest", {
      method: "POST",
      headers: gateHeaders(),
      body: JSON.stringify({ document: { kind: "nonsense" } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("resolveExtractedAccessPolicy (firewall unit)", () => {
  it("defaults to tenant-private with no request under a private gate", () => {
    expect(resolveExtractedAccessPolicy(undefined, "tenant-private")).toBe(
      "tenant-private",
    );
  });
  it("clamps a public-paid request under a private gate to tenant-private", () => {
    expect(resolveExtractedAccessPolicy("public-paid", "tenant-private")).toBe(
      "tenant-private",
    );
  });
  it("honors a public-paid request under a public-paid gate", () => {
    expect(resolveExtractedAccessPolicy("public-paid", "public-paid")).toBe(
      "public-paid",
    );
  });
  it("passes tenant-private / tenant-shared through", () => {
    expect(resolveExtractedAccessPolicy("tenant-shared", "tenant-private")).toBe(
      "tenant-shared",
    );
  });
});
