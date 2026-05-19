/**
 * Eval harness — Stream 1D.
 *
 * Per 49 §B.4 + 51 §Stream 1D. A jurisdiction is "loaded" only when
 * the harness passes the quality bar:
 *
 *   - 90% top-3 retrieval on curated queries
 *   - 100% section-number retrievability
 *   - 95% cross-reference resolution
 *
 * Recalibration after batch-10 per Phase 0 close.
 */

import type { AtomLink, CodeAtomInstance } from "@hauska-engine/atoms";
import { buildAtomDid } from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

export interface CuratedQuery {
  queryId: string;
  jurisdictionTenant: string;
  queryText: string;
  expectedAtomDid: string;
  queryType: "retrieval" | "coverage" | "cross-ref";
  authorshipSource: "llm-generated" | "human-curated" | "reviewer-zero";
  humanReviewedBy: string | null;
  humanReviewedAt: string | null;
  status: "draft" | "approved" | "rejected";
}

export interface QualityBarThresholds {
  top3RetrievalMin: number;
  sectionNumRetrievabilityMin: number;
  crossRefResolutionMin: number;
}

export const DEFAULT_QUALITY_BAR: QualityBarThresholds = {
  top3RetrievalMin: 0.9,
  sectionNumRetrievabilityMin: 1.0,
  crossRefResolutionMin: 0.95,
};

export interface QueryRunFailure {
  queryId: string;
  queryText: string;
  expectedAtomDid: string;
  actualTopResults: ReadonlyArray<string>;
  reason: string;
}

export interface EvalScores {
  top3Score: number;
  sectionNumScore: number;
  crossRefScore: number;
}

export interface EvalReport {
  jurisdictionTenant: string;
  evaluatedAt: string;
  passed: boolean;
  scores: EvalScores;
  thresholds: QualityBarThresholds;
  failures: ReadonlyArray<QueryRunFailure>;
  queriesEvaluated: number;
  sectionsSampled: number;
  crossRefsSampled: number;
}

export interface EvaluateOptions {
  storage: StoragePort;
  jurisdictionTenant: string;
  queries: ReadonlyArray<CuratedQuery>;
  sectionSampleSize?: number;
  crossRefSampleSize?: number;
  thresholds?: QualityBarThresholds;
}

/**
 * Top-3 retrieval test. For each query, retrieve top-3 and check the
 * expected atom DID is present.
 */
async function runRetrievalTest(
  storage: StoragePort,
  jurisdictionTenant: string,
  queries: ReadonlyArray<CuratedQuery>,
): Promise<{ score: number; failures: QueryRunFailure[] }> {
  if (queries.length === 0) return { score: 1, failures: [] };
  let passed = 0;
  const failures: QueryRunFailure[] = [];
  for (const q of queries) {
    if (q.queryType !== "retrieval") continue;
    const results = await storage.search({
      q: q.queryText,
      jurisdiction: jurisdictionTenant,
      limit: 3,
    });
    const top3Dids = results.map((r) => r.atomDid);
    if (top3Dids.includes(q.expectedAtomDid)) {
      passed++;
    } else {
      failures.push({
        queryId: q.queryId,
        queryText: q.queryText,
        expectedAtomDid: q.expectedAtomDid,
        actualTopResults: top3Dids,
        reason: "expected atom not in top-3",
      });
    }
  }
  const total = queries.filter((q) => q.queryType === "retrieval").length;
  return { score: total > 0 ? passed / total : 1, failures };
}

/**
 * Section-number retrievability test. Sample N section atoms; check
 * each is retrievable by its exact section number via the storage's
 * `getSectionsBySectionNumber` lookup (per ADR-010 §3 the Postgres
 * index is the canonical structural lookup; fuzzy search is the
 * different code path).
 */
async function runCoverageTest(
  storage: StoragePort,
  jurisdictionTenant: string,
  sampleSize: number,
): Promise<{ score: number; sampled: number }> {
  const candidates = await storage.search({
    jurisdiction: jurisdictionTenant,
    entityType: "code-section",
    limit: sampleSize,
  });
  if (candidates.length === 0) return { score: 1, sampled: 0 };
  let retrievable = 0;
  for (const candidate of candidates) {
    if (!candidate.sectionNumber) continue;
    const hits = await storage.getSectionsBySectionNumber(
      jurisdictionTenant,
      candidate.sectionNumber,
    );
    if (hits.some((h) => buildAtomDid(h.entityType, h.entityId).raw === candidate.atomDid)) {
      retrievable++;
    }
  }
  return { score: retrievable / candidates.length, sampled: candidates.length };
}

/**
 * Cross-reference resolution test. Sample N cross-reference atoms;
 * check each `toSectionId` resolves to a real section atom.
 */
async function runCrossRefTest(
  storage: StoragePort,
  jurisdictionTenant: string,
  sampleSize: number,
): Promise<{ score: number; sampled: number }> {
  const xrefs = await storage.search({
    jurisdiction: jurisdictionTenant,
    entityType: "code-cross-reference",
    limit: sampleSize,
  });
  if (xrefs.length === 0) return { score: 1, sampled: 0 };
  let resolved = 0;
  for (const xref of xrefs) {
    const xrefAtom = await storage.getAtom("code-cross-reference", xref.entityId);
    if (!xrefAtom) continue;
    if (!xrefAtom.toSectionId) continue;
    const target = await storage.getAtom("code-section", xrefAtom.toSectionId);
    if (target) resolved++;
  }
  return { score: resolved / xrefs.length, sampled: xrefs.length };
}

export async function evaluate(options: EvaluateOptions): Promise<EvalReport> {
  const thresholds = options.thresholds ?? DEFAULT_QUALITY_BAR;
  const sectionSampleSize = options.sectionSampleSize ?? 100;
  const crossRefSampleSize = options.crossRefSampleSize ?? 100;

  const retrieval = await runRetrievalTest(
    options.storage,
    options.jurisdictionTenant,
    options.queries,
  );
  const coverage = await runCoverageTest(
    options.storage,
    options.jurisdictionTenant,
    sectionSampleSize,
  );
  const xref = await runCrossRefTest(
    options.storage,
    options.jurisdictionTenant,
    crossRefSampleSize,
  );

  const scores: EvalScores = {
    top3Score: retrieval.score,
    sectionNumScore: coverage.score,
    crossRefScore: xref.score,
  };
  const passed =
    scores.top3Score >= thresholds.top3RetrievalMin &&
    scores.sectionNumScore >= thresholds.sectionNumRetrievabilityMin &&
    scores.crossRefScore >= thresholds.crossRefResolutionMin;

  return {
    jurisdictionTenant: options.jurisdictionTenant,
    evaluatedAt: new Date().toISOString(),
    passed,
    scores,
    thresholds,
    failures: retrieval.failures,
    queriesEvaluated: options.queries.length,
    sectionsSampled: coverage.sampled,
    crossRefsSampled: xref.sampled,
  };
}

export function expectedAtomDidForSection(
  jurisdictionTenant: string,
  editionSlug: string,
  sectionNumber: string,
): string {
  const localId = `${jurisdictionTenant}/${editionSlug}/${sectionNumber}`;
  return buildAtomDid("code-section", localId).raw;
}
