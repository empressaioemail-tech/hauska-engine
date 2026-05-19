/**
 * End-to-end dry-run test: feed fixture rows through a stubbed
 * LegacyClient, run the full migration into InMemoryStorage, run
 * the eval harness against the seed queries, assert sane shape.
 *
 * This is the test that proves Sync 4 readiness without Neon access.
 */

import { describe, expect, it } from "vitest";

import { evaluate } from "@hauska-engine/corpus/eval";
import { InMemoryStorage } from "@hauska-engine/storage";

import type { LegacyClient } from "../legacy-client.js";
import { runMigration } from "../migrate.js";
import { curatedQueriesForJurisdiction } from "../seed-curated-queries.js";
import {
  ALL_ROWS,
  BASTROP_ROWS,
  GRAND_COUNTY_ROWS,
  SOURCES,
} from "./fixtures.js";
import type { LegacyCodeAtomRow } from "../legacy-types.js";

class StubLegacyClient implements Pick<LegacyClient, "listSources" | "readAtoms" | "close" | "coverageReport" | "probeBastropUdc"> {
  constructor(private readonly rows: ReadonlyArray<LegacyCodeAtomRow>) {}

  async listSources() {
    return SOURCES;
  }

  async readAtoms(filter?: {
    jurisdictionKey?: string;
    codeBook?: string;
  }) {
    return this.rows.filter((r) => {
      if (filter?.jurisdictionKey && r.jurisdiction_key !== filter.jurisdictionKey) {
        return false;
      }
      if (filter?.codeBook && r.code_book !== filter.codeBook) return false;
      return true;
    });
  }

  async coverageReport() {
    return [];
  }

  async probeBastropUdc() {
    return { candidateSections: [], totalBastropAtoms: 0, udcCandidateCount: 0 };
  }

  async close() {}
}

describe("migration end-to-end", () => {
  it("transforms + synthesizes + writes atoms into the storage port", async () => {
    const storage = new InMemoryStorage();
    const legacy = new StubLegacyClient(ALL_ROWS) as unknown as LegacyClient;
    const result = await runMigration({ legacy, storage });

    expect(result.report.sectionsTransformed).toBe(7); // 3 bastrop + 4 grand county valid
    expect(result.report.editionsSynthesized).toBe(3);
    expect(result.report.corporaSynthesized).toBe(2);
    expect(result.report.crossReferencesSynthesized).toBeGreaterThanOrEqual(2);

    // Spot-check storage retrievability via search.
    const bastropHits = await storage.search({
      q: "setback",
      jurisdiction: "bastrop_tx",
    });
    expect(bastropHits.length).toBeGreaterThan(0);

    const jurisdictions = await storage.listJurisdictionStatus();
    expect(jurisdictions.length).toBe(2);
    expect(
      jurisdictions.find((j) => j.jurisdictionTenant === "bastrop_tx"),
    ).toBeDefined();
  });

  it("filtering to bastrop migrates only Bastrop atoms", async () => {
    const storage = new InMemoryStorage();
    const legacy = new StubLegacyClient(ALL_ROWS) as unknown as LegacyClient;
    const result = await runMigration({
      legacy,
      storage,
      filter: { jurisdictionKey: "bastrop_tx" },
    });
    expect(result.report.sectionsTransformed).toBe(3);
    expect(result.report.editionsSynthesized).toBe(1);
    expect(result.report.corporaSynthesized).toBe(1);
  });

  it("eval harness runs against the migrated bastrop corpus + seed queries", async () => {
    const storage = new InMemoryStorage();
    const legacy = new StubLegacyClient(BASTROP_ROWS) as unknown as LegacyClient;
    await runMigration({ legacy, storage });

    const queries = curatedQueriesForJurisdiction("bastrop_tx");
    expect(queries.length).toBeGreaterThan(0);
    const report = await evaluate({
      storage,
      jurisdictionTenant: "bastrop_tx",
      queries,
    });
    expect(report.jurisdictionTenant).toBe("bastrop_tx");
    expect(report.queriesEvaluated).toBe(queries.length);
    // Score may be low because the seed queries target chapters not
    // present in the small fixture corpus; that's expected. The
    // assertion verifies the harness ran end-to-end, not the score.
    expect(typeof report.scores.top3Score).toBe("number");
    expect(typeof report.scores.sectionNumScore).toBe("number");
    expect(typeof report.scores.crossRefScore).toBe("number");
  });

  it("eval harness against grand county uses IWUIC + R301 scope only", async () => {
    const storage = new InMemoryStorage();
    const legacy = new StubLegacyClient(GRAND_COUNTY_ROWS) as unknown as LegacyClient;
    await runMigration({ legacy, storage });

    const queries = curatedQueriesForJurisdiction("grand_county_ut");
    expect(queries.length).toBeGreaterThan(0);
    // Per dispatch: no full-IRC queries.
    for (const q of queries) {
      expect(q.queryText.toLowerCase()).not.toContain("full irc");
    }
    const report = await evaluate({
      storage,
      jurisdictionTenant: "grand_county_ut",
      queries,
    });
    expect(report.queriesEvaluated).toBe(queries.length);
  });
});
