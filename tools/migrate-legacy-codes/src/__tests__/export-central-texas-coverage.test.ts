import { describe, expect, it } from "vitest";

import type { CodeSectionAtomInstance } from "@hauska-engine/atoms";
import type { CorpusSnapshot } from "@hauska-engine/storage";

import { ENGINE_CORPUS_JURISDICTION_KEYS } from "../central-texas-pilot-keys.js";
import { buildCentralTexasCoverageFromSnapshot } from "../export-central-texas-coverage.js";

describe("buildCentralTexasCoverageFromSnapshot", () => {
  it("counts sectionsWithBody per jurisdiction", () => {
    const sections: CodeSectionAtomInstance[] = [
      {
        entityType: "code-section",
        entityId: "round_rock_tx/ed/s1",
        jurisdictionTenant: "round_rock_tx",
        codeEditionId: "round_rock_tx/ed",
        sectionNumber: "1",
        title: "T",
        subsectionPath: null,
        bodyText: "body",
        fetchedAt: "2026-05-26T00:00:00.000Z",
        sourceAdapter: "municode-html",
        sourceUrl: "https://example.com",
        contentHash: "h1",
      },
      {
        entityType: "code-section",
        entityId: "round_rock_tx/ed/s2",
        jurisdictionTenant: "round_rock_tx",
        codeEditionId: "round_rock_tx/ed",
        sectionNumber: "2",
        title: "Empty",
        subsectionPath: null,
        bodyText: "",
        fetchedAt: "2026-05-26T00:00:00.000Z",
        sourceAdapter: "municode-html",
        sourceUrl: "https://example.com",
        contentHash: "h2",
      },
    ];
    const snapshot: CorpusSnapshot = {
      format: "hauska-corpus-snapshot/1",
      generatedAt: "2026-05-26T17:26:12.400Z",
      atoms: sections,
      links: [],
      jurisdictionStatus: [
        {
          jurisdictionTenant: "round_rock_tx",
          jurisdictionName: "Round Rock, TX",
          currentEditionDid: null,
          qualityBar: "passing",
          top3Score: 1,
          sectionNumScore: 1,
          crossRefScore: 1,
          atomCount: 2,
          lastRefreshedAt: "2026-05-26T00:00:00.000Z",
          driftStatus: "clean",
          accessPolicy: "public-free",
        },
      ],
    };
    const artifact = buildCentralTexasCoverageFromSnapshot(snapshot);
    expect(artifact.baselineKeyCount).toBe(ENGINE_CORPUS_JURISDICTION_KEYS.length);
    const rr = artifact.jurisdictions.find((j) => j.jurisdictionKey === "round_rock_tx");
    expect(rr?.atomCount).toBe(2);
    expect(rr?.sectionsWithBody).toBe(1);
    expect(artifact.keysMatchBaseline).toBe(false);
  });
});
