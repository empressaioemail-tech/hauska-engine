/**
 * Storage port — the abstract surface every storage back-end satisfies.
 *
 * The Postgres + IPFS implementation lives in `./pg-storage.ts` (lands
 * with the storage migration sprint); the `./in-memory-storage.ts`
 * implementation supports tests and the retrieval-api dev mode.
 *
 * Reads + writes are framed in atom-DID + atom-link terms. The port
 * does NOT expose Postgres or IPFS primitives directly — consumers
 * never know which back-end is wired underneath.
 */

import type { AtomLink } from "@hauska-engine/atoms";

import type {
  CodeAtomInstance,
  CodeAtomEntityType,
} from "@hauska-engine/atoms";

export interface AtomQuery {
  q?: string;
  jurisdiction?: string;
  entityType?: CodeAtomEntityType;
  limit?: number;
}

export interface AtomSearchResult {
  atomDid: string;
  entityType: CodeAtomEntityType;
  entityId: string;
  jurisdictionTenant: string;
  sectionNumber: string | null;
  /** Prose snippet from the atom's bodyText/term/definition. */
  snippet: string;
  score: number;
}

export interface JurisdictionStatusSnapshot {
  jurisdictionTenant: string;
  jurisdictionName: string;
  currentEditionDid: string | null;
  qualityBar:
    | "not-evaluated"
    | "failing"
    | "passing"
    | "passing-recalibrated";
  top3Score: number | null;
  sectionNumScore: number | null;
  crossRefScore: number | null;
  atomCount: number;
  lastRefreshedAt: string | null;
  driftStatus: "clean" | "amendments-pending" | "stale";
}

export interface StoragePort {
  /** Atomic write: pin to IPFS, index in Postgres, emit event. */
  writeAtom(instance: CodeAtomInstance): Promise<{ atomDid: string; cid: string }>;

  /** Batch write — atomization output. */
  writeAtoms(
    instances: ReadonlyArray<CodeAtomInstance>,
  ): Promise<ReadonlyArray<{ atomDid: string; cid: string }>>;

  /** Add atom-link edges. Idempotent on (from, to, link_type). */
  writeAtomLinks(links: ReadonlyArray<AtomLink>): Promise<void>;

  /** Read by entityType + entityId. */
  getAtom<T extends CodeAtomEntityType>(
    entityType: T,
    entityId: string,
  ): Promise<Extract<CodeAtomInstance, { entityType: T }> | null>;

  /** Read by DID. */
  getAtomByDid(atomDid: string): Promise<CodeAtomInstance | null>;

  /** Hybrid search (structural + vector). */
  search(query: AtomQuery): Promise<ReadonlyArray<AtomSearchResult>>;

  /**
   * Exact section-number lookup. Returns every section atom in the
   * jurisdiction whose `sectionNumber` matches `sectionNumber` verbatim.
   * Used by the eval-harness coverage test where token-based fuzzy
   * search introduces ties that displace the exact-section-number
   * match from top-K.
   */
  getSectionsBySectionNumber(
    jurisdictionTenant: string,
    sectionNumber: string,
  ): Promise<ReadonlyArray<Extract<CodeAtomInstance, { entityType: "code-section" }>>>;

  /** Graph traversal: outbound edges from an atom by link type. */
  traverse(
    fromAtomDid: string,
    linkType?: AtomLink["linkType"],
  ): Promise<ReadonlyArray<AtomLink & { toAtom: CodeAtomInstance | null }>>;

  /** Per-jurisdiction status snapshot for the coverage dashboard + MCP list_jurisdictions tool. */
  listJurisdictionStatus(filter?: {
    qualityBarOnly?: boolean;
  }): Promise<ReadonlyArray<JurisdictionStatusSnapshot>>;

  upsertJurisdictionStatus(snapshot: JurisdictionStatusSnapshot): Promise<void>;
}
