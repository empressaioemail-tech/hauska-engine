/**
 * Curated query authoring — Stream 1D.
 *
 * Per Phase 0: LLM-generate from TOC; human-review first 20
 * jurisdictions; trust eval harness after. Bastrop UDC + Grand County
 * IRC are reviewer-zero (Sylvia / Jaime) curated, gold-standard.
 *
 * This module ships:
 *   - the query schema (re-exported from eval/)
 *   - an LLM-generation hook (provider-agnostic; the operator wires
 *     the actual Claude call at the CLI layer)
 *   - a review-state machine + persistence-port the CLI implements
 */

import type { CuratedQuery } from "../eval/index.js";

export type LlmTocLine = {
  sectionNumber: string;
  title: string;
};

/**
 * Provider-agnostic LLM hook signature. The ingest CLI binds this to
 * a Claude call at runtime; tests bind it to a deterministic stub.
 */
export type LlmQueryGenerator = (
  jurisdictionTenant: string,
  tocLines: ReadonlyArray<LlmTocLine>,
) => Promise<ReadonlyArray<Omit<CuratedQuery, "queryId" | "status" | "humanReviewedAt" | "humanReviewedBy" | "authorshipSource">>>;

export interface CuratedQueriesPort {
  list(jurisdictionTenant: string): Promise<ReadonlyArray<CuratedQuery>>;
  upsert(query: CuratedQuery): Promise<void>;
  setStatus(
    queryId: string,
    status: CuratedQuery["status"],
    reviewer?: string,
  ): Promise<void>;
}

export interface InMemoryCuratedQueriesPortOptions {
  initial?: ReadonlyArray<CuratedQuery>;
}

export class InMemoryCuratedQueriesPort implements CuratedQueriesPort {
  private readonly store = new Map<string, CuratedQuery>();

  constructor(opts: InMemoryCuratedQueriesPortOptions = {}) {
    for (const q of opts.initial ?? []) this.store.set(q.queryId, q);
  }

  async list(jurisdictionTenant: string): Promise<ReadonlyArray<CuratedQuery>> {
    return Array.from(this.store.values()).filter(
      (q) => q.jurisdictionTenant === jurisdictionTenant,
    );
  }

  async upsert(query: CuratedQuery): Promise<void> {
    this.store.set(query.queryId, query);
  }

  async setStatus(
    queryId: string,
    status: CuratedQuery["status"],
    reviewer?: string,
  ): Promise<void> {
    const current = this.store.get(queryId);
    if (!current) return;
    this.store.set(queryId, {
      ...current,
      status,
      humanReviewedBy: reviewer ?? current.humanReviewedBy,
      humanReviewedAt: reviewer ? new Date().toISOString() : current.humanReviewedAt,
    });
  }
}

export interface AuthorOptions {
  jurisdictionTenant: string;
  tocLines: ReadonlyArray<LlmTocLine>;
  llm: LlmQueryGenerator;
  port: CuratedQueriesPort;
  /** Reviewer-zero gates: Bastrop / Grand County require human review before approval. */
  requireHumanReview: boolean;
}

export interface AuthorResult {
  generated: number;
  upserted: number;
  awaitingReview: number;
}

export async function authorQueriesFromToc(
  options: AuthorOptions,
): Promise<AuthorResult> {
  const drafts = await options.llm(
    options.jurisdictionTenant,
    options.tocLines,
  );
  let upserted = 0;
  let awaitingReview = 0;
  let serial = Date.now();
  for (const draft of drafts) {
    serial += 1;
    const queryId = `${options.jurisdictionTenant}-${serial}`;
    const status: CuratedQuery["status"] = options.requireHumanReview
      ? "draft"
      : "approved";
    const record: CuratedQuery = {
      ...draft,
      queryId,
      authorshipSource: "llm-generated",
      humanReviewedBy: null,
      humanReviewedAt: null,
      status,
    };
    await options.port.upsert(record);
    upserted += 1;
    if (status === "draft") awaitingReview += 1;
  }
  return { generated: drafts.length, upserted, awaitingReview };
}
