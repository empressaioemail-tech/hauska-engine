import { describe, expect, it } from "vitest";

import type { CodeSectionAtomInstance } from "@hauska-engine/atoms";
import { InMemoryStorage } from "@hauska-engine/storage";

import { buildApp } from "../server.js";
import {
  buildSearchHealthPayload,
  httpStatusForSearchHealth,
} from "../search-health.js";
import { HybridRetrieval } from "@hauska-engine/retrieval";

function testSection(
  partial: Partial<CodeSectionAtomInstance> & { entityId: string },
): CodeSectionAtomInstance {
  return {
    entityType: "code-section",
    jurisdictionTenant: "bastrop_tx",
    sectionNumber: "1.1",
    title: "Scope",
    bodyText: "Test section about setbacks.",
    contentHash: "abc",
    codeEditionId: "bastrop_tx/edition",
    subsectionPath: null,
    fetchedAt: "2026-08-01T00:00:00.000Z",
    sourceAdapter: "test",
    sourceUrl: "https://example.test",
    ...partial,
  };
}

describe("GET /health/search", () => {
  it("returns 200 when bounded search yields results", async () => {
    const storage = new InMemoryStorage();
    await storage.writeAtoms([
      testSection({ entityId: "bastrop_tx/edition/1-1", contentHash: "a1" }),
    ]);
    const app = buildApp({ storage, apiKey: "secret" });
    // Public — no Authorization required.
    const res = await app.request("/health/search");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.ok).toBe(true);
    expect(body.resultCount).toBeGreaterThan(0);
  });

  it("returns 503 when search path yields zero results", async () => {
    const app = buildApp({ storage: new InMemoryStorage(), apiKey: "" });
    const res = await app.request("/health/search");
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("fail");
    expect(body.ok).toBe(false);
  });

  it("buildSearchHealthPayload fails closed on retrieval throw", async () => {
    const retrieval = {
      search: async () => {
        throw new Error("simulated OOM / pool exhaustion");
      },
    } as unknown as HybridRetrieval;
    const payload = await buildSearchHealthPayload({ retrieval });
    expect(payload.ok).toBe(false);
    expect(httpStatusForSearchHealth(payload)).toBe(503);
    expect(payload.error).toMatch(/simulated OOM/);
  });
});
