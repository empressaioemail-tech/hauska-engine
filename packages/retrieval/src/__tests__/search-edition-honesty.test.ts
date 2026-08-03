/**
 * PR-2 — /search edition honesty. Default excludes superseded-edition
 * code-section rows; includeSuperseded:true opts back in; unresolvable
 * edition status is never excluded (fail-open).
 */

import { describe, expect, it } from "vitest";

import type {
  CodeSectionAtomInstance,
  JurisdictionCorpusAtomInstance,
} from "@hauska-engine/atoms";
import { InMemoryStorage } from "@hauska-engine/storage";

import { HybridRetrieval } from "../index.js";

const JURISDICTION = "bastrop_tx";
const CURRENT_EDITION = "bastrop_tx-bdc-2026-adopted";
const SUPERSEDED_EDITION = "bastrop_tx-b3-code-april-2025";

function corpusAtom(
  overrides: Partial<JurisdictionCorpusAtomInstance> = {},
): JurisdictionCorpusAtomInstance {
  return {
    entityType: "jurisdiction-corpus",
    entityId: JURISDICTION,
    jurisdictionTenant: JURISDICTION,
    jurisdictionName: "Bastrop, TX",
    adoptedEditionIds: [SUPERSEDED_EDITION, CURRENT_EDITION],
    currentEditionId: CURRENT_EDITION,
    coverageQualityBar: "not-evaluated",
    lastRefreshedAt: "2026-07-30T00:00:00.000Z",
    fetchedAt: "2026-07-30T00:00:00.000Z",
    sourceAdapter: "bastrop-bdc-pdf",
    sourceUrl: "https://example.invalid/bastrop-bdc",
    contentHash: "corpushash1",
    ...overrides,
  };
}

function codeSection(
  overrides: Partial<CodeSectionAtomInstance> = {},
): CodeSectionAtomInstance {
  return {
    entityType: "code-section",
    entityId: `${JURISDICTION}-current/14-02-003`,
    jurisdictionTenant: JURISDICTION,
    codeEditionId: CURRENT_EDITION,
    sectionNumber: "14.02.003",
    title: "District Requirements",
    subsectionPath: null,
    bodyText: "ADU accessory dwelling unit district requirements text.",
    fetchedAt: "2026-07-30T00:00:00.000Z",
    sourceAdapter: "raw-pdf",
    sourceUrl: "https://example.invalid/bdc",
    contentHash: "sectionhash1",
    ...overrides,
  };
}

async function buildMixedEditionStorage(): Promise<InMemoryStorage> {
  const storage = new InMemoryStorage();
  await storage.writeAtom(corpusAtom());
  await storage.writeAtom(
    codeSection({
      entityId: `${CURRENT_EDITION}/14-02-003`,
      codeEditionId: CURRENT_EDITION,
      title: "District Requirements (current)",
    }),
  );
  await storage.writeAtom(
    codeSection({
      entityId: `${SUPERSEDED_EDITION}/14-02-003`,
      codeEditionId: SUPERSEDED_EDITION,
      title: "District Requirements (superseded ADU B3 April 2025)",
    }),
  );
  return storage;
}

describe("HybridRetrieval.search — edition honesty (mixed-edition fixture)", () => {
  it("default: excludes the superseded-edition section, keeps the current one", async () => {
    const storage = await buildMixedEditionStorage();
    const retrieval = new HybridRetrieval(storage);
    const { results } = await retrieval.search({ q: "ADU", jurisdiction: JURISDICTION });

    const editionIds = results.map((r) => r.editionId);
    expect(editionIds).toContain(CURRENT_EDITION);
    expect(editionIds).not.toContain(SUPERSEDED_EDITION);

    const current = results.find((r) => r.editionId === CURRENT_EDITION);
    expect(current?.isCurrentEdition).toBe(true);
  });

  it("includeSuperseded:true: both editions returned, superseded row flagged isCurrentEdition:false", async () => {
    const storage = await buildMixedEditionStorage();
    const retrieval = new HybridRetrieval(storage);
    const { results } = await retrieval.search({
      q: "ADU",
      jurisdiction: JURISDICTION,
      includeSuperseded: true,
    });

    const editionIds = results.map((r) => r.editionId);
    expect(editionIds).toContain(CURRENT_EDITION);
    expect(editionIds).toContain(SUPERSEDED_EDITION);

    const superseded = results.find((r) => r.editionId === SUPERSEDED_EDITION);
    expect(superseded?.isCurrentEdition).toBe(false);
    const current = results.find((r) => r.editionId === CURRENT_EDITION);
    expect(current?.isCurrentEdition).toBe(true);
  });

  it("unresolvable edition status (no jurisdiction-corpus atom): fail-open, row NOT excluded, isCurrentEdition undefined", async () => {
    const storage = new InMemoryStorage();
    // No corpus atom written for this jurisdiction — currentEditionId cannot resolve.
    await storage.writeAtom(
      codeSection({
        entityId: "unknown_jurisdiction-edition/14-02-003",
        jurisdictionTenant: "unknown_jurisdiction",
        codeEditionId: "unknown_jurisdiction-edition",
      }),
    );
    const retrieval = new HybridRetrieval(storage);
    const { results } = await retrieval.search({
      q: "ADU",
      jurisdiction: "unknown_jurisdiction",
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.isCurrentEdition).toBeUndefined();
  });

  it("non-code-section rows (e.g. jurisdiction-corpus itself) are unaffected by edition filtering", async () => {
    const storage = await buildMixedEditionStorage();
    const retrieval = new HybridRetrieval(storage);
    const { results } = await retrieval.search({
      q: "Bastrop",
      jurisdiction: JURISDICTION,
      entityType: "jurisdiction-corpus",
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.editionId == null)).toBe(true);
  });
});
