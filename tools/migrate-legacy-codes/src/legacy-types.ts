/**
 * Type mirrors of the legacy-design-tools tables we read from.
 *
 * Schema source: legacy-design-tools/lib/db/src/schema/codeAtoms.ts and
 * codeAtomSources.ts. We do NOT depend on `@workspace/db` to avoid
 * dragging legacy's pnpm-workspace coupling into hauska-engine.
 */

export interface LegacyCodeAtomRow {
  id: string;
  source_id: string;
  jurisdiction_key: string;
  code_book: string;
  edition: string;
  section_number: string | null;
  section_title: string | null;
  parent_section: string | null;
  body: string;
  body_html: string | null;
  embedding: number[] | null;
  embedding_model: string | null;
  embedded_at: Date | null;
  content_hash: string;
  source_url: string;
  fetched_at: Date;
  metadata: Record<string, unknown> | null;
}

export interface LegacyCodeAtomSourceRow {
  id: string;
  source_name: string;
  label: string;
  source_type: string;
  license_type: string;
  base_url: string | null;
  notes: string | null;
  created_at: Date;
}

export interface CoveragePerBook {
  jurisdictionKey: string;
  codeBook: string;
  edition: string;
  sourceName: string;
  atomCount: number;
  withBody: number;
  withBodyHtml: number;
  withEmbedding: number;
  earliestFetchedAt: Date | null;
  latestFetchedAt: Date | null;
  sampleSectionNumbers: ReadonlyArray<string>;
}
