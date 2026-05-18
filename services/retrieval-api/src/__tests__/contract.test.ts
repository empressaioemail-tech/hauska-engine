/**
 * Sync 3 contract test — covers all locked endpoints.
 *
 * Asserts shape + status codes against the in-memory storage. The
 * hauska-mcp-server Stream 2A test suite should mirror these payload
 * shapes to keep both sides aligned post-Sync-3.
 */

import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";
import { atomize } from "@hauska-engine/corpus/atomization";
import { buildCodeTree } from "@hauska-engine/corpus/extraction";
import { MunicodeHtmlAdapter } from "@hauska-engine/corpus/adapters";
import { RespectfulFetch } from "@hauska-engine/corpus/adapters";

import { buildApp } from "../server.js";

class StubFetch extends RespectfulFetch {
  constructor(private readonly body: string) {
    super({ maxRequestsPerSecondPerHost: 1000 });
  }
  override async fetchText(): Promise<string> {
    return this.body;
  }
}

const FIXTURE = `<!doctype html>
<html><body>
  <h1>Chapter 1</h1>
  <h3 id="sec-1-01">§ 1.01 Scope</h3>
  <p>See § 5.04(b) for setbacks.</p>
  <h3 id="sec-5-04">§ 5.04 Setbacks</h3>
  <p>Setback rule.</p>
  <dl><dt>Lot</dt><dd>A parcel.</dd></dl>
</body></html>`;

async function seed(storage: InMemoryStorage) {
  const adapter = new MunicodeHtmlAdapter({ http: new StubFetch(FIXTURE) });
  const raw = await adapter.fetch({
    sourceId: "test/test",
    jurisdictionTenant: "test-tx",
    editionLabel: "Test Code 2024",
    sourceUrl: "https://example/test",
  });
  const normalized = await adapter.normalize(raw);
  const tree = buildCodeTree(normalized);
  const atomized = atomize(tree);
  await storage.writeAtoms([
    atomized.jurisdictionCorpus,
    atomized.edition,
    ...atomized.sections,
    ...atomized.definitions,
    ...atomized.crossReferences,
    ...atomized.amendments,
  ]);
  await storage.writeAtomLinks(atomized.links);
  await storage.upsertJurisdictionStatus({
    jurisdictionTenant: "test-tx",
    jurisdictionName: "Test City",
    currentEditionDid: `did:hauska:code-edition:${atomized.edition.entityId}`,
    qualityBar: "passing",
    top3Score: 0.95,
    sectionNumScore: 1.0,
    crossRefScore: 0.96,
    atomCount: atomized.sections.length,
    lastRefreshedAt: new Date().toISOString(),
    driftStatus: "clean",
  });
  return atomized;
}

describe("retrieval-api contract (Sync 3)", () => {
  it("GET /health returns ok", async () => {
    const app = buildApp({ storage: new InMemoryStorage(), apiKey: "" });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.status).toBe("ok");
  });

  it("GET /ready returns ready when storage is reachable", async () => {
    const app = buildApp({ storage: new InMemoryStorage(), apiKey: "" });
    const res = await app.request("/ready");
    expect(res.status).toBe(200);
  });

  it("enforces auth when apiKey configured", async () => {
    const app = buildApp({ storage: new InMemoryStorage(), apiKey: "secret" });
    const unauth = await app.request("/search?q=lot");
    expect(unauth.status).toBe(401);
    const auth = await app.request("/search?q=lot", {
      headers: { authorization: "Bearer secret" },
    });
    expect(auth.status).toBe(200);
  });

  it("GET /search returns results", async () => {
    const storage = new InMemoryStorage();
    await seed(storage);
    const app = buildApp({ storage, apiKey: "" });
    const res = await app.request("/search?q=setback&jurisdiction=test-tx");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);
  });

  it("GET /atoms/:did returns atom + composition when requested", async () => {
    const storage = new InMemoryStorage();
    const atomized = await seed(storage);
    const app = buildApp({ storage, apiKey: "" });
    const section = atomized.sections[0]!;
    const did = `did:hauska:code-section:${section.entityId}`;
    const res = await app.request(
      `/atoms/${encodeURIComponent(did)}?includeComposition=true`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.atom.entityType).toBe("code-section");
  });

  it("GET /jurisdictions returns the seeded list", async () => {
    const storage = new InMemoryStorage();
    await seed(storage);
    const app = buildApp({ storage, apiKey: "" });
    const res = await app.request("/jurisdictions");
    const body = (await res.json()) as Record<string, any>;
    expect(body.jurisdictions.length).toBe(1);
    expect(body.jurisdictions[0].qualityBar).toBe("passing");
  });

  it("GET /jurisdictions/:id returns status", async () => {
    const storage = new InMemoryStorage();
    await seed(storage);
    const app = buildApp({ storage, apiKey: "" });
    const res = await app.request("/jurisdictions/test-tx");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.status.jurisdictionTenant).toBe("test-tx");
  });

  it("GET /jurisdictions/:id/permits requires projectType", async () => {
    const storage = new InMemoryStorage();
    await seed(storage);
    const app = buildApp({ storage, apiKey: "" });
    const missing = await app.request("/jurisdictions/test-tx/permits");
    expect(missing.status).toBe(400);
    const ok = await app.request("/jurisdictions/test-tx/permits?projectType=setback");
    expect(ok.status).toBe(200);
  });

  it("returns 404 for unknown jurisdiction", async () => {
    const storage = new InMemoryStorage();
    const app = buildApp({ storage, apiKey: "" });
    const res = await app.request("/jurisdictions/no-such");
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown atom DID", async () => {
    const storage = new InMemoryStorage();
    const app = buildApp({ storage, apiKey: "" });
    const res = await app.request(
      `/atoms/${encodeURIComponent("did:hauska:code-section:nope/nope/nope")}`,
    );
    expect(res.status).toBe(404);
  });
});
