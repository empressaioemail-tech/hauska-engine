import { createHash } from "node:crypto";

/**
 * One row in the Neon warmup JSONL export — cortex-api `code_atoms` shape
 * (snake_case) without DB-generated ids.
 */
export interface NeonWarmupJsonlRow {
  jurisdiction_key: string;
  code_book: string;
  edition: string;
  section_number: string;
  section_title: string | null;
  parent_section: string | null;
  body: string;
  body_html: string | null;
  source_url: string;
  content_hash: string;
  fetched_at: string;
  metadata: Record<string, unknown> | null;
}

/** Stable book id for substrate-exported atoms (one book per jurisdiction). */
export const SUBSTRATE_CODE_BOOK = "SUBSTRATE" as const;

const CONTENT_HASH_JOINER = "\u0001";

/** Matches legacy-design-tools `lib/codes/src/contentHash.ts` + orchestrator. */
export function ldtContentHash(parts: string[]): string {
  return createHash("sha256")
    .update(parts.join(CONTENT_HASH_JOINER))
    .digest("hex");
}

export function substrateSourceName(jurisdictionKey: string): string {
  return `${jurisdictionKey}_substrate`;
}

export function parseJsonlLine(line: string): NeonWarmupJsonlRow {
  const row = JSON.parse(line) as NeonWarmupJsonlRow;
  if (!row.jurisdiction_key || !row.section_number || !row.body) {
    throw new Error("invalid JSONL row: missing jurisdiction_key, section_number, or body");
  }
  if (!row.content_hash) {
    throw new Error("invalid JSONL row: missing content_hash");
  }
  return row;
}
