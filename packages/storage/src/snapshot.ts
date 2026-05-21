/**
 * Corpus snapshot — a serializable point-in-time dump of a StoragePort's
 * full contents: atom instances, atom-link edges, and jurisdiction-status
 * rows.
 *
 * Built for the retrieval-api Cloud Run deploy (Lane E Phase E0). The
 * production retrieval-api is read-only and the v1 catalog is small
 * enough to hold in memory, so the service boots an `InMemoryStorage`
 * hydrated from a committed snapshot artifact rather than re-running the
 * live ingest pipeline on every cold start. The
 * `tools/migrate-legacy-codes build-corpus-snapshot` subcommand
 * regenerates the artifact by running the jurisdiction ingests plus
 * eval, so the snapshot stays a reproducible build output, not
 * hand-authored data.
 *
 * When the Postgres-backed StoragePort lands, the production service
 * swaps to it and the snapshot becomes a dev/test convenience; the
 * format is versioned so that swap is non-breaking.
 */

import type { AtomLink, CodeAtomInstance } from "@hauska-engine/atoms";

import type { JurisdictionStatusSnapshot } from "./port.js";

/** Format tag — bumped if the snapshot shape changes incompatibly. */
export const CORPUS_SNAPSHOT_FORMAT = "hauska-corpus-snapshot/1" as const;

export interface CorpusSnapshot {
  format: typeof CORPUS_SNAPSHOT_FORMAT;
  /** ISO-8601 timestamp the snapshot was generated. */
  generatedAt: string;
  /** Optional free-form provenance (which ingests fed the snapshot). */
  provenance?: ReadonlyArray<string>;
  atoms: ReadonlyArray<CodeAtomInstance>;
  links: ReadonlyArray<AtomLink>;
  jurisdictionStatus: ReadonlyArray<JurisdictionStatusSnapshot>;
}

/**
 * Structural guard for a parsed snapshot file. Validates the format tag
 * and the three collections; deliberately shallow (the atom shapes are
 * the atom contract's concern, validated downstream at write time).
 */
export function isCorpusSnapshot(value: unknown): value is CorpusSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.format === CORPUS_SNAPSHOT_FORMAT &&
    typeof v.generatedAt === "string" &&
    Array.isArray(v.atoms) &&
    Array.isArray(v.links) &&
    Array.isArray(v.jurisdictionStatus)
  );
}
