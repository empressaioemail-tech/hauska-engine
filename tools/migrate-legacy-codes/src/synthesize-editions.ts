/**
 * Synthesize CodeEditionAtomInstance + JurisdictionCorpusAtomInstance
 * from the transformed section atoms.
 *
 * One edition per (jurisdictionTenant, codeEditionId).
 * One jurisdiction-corpus per jurisdictionTenant.
 *
 * Composition edges (jurisdiction-corpus contains edition; edition
 * contains sections) are emitted in parallel so the storage layer
 * gets a coherent atom-link set.
 */

import { createHash } from "node:crypto";

import type {
  AtomLink,
  CodeEditionAtomInstance,
  CodeSectionAtomInstance,
  JurisdictionCorpusAtomInstance,
} from "@hauska-engine/atoms";

function hashContent(...parts: ReadonlyArray<string>): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part, "utf8");
  return hash.digest("hex");
}

/**
 * Parse a legacy edition string into a best-effort ISO date.
 *   "IRC 2021"                        -> 2021-01-01
 *   "Land Use Code (rev. 3/21)"       -> 2021-03-01
 *   "Code of Ordinances (current...)" -> earliestFetchedAt fallback
 */
function inferEffectiveFrom(
  editionLabel: string,
  earliestFetchedAt: string,
): string {
  const yearMatch = editionLabel.match(/\b(19|20)\d{2}\b/);
  const slashMatch = editionLabel.match(/\b(\d{1,2})\/(\d{2,4})\b/);
  if (slashMatch) {
    const month = Math.max(1, Math.min(12, Number(slashMatch[1])));
    const yearRaw = Number(slashMatch[2]);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    return new Date(Date.UTC(year, month - 1, 1)).toISOString();
  }
  if (yearMatch) {
    const year = Number(yearMatch[0]);
    return new Date(Date.UTC(year, 0, 1)).toISOString();
  }
  return earliestFetchedAt;
}

export interface SynthesizeInput {
  jurisdictionDisplayNames: Record<string, string>;
  sections: ReadonlyArray<CodeSectionAtomInstance>;
  /**
   * Optional grouping label per (jurisdictionTenant, codeEditionId).
   * Migrated rows already carry the codeEditionId derived from
   * (jurisdiction, codeBook, edition); we surface a human label here
   * for the edition atom's editionLabel field.
   */
  editionLabels: Map<string, string>;
}

export interface SynthesizeOutput {
  editions: ReadonlyArray<CodeEditionAtomInstance>;
  corpora: ReadonlyArray<JurisdictionCorpusAtomInstance>;
  compositionLinks: ReadonlyArray<AtomLink>;
}

export function synthesizeEditionsAndCorpora(
  input: SynthesizeInput,
): SynthesizeOutput {
  // Group sections by (jurisdictionTenant, codeEditionId).
  const byEdition = new Map<
    string,
    {
      jurisdictionTenant: string;
      codeEditionId: string;
      sectionIds: string[];
      earliestFetchedAt: string;
      latestFetchedAt: string;
      sourceAdapter: string;
      sourceUrl: string;
    }
  >();

  for (const section of input.sections) {
    const key = `${section.jurisdictionTenant}::${section.codeEditionId}`;
    const existing = byEdition.get(key);
    if (!existing) {
      byEdition.set(key, {
        jurisdictionTenant: section.jurisdictionTenant,
        codeEditionId: section.codeEditionId,
        sectionIds: [section.entityId],
        earliestFetchedAt: section.fetchedAt,
        latestFetchedAt: section.fetchedAt,
        sourceAdapter: section.sourceAdapter,
        sourceUrl: section.sourceUrl,
      });
      continue;
    }
    existing.sectionIds.push(section.entityId);
    if (section.fetchedAt < existing.earliestFetchedAt) {
      existing.earliestFetchedAt = section.fetchedAt;
    }
    if (section.fetchedAt > existing.latestFetchedAt) {
      existing.latestFetchedAt = section.fetchedAt;
    }
  }

  const editions: CodeEditionAtomInstance[] = [];
  const compositionLinks: AtomLink[] = [];

  for (const e of byEdition.values()) {
    const editionLabel =
      input.editionLabels.get(`${e.jurisdictionTenant}::${e.codeEditionId}`) ??
      e.codeEditionId;
    const effectiveFrom = inferEffectiveFrom(
      editionLabel,
      e.earliestFetchedAt,
    );
    const editionInstance: CodeEditionAtomInstance = {
      entityType: "code-edition",
      entityId: e.codeEditionId,
      jurisdictionTenant: e.jurisdictionTenant,
      editionLabel,
      effectiveFrom,
      effectiveTo: null,
      sectionIds: e.sectionIds,
      amendmentIds: [],
      fetchedAt: e.latestFetchedAt,
      sourceAdapter: e.sourceAdapter,
      sourceUrl: e.sourceUrl,
      contentHash: hashContent(
        "code-edition",
        e.codeEditionId,
        editionLabel,
        ...e.sectionIds,
      ),
    };
    editions.push(editionInstance);
    for (const sectionId of e.sectionIds) {
      compositionLinks.push({
        fromEntityType: "code-edition",
        fromEntityId: e.codeEditionId,
        toEntityType: "code-section",
        toEntityId: sectionId,
        linkType: "contains",
      });
    }
  }

  // Group editions by jurisdictionTenant for the corpus rollup.
  const byJurisdiction = new Map<
    string,
    {
      jurisdictionTenant: string;
      editionIds: string[];
      latestFetchedAt: string;
      sourceAdapter: string;
      sourceUrl: string;
    }
  >();
  for (const edition of editions) {
    const existing = byJurisdiction.get(edition.jurisdictionTenant);
    if (!existing) {
      byJurisdiction.set(edition.jurisdictionTenant, {
        jurisdictionTenant: edition.jurisdictionTenant,
        editionIds: [edition.entityId],
        latestFetchedAt: edition.fetchedAt,
        sourceAdapter: edition.sourceAdapter,
        sourceUrl: edition.sourceUrl,
      });
      continue;
    }
    existing.editionIds.push(edition.entityId);
    if (edition.fetchedAt > existing.latestFetchedAt) {
      existing.latestFetchedAt = edition.fetchedAt;
      existing.sourceAdapter = edition.sourceAdapter;
      existing.sourceUrl = edition.sourceUrl;
    }
  }

  const corpora: JurisdictionCorpusAtomInstance[] = [];
  for (const c of byJurisdiction.values()) {
    const jurisdictionName =
      input.jurisdictionDisplayNames[c.jurisdictionTenant] ??
      c.jurisdictionTenant;
    const inst: JurisdictionCorpusAtomInstance = {
      entityType: "jurisdiction-corpus",
      entityId: c.jurisdictionTenant,
      jurisdictionTenant: c.jurisdictionTenant,
      jurisdictionName,
      adoptedEditionIds: c.editionIds,
      // Pick the lexicographically-latest edition entityId as "current"
      // when multiple editions coexist — a deterministic policy is
      // enough for v1; the canonical current-edition signal lives in
      // the legacy jurisdictions.ts which we don't preserve.
      currentEditionId: c.editionIds[c.editionIds.length - 1] ?? null,
      coverageQualityBar: "not-evaluated",
      lastRefreshedAt: c.latestFetchedAt,
      fetchedAt: c.latestFetchedAt,
      sourceAdapter: c.sourceAdapter,
      sourceUrl: c.sourceUrl,
      contentHash: hashContent(
        "jurisdiction-corpus",
        c.jurisdictionTenant,
        jurisdictionName,
        ...c.editionIds,
      ),
    };
    corpora.push(inst);
    for (const editionId of c.editionIds) {
      compositionLinks.push({
        fromEntityType: "jurisdiction-corpus",
        fromEntityId: c.jurisdictionTenant,
        toEntityType: "code-edition",
        toEntityId: editionId,
        linkType: "contains",
      });
    }
  }

  return { editions, corpora, compositionLinks };
}
