/**
 * Spine health HTTP routes — /health links + /health/spine (+ run).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";
import type { CodeSectionAtomInstance } from "@hauska-engine/atoms";

import { buildApp } from "../server.js";
import * as runPack from "../spine-health/run-pack.js";

function testSection(
  partial: Partial<CodeSectionAtomInstance> & { entityId: string },
): CodeSectionAtomInstance {
  return {
    entityType: "code-section",
    jurisdictionTenant: "test-tx",
    sectionNumber: "1.1",
    title: "Scope",
    bodyText: "Test section.",
    contentHash: "abc",
    codeEditionId: "test/edition",
    subsectionPath: null,
    fetchedAt: "2026-06-07T00:00:00.000Z",
    sourceAdapter: "test",
    sourceUrl: "https://example.test",
    ...partial,
  };
}

const SAMPLE_SUMMARY = {
  pack: "bastrop",
  probedAt: "2026-07-27T12:00:00.000Z",
  alertCount: 1,
  probes: [
    {
      probeId: "zoning-agol:bastrop-city-tx",
      kind: "source" as const,
      pack: "bastrop",
      status: "dead" as const,
      alert: true,
      signal: { count: 0 },
      baselineValue: 574,
      currentValue: 0,
      error: null,
      lastSuccessAt: null,
      probedAt: "2026-07-27T12:00:00.000Z",
    },
  ],
};

describe("spine-health routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GET /health includes links.spineHealth and spineHealthRun", async () => {
    const storage = new InMemoryStorage();
    await storage.writeAtoms([
      testSection({ entityId: "test/spine-health-1", contentHash: "a" }),
    ]);
    const app = buildApp({ storage, apiKey: "" });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      service: string;
      startedAt: string;
      links?: { spineHealth?: string; spineHealthRun?: string };
    };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("retrieval-api");
    expect(typeof body.startedAt).toBe("string");
    expect(body.links?.spineHealth).toBe("/health/spine");
    expect(body.links?.spineHealthRun).toBe("/health/spine/run");
  });

  it("GET /health/spine returns pack summary", async () => {
    vi.spyOn(runPack, "readSpineHealthSummary").mockResolvedValue(
      SAMPLE_SUMMARY,
    );

    const storage = new InMemoryStorage();
    await storage.writeAtoms([
      testSection({ entityId: "test/spine-health-2", contentHash: "b" }),
    ]);
    const app = buildApp({ storage, apiKey: "" });
    const res = await app.request("/health/spine");
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof SAMPLE_SUMMARY;
    expect(body.pack).toBe("bastrop");
    expect(body.alertCount).toBe(1);
    expect(body.probes[0]?.probeId).toBe("zoning-agol:bastrop-city-tx");
  });

  it("POST /health/spine/run returns run result", async () => {
    vi.spyOn(runPack, "runBastropSpineHealthPack").mockResolvedValue({
      summary: SAMPLE_SUMMARY,
      persisted: false,
      persistedCount: 0,
    });

    const storage = new InMemoryStorage();
    const app = buildApp({ storage, apiKey: "" });
    const res = await app.request("/health/spine/run", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: typeof SAMPLE_SUMMARY;
      persisted: boolean;
    };
    expect(body.summary.pack).toBe("bastrop");
    expect(body.persisted).toBe(false);
  });
});
