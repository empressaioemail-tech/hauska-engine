/**
 * Postgres index schema per ADR-010.
 *
 * Tables:
 *   - `atoms`            — atom-instance index
 *   - `atom_links`       — cross-reference + composition graph
 *   - `atom_embeddings`  — pgvector embeddings (one row per atom)
 *   - `ingest_jobs`      — pipeline job state machine (Stream 1A)
 *   - `curated_queries`  — eval-harness query set (Stream 1D)
 *   - `jurisdiction_status` — per-jurisdiction quality bar status
 *   - `cost_records`     — per-jurisdiction cost capture (commitment #3)
 *
 * Concrete migrations land alongside the storage port implementation;
 * this file defines the table shapes via drizzle-orm so retrieval +
 * pipeline runner consume the same source-of-truth.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * One row per atom-instance. `cid` is populated when the instance is
 * pinned to IPFS; until pinning lands the column can hold the
 * content-hash hex (the storage port maps it to CID).
 */
export const atoms = pgTable(
  "atoms",
  {
    atomDid: text("atom_did").notNull().primaryKey(),
    cid: text("cid").notNull(),
    contentHash: text("content_hash").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    jurisdictionTenant: text("jurisdiction_tenant").notNull(),
    /** For code-section: section number (indexed). */
    sectionNumber: text("section_number"),
    subsectionPath: text("subsection_path"),
    sourceAdapter: text("source_adapter").notNull(),
    sourceUrl: text("source_url").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    /** Full atom-instance body as JSON. IPFS holds the canonical copy. */
    body: jsonb("body").notNull(),
    /** Access policy per ADR-007 + 08 tier model. */
    accessPolicy: text("access_policy").notNull().default("public-free"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    entityTypeIdx: index("atoms_entity_type_idx").on(t.entityType),
    jurisdictionIdx: index("atoms_jurisdiction_idx").on(t.jurisdictionTenant),
    sectionNumberIdx: index("atoms_section_number_idx").on(
      t.jurisdictionTenant,
      t.sectionNumber,
    ),
    entityCompositeIdx: uniqueIndex("atoms_entity_composite_unique").on(
      t.entityType,
      t.entityId,
    ),
  }),
);

export const atomLinks = pgTable(
  "atom_links",
  {
    fromAtomDid: text("from_atom_did").notNull(),
    toAtomDid: text("to_atom_did").notNull(),
    linkType: text("link_type").notNull(),
    context: text("context"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.fromAtomDid, t.toAtomDid, t.linkType],
    }),
    fromIdx: index("atom_links_from_idx").on(t.fromAtomDid),
    toIdx: index("atom_links_to_idx").on(t.toAtomDid),
    linkTypeIdx: index("atom_links_type_idx").on(t.linkType),
  }),
);

/**
 * Vector embeddings — one row per atom. `embedding` is `vector(1024)`
 * when pgvector is enabled; drizzle-orm-pgvector landing point. Stored
 * as `real[]` until pgvector migration lands.
 */
export const atomEmbeddings = pgTable(
  "atom_embeddings",
  {
    atomDid: text("atom_did").notNull().primaryKey(),
    /** Embedding model identifier (e.g. `"voyage-3-large"`). */
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    /** Real array placeholder; swap to `vector(d)` post pgvector migration. */
    embedding: jsonb("embedding").notNull(),
    embeddedAt: timestamp("embedded_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
);

/**
 * Pipeline job state machine per Stream 1A.
 * State machine: queued -> fetching -> extracted -> atomized -> indexed -> eval-running -> loaded / failed
 */
export const ingestJobs = pgTable(
  "ingest_jobs",
  {
    jobId: text("job_id").notNull().primaryKey(),
    adapter: text("adapter").notNull(),
    sourceId: text("source_id").notNull(),
    jurisdictionTenant: text("jurisdiction_tenant").notNull(),
    editionLabel: text("edition_label").notNull(),
    sourceUrl: text("source_url").notNull(),
    state: text("state").notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    error: text("error"),
    queuedAt: timestamp("queued_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** Free-form per-state telemetry (block counts, atom counts, eval scores, ...). */
    telemetry: jsonb("telemetry").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    stateIdx: index("ingest_jobs_state_idx").on(t.state),
    jurisdictionIdx: index("ingest_jobs_jurisdiction_idx").on(
      t.jurisdictionTenant,
    ),
  }),
);

/**
 * Curated query set per Stream 1D. One row per (jurisdiction, query_text).
 * Used by the eval harness for top-3 retrieval scoring.
 */
export const curatedQueries = pgTable(
  "curated_queries",
  {
    queryId: text("query_id").notNull().primaryKey(),
    jurisdictionTenant: text("jurisdiction_tenant").notNull(),
    queryText: text("query_text").notNull(),
    /** DID of the atom the query is expected to retrieve in top-3. */
    expectedAtomDid: text("expected_atom_did").notNull(),
    queryType: text("query_type").notNull().default("retrieval"),
    /** LLM-generated, human-reviewed, or curated by reviewer-zero (Sylvia/Jaime for Bastrop). */
    authorshipSource: text("authorship_source").notNull(),
    humanReviewedBy: text("human_reviewed_by"),
    humanReviewedAt: timestamp("human_reviewed_at", { withTimezone: true }),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    jurisdictionIdx: index("curated_queries_jurisdiction_idx").on(
      t.jurisdictionTenant,
    ),
    statusIdx: index("curated_queries_status_idx").on(t.status),
  }),
);

/**
 * Per-jurisdiction quality bar status. Drives the
 * `jurisdiction-corpus.coverageQualityBar` flag and the public MCP
 * `list_jurisdictions` surface (loaded + quality-passing only).
 */
export const jurisdictionStatus = pgTable("jurisdiction_status", {
  jurisdictionTenant: text("jurisdiction_tenant").notNull().primaryKey(),
  jurisdictionName: text("jurisdiction_name").notNull(),
  currentEditionDid: text("current_edition_did"),
  qualityBar: text("quality_bar").notNull().default("not-evaluated"),
  top3Score: real("top3_score"),
  sectionNumScore: real("section_num_score"),
  crossRefScore: real("cross_ref_score"),
  atomCount: integer("atom_count").notNull().default(0),
  lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
  driftStatus: text("drift_status").notNull().default("clean"),
});

/**
 * Per-jurisdiction cost capture per commitment #3.
 * Hard-kill checkpoint at 3 counties enforces $200 + 1hr target.
 */
export const costRecords = pgTable(
  "cost_records",
  {
    recordId: text("record_id").notNull().primaryKey(),
    jurisdictionTenant: text("jurisdiction_tenant").notNull(),
    /** ISO date of the ingest run. */
    runDate: text("run_date").notNull(),
    /** Cents spent on LLM tokens. */
    llmTokensCostCents: integer("llm_tokens_cost_cents").notNull().default(0),
    ocrCostCents: integer("ocr_cost_cents").notNull().default(0),
    embeddingCostCents: integer("embedding_cost_cents").notNull().default(0),
    infrastructureCostCents: integer("infrastructure_cost_cents")
      .notNull()
      .default(0),
    humanReviewMinutes: integer("human_review_minutes").notNull().default(0),
    notes: text("notes"),
    flaggedOverTarget: boolean("flagged_over_target").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    jurisdictionIdx: index("cost_records_jurisdiction_idx").on(
      t.jurisdictionTenant,
    ),
  }),
);
