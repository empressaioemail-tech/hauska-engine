import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";
import type { CodeSectionAtomInstance } from "@hauska-engine/atoms";

import { buildApp } from "../server.js";
import * as substrateDb from "../substrate-db-probe.js";

function testSection(partial: Partial<CodeSectionAtomInstance> & { entityId: string }): CodeSectionAtomInstance {
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

describe("GET /healthz", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SUBSTRATE_DATABASE_URL;
    delete process.env.DATABASE_URL;
  });

  it("returns ok with corpus count when db is not configured", async () => {
    const storage = new InMemoryStorage();
    await storage.upsertJurisdictionStatus({
      jurisdictionTenant: "test-tx",
      jurisdictionName: "Test",
      currentEditionDid: null,
      qualityBar: "passing",
      top3Score: 1,
      sectionNumScore: 1,
      crossRefScore: 1,
      atomCount: 3,
      lastRefreshedAt: null,
      driftStatus: "clean",
    });
    await storage.writeAtoms([testSection({ entityId: "test/1", contentHash: "abc" })]);

    const app = buildApp({ storage, apiKey: "" });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("warn");
    expect(body.corpus).toMatchObject({ ok: true, atomCount: 1 });
    expect(body.db).toMatchObject({ ok: false, status: "not_configured" });
  });

  it("returns fail with HTTP 503 when corpus is empty", async () => {
    const app = buildApp({ storage: new InMemoryStorage(), apiKey: "" });
    const res = await app.request("/healthz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("fail");
    expect(body.corpus).toMatchObject({ ok: false, atomCount: 0 });
  });

  it("returns fail when substrate db probe fails", async () => {
    vi.spyOn(substrateDb, "probeSubstrateDb").mockResolvedValue({
      ok: false,
      error: "connection refused",
    });

    const storage = new InMemoryStorage();
    await storage.writeAtoms([testSection({ entityId: "test/2", contentHash: "def" })]);

    const app = buildApp({
      storage,
      apiKey: "",
      substrateDatabaseUrl: "postgres://example/test",
    });
    const res = await app.request("/healthz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("fail");
    expect(body.db).toMatchObject({ ok: false, status: "down" });
  });

  it("returns ok when db probe succeeds and corpus is loaded", async () => {
    vi.spyOn(substrateDb, "probeSubstrateDb").mockResolvedValue({
      ok: true,
      latencyMs: 12,
    });

    const storage = new InMemoryStorage();
    await storage.writeAtoms([testSection({ entityId: "test/3", contentHash: "ghi" })]);

    const app = buildApp({
      storage,
      apiKey: "",
      substrateDatabaseUrl: "postgres://example/test",
    });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.db).toMatchObject({ ok: true, status: "up", latencyMs: 12 });
  });

  it("does not require auth when apiKey is configured", async () => {
    const storage = new InMemoryStorage();
    await storage.writeAtoms([testSection({ entityId: "test/4", contentHash: "jkl" })]);
    const app = buildApp({ storage, apiKey: "secret" });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
  });

  it("serves /healthz/ for Cloud Run GFE workaround", async () => {
    const storage = new InMemoryStorage();
    await storage.writeAtoms([testSection({ entityId: "test/5", contentHash: "mno" })]);
    const app = buildApp({ storage, apiKey: "" });
    const res = await app.request("/healthz/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("warn");
  });
});
