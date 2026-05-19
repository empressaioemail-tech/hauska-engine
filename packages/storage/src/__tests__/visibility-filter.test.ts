/**
 * Visibility-filter test for `listJurisdictionStatus` — the Sync 4.5
 * MCP-boundary semantic per ADR-017 / @hauska/atom-contract@^1.1.0.
 *
 * Demonstrates: unauthenticated callers (filter `["public-free"]`) see
 * partnership-confirmed jurisdictions only. Platform-internal callers
 * (no filter) see every jurisdiction including partnership-pending
 * ingests.
 *
 * Anchors the engine side of cc-agent-M's Lane B `list_jurisdictions`
 * implementation: the MCP server attaches the accessPolicies filter to
 * each call based on auth-context; this storage port honors it.
 */

import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "../in-memory-storage.js";

describe("listJurisdictionStatus — visibility filter", () => {
  function seed(): InMemoryStorage {
    const storage = new InMemoryStorage();
    // Mirror the 2026-05-19 Sync 4.5 corpus: Bastrop UDC public, the
    // three partnership-pending jurisdictions internal. Quality bar
    // shapes vary so the `qualityBarOnly` filter is also exercised.
    storage.upsertJurisdictionStatus({
      jurisdictionTenant: "grand_county_ut",
      jurisdictionName: "Grand County, UT",
      currentEditionDid: "did:hauska:code-edition:grand_county_ut/full",
      qualityBar: "passing",
      top3Score: 0.95,
      sectionNumScore: 1.0,
      crossRefScore: 1.0,
      atomCount: 290,
      lastRefreshedAt: "2026-05-19T00:00:00Z",
      driftStatus: "clean",
      accessPolicy: "public-free",
    });
    storage.upsertJurisdictionStatus({
      jurisdictionTenant: "bastrop_tx",
      jurisdictionName: "Bastrop, TX",
      currentEditionDid: "did:hauska:code-edition:bastrop_tx/b3-2025",
      qualityBar: "passing",
      top3Score: 1.0,
      sectionNumScore: 1.0,
      crossRefScore: 1.0,
      atomCount: 181,
      lastRefreshedAt: "2026-05-19T00:00:00Z",
      driftStatus: "clean",
      accessPolicy: "public-free",
    });
    storage.upsertJurisdictionStatus({
      jurisdictionTenant: "bastrop_county_tx",
      jurisdictionName: "Bastrop County, TX",
      currentEditionDid: "did:hauska:code-edition:bastrop_county_tx/sub-2017",
      qualityBar: "passing",
      top3Score: 1.0,
      sectionNumScore: 1.0,
      crossRefScore: 1.0,
      atomCount: 17,
      lastRefreshedAt: "2026-05-19T00:00:00Z",
      driftStatus: "clean",
      accessPolicy: "platform-internal",
    });
    storage.upsertJurisdictionStatus({
      jurisdictionTenant: "elgin_tx",
      jurisdictionName: "Elgin, TX",
      currentEditionDid: "did:hauska:code-edition:elgin_tx/full",
      qualityBar: "passing",
      top3Score: 1.0,
      sectionNumScore: 1.0,
      crossRefScore: 1.0,
      atomCount: 210,
      lastRefreshedAt: "2026-05-19T00:00:00Z",
      driftStatus: "clean",
      accessPolicy: "platform-internal",
    });
    return storage;
  }

  it("no filter: platform-internal callers see all jurisdictions", async () => {
    const storage = seed();
    const all = await storage.listJurisdictionStatus();
    const tenants = all.map((s) => s.jurisdictionTenant).sort();
    expect(tenants).toEqual([
      "bastrop_county_tx",
      "bastrop_tx",
      "elgin_tx",
      "grand_county_ut",
    ]);
  });

  it("public-free filter: unauthenticated callers see only partnership-confirmed", async () => {
    const storage = seed();
    const publicOnly = await storage.listJurisdictionStatus({
      accessPolicies: ["public-free"],
    });
    const tenants = publicOnly.map((s) => s.jurisdictionTenant).sort();
    expect(tenants).toEqual(["bastrop_tx", "grand_county_ut"]);
    for (const s of publicOnly) {
      expect(s.accessPolicy ?? "public-free").toBe("public-free");
    }
  });

  it("platform-internal filter: partnership-pending only", async () => {
    const storage = seed();
    const internalOnly = await storage.listJurisdictionStatus({
      accessPolicies: ["platform-internal"],
    });
    const tenants = internalOnly.map((s) => s.jurisdictionTenant).sort();
    expect(tenants).toEqual(["bastrop_county_tx", "elgin_tx"]);
  });

  it("combined filter: public-free OR platform-internal returns all four", async () => {
    const storage = seed();
    const both = await storage.listJurisdictionStatus({
      accessPolicies: ["public-free", "platform-internal"],
    });
    expect(both).toHaveLength(4);
  });

  it("absent accessPolicy is treated as public-free", async () => {
    const storage = seed();
    storage.upsertJurisdictionStatus({
      jurisdictionTenant: "legacy_pre_v1_1",
      jurisdictionName: "Legacy Pre-v1.1.0 Jurisdiction",
      currentEditionDid: null,
      qualityBar: "passing",
      top3Score: 1.0,
      sectionNumScore: 1.0,
      crossRefScore: 1.0,
      atomCount: 0,
      lastRefreshedAt: null,
      driftStatus: "clean",
      // accessPolicy omitted — predates v1.1.0
    });
    const publicOnly = await storage.listJurisdictionStatus({
      accessPolicies: ["public-free"],
    });
    const tenants = publicOnly.map((s) => s.jurisdictionTenant);
    expect(tenants).toContain("legacy_pre_v1_1");
  });

  it("qualityBarOnly filter composes with accessPolicies filter", async () => {
    const storage = seed();
    // Add a failing internal jurisdiction.
    storage.upsertJurisdictionStatus({
      jurisdictionTenant: "smithville_tx",
      jurisdictionName: "Smithville, TX",
      currentEditionDid: null,
      qualityBar: "not-evaluated",
      top3Score: null,
      sectionNumScore: null,
      crossRefScore: null,
      atomCount: 0,
      lastRefreshedAt: null,
      driftStatus: "clean",
      accessPolicy: "platform-internal",
    });
    const internalPassing = await storage.listJurisdictionStatus({
      qualityBarOnly: true,
      accessPolicies: ["platform-internal"],
    });
    const tenants = internalPassing.map((s) => s.jurisdictionTenant).sort();
    expect(tenants).toEqual(["bastrop_county_tx", "elgin_tx"]);
    // smithville_tx excluded (qualityBar=not-evaluated)
  });
});
