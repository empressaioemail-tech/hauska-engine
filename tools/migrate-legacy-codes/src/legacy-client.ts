/**
 * Read-only client against the legacy-design-tools Postgres database.
 *
 * Uses postgres-js directly (no Drizzle) so the migration tool does
 * not depend on `@workspace/db`. The legacy schema is small enough
 * (two tables, both read-only here) that raw SQL is the simplest
 * surface. The tool deliberately opens a separate connection so
 * read concurrency with the production legacy app is bounded.
 */

import postgres from "postgres";

import type {
  CoveragePerBook,
  LegacyCodeAtomRow,
  LegacyCodeAtomSourceRow,
} from "./legacy-types.js";

export interface LegacyClientOptions {
  databaseUrl: string;
  /** Bound concurrent queries against legacy DB. */
  maxConnections?: number;
}

export class LegacyClient {
  private readonly sql: postgres.Sql;

  constructor(options: LegacyClientOptions) {
    this.sql = postgres(options.databaseUrl, {
      max: options.maxConnections ?? 2,
      onnotice: () => {},
      idle_timeout: 20,
      max_lifetime: 60 * 5,
      ssl: options.databaseUrl.includes("sslmode=require") ? "require" : false,
    });
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async listSources(): Promise<ReadonlyArray<LegacyCodeAtomSourceRow>> {
    const rows = await this.sql<LegacyCodeAtomSourceRow[]>`
      SELECT id, source_name, label, source_type, license_type,
             base_url, notes, created_at
      FROM code_atom_sources
      ORDER BY source_name
    `;
    return rows;
  }

  async coverageReport(): Promise<ReadonlyArray<CoveragePerBook>> {
    const rows = await this.sql<
      Array<{
        jurisdiction_key: string;
        code_book: string;
        edition: string;
        source_name: string;
        atom_count: string;
        with_body: string;
        with_body_html: string;
        with_embedding: string;
        earliest_fetched_at: Date | null;
        latest_fetched_at: Date | null;
      }>
    >`
      SELECT
        a.jurisdiction_key,
        a.code_book,
        a.edition,
        s.source_name,
        COUNT(*)::text AS atom_count,
        SUM((LENGTH(a.body) > 0)::int)::text AS with_body,
        SUM((a.body_html IS NOT NULL)::int)::text AS with_body_html,
        SUM((a.embedding IS NOT NULL)::int)::text AS with_embedding,
        MIN(a.fetched_at) AS earliest_fetched_at,
        MAX(a.fetched_at) AS latest_fetched_at
      FROM code_atoms a
      JOIN code_atom_sources s ON s.id = a.source_id
      GROUP BY a.jurisdiction_key, a.code_book, a.edition, s.source_name
      ORDER BY a.jurisdiction_key, a.code_book
    `;

    const result: CoveragePerBook[] = [];
    for (const row of rows) {
      const sampleSectionRows = await this.sql<Array<{ section_number: string | null }>>`
        SELECT section_number
        FROM code_atoms
        WHERE jurisdiction_key = ${row.jurisdiction_key}
          AND code_book = ${row.code_book}
          AND section_number IS NOT NULL
        ORDER BY section_number
        LIMIT 25
      `;
      result.push({
        jurisdictionKey: row.jurisdiction_key,
        codeBook: row.code_book,
        edition: row.edition,
        sourceName: row.source_name,
        atomCount: Number(row.atom_count),
        withBody: Number(row.with_body),
        withBodyHtml: Number(row.with_body_html),
        withEmbedding: Number(row.with_embedding),
        earliestFetchedAt: row.earliest_fetched_at,
        latestFetchedAt: row.latest_fetched_at,
        sampleSectionNumbers: sampleSectionRows
          .map((r) => r.section_number ?? "")
          .filter((s): s is string => s.length > 0),
      });
    }
    return result;
  }

  async readAtoms(filter?: {
    jurisdictionKey?: string;
    codeBook?: string;
  }): Promise<ReadonlyArray<LegacyCodeAtomRow>> {
    if (filter?.jurisdictionKey && filter?.codeBook) {
      const rows = await this.sql<LegacyCodeAtomRow[]>`
        SELECT id, source_id, jurisdiction_key, code_book, edition,
               section_number, section_title, parent_section,
               body, body_html, embedding, embedding_model, embedded_at,
               content_hash, source_url, fetched_at, metadata
        FROM code_atoms
        WHERE jurisdiction_key = ${filter.jurisdictionKey}
          AND code_book = ${filter.codeBook}
        ORDER BY section_number NULLS LAST, id
      `;
      return rows;
    }
    if (filter?.jurisdictionKey) {
      const rows = await this.sql<LegacyCodeAtomRow[]>`
        SELECT id, source_id, jurisdiction_key, code_book, edition,
               section_number, section_title, parent_section,
               body, body_html, embedding, embedding_model, embedded_at,
               content_hash, source_url, fetched_at, metadata
        FROM code_atoms
        WHERE jurisdiction_key = ${filter.jurisdictionKey}
        ORDER BY code_book, section_number NULLS LAST, id
      `;
      return rows;
    }
    const rows = await this.sql<LegacyCodeAtomRow[]>`
      SELECT id, source_id, jurisdiction_key, code_book, edition,
             section_number, section_title, parent_section,
             body, body_html, embedding, embedding_model, embedded_at,
             content_hash, source_url, fetched_at, metadata
      FROM code_atoms
      ORDER BY jurisdiction_key, code_book, section_number NULLS LAST, id
    `;
    return rows;
  }

  /**
   * Probe specifically for Bastrop UDC presence. Returns the section
   * numbers and titles of any section whose ref or title matches a
   * UDC indicator. Per the dispatch's Check 1, this answers whether
   * Path B alone covers Bastrop or whether Path C re-ingest is needed
   * for the UDC subset.
   */
  async probeBastropUdc(): Promise<{
    candidateSections: ReadonlyArray<{
      sectionNumber: string;
      sectionTitle: string;
      sourceUrl: string;
    }>;
    totalBastropAtoms: number;
    udcCandidateCount: number;
  }> {
    const total = await this.sql<Array<{ count: string }>>`
      SELECT COUNT(*)::text AS count
      FROM code_atoms
      WHERE jurisdiction_key = 'bastrop_tx'
    `;
    // UDC indicators per cc-agent-M's tightening pass:
    //  - Require a zoning-specific keyword in the SECTION TITLE
    //    (charter sections like "Effect of Charter on Existing Laws"
    //    no longer false-positive on a "14.x" section-number match
    //    because the title doesn't carry the keyword).
    //  - OR a section_number under the canonical UDC chapter range
    //    (Bastrop's UDC chapter is typically 14 / 150 — exclude
    //    sections whose title contains "charter" or "amendment" so
    //    Sec. 14.01 "Effect of Charter Amendments" doesn't slip in).
    const candidates = await this.sql<
      Array<{
        section_number: string | null;
        section_title: string | null;
        source_url: string;
      }>
    >`
      SELECT section_number, section_title, source_url
      FROM code_atoms
      WHERE jurisdiction_key = 'bastrop_tx'
        AND (
          section_title ~* 'unified development|use district|zoning district|setback|subdivision standard|lot dimension|land development|zoning regulation|district standard'
          OR (
            section_number ~* '^14\.|^150\.|^UDC'
            AND section_title !~* 'charter|amendment|preamble|adoption'
          )
        )
      ORDER BY section_number NULLS LAST
      LIMIT 50
    `;
    return {
      candidateSections: candidates.map((r) => ({
        sectionNumber: r.section_number ?? "",
        sectionTitle: r.section_title ?? "",
        sourceUrl: r.source_url,
      })),
      totalBastropAtoms: Number(total[0]?.count ?? "0"),
      udcCandidateCount: candidates.length,
    };
  }
}
