/**
 * LayeredStorage — Postgres-first reads merged with a snapshot back-end.
 *
 * retrieval-api boots with a committed corpus snapshot (InMemoryStorage) plus
 * an optional Postgres overlay (PgStorage). Postgres wins on DID collisions;
 * search merges and dedupes by atomDid; countAtoms preserves the snapshot base
 * and adds Postgres-only atoms so /healthz corpus>0 stays true.
 */

import { buildAtomDid, type AtomLink, type CodeAtomInstance } from "@hauska-engine/atoms";

import type {
  AtomQuery,
  AtomSearchResult,
  JurisdictionStatusSnapshot,
  StoragePort,
} from "./port.js";
import { rankSearchResults } from "./search-scoring.js";

export interface LayeredStorageOptions {
  /** Durable overlay (typically PgStorage). Checked first on reads. */
  primary: StoragePort;
  /** Snapshot corpus (typically InMemoryStorage from snapshot.json). */
  snapshot: StoragePort;
}

export class LayeredStorage implements StoragePort {
  private readonly primary: StoragePort;
  private readonly snapshot: StoragePort;

  constructor(options: LayeredStorageOptions) {
    this.primary = options.primary;
    this.snapshot = options.snapshot;
  }

  writeAtom(instance: CodeAtomInstance) {
    return this.primary.writeAtom(instance);
  }

  writeAtoms(instances: ReadonlyArray<CodeAtomInstance>) {
    return this.primary.writeAtoms(instances);
  }

  writeAtomLinks(links: ReadonlyArray<AtomLink>) {
    return this.primary.writeAtomLinks(links);
  }

  async getAtom<T extends CodeAtomInstance["entityType"]>(
    entityType: T,
    entityId: string,
  ): Promise<Extract<CodeAtomInstance, { entityType: T }> | null> {
    const primaryHit = await this.primary.getAtom(entityType, entityId);
    if (primaryHit) return primaryHit;
    return this.snapshot.getAtom(entityType, entityId);
  }

  async getAtomByDid(atomDid: string): Promise<CodeAtomInstance | null> {
    const primaryHit = await this.primary.getAtomByDid(atomDid);
    if (primaryHit) return primaryHit;
    return this.snapshot.getAtomByDid(atomDid);
  }

  async search(query: AtomQuery): Promise<ReadonlyArray<AtomSearchResult>> {
    const [primaryResults, snapshotResults] = await Promise.all([
      this.primary.search(query),
      this.snapshot.search(query),
    ]);
    const merged = new Map<string, AtomSearchResult>();
    for (const result of snapshotResults) {
      merged.set(result.atomDid, result);
    }
    for (const result of primaryResults) {
      merged.set(result.atomDid, result);
    }
    return rankSearchResults([...merged.values()], query.limit ?? 25);
  }

  async getSectionsBySectionNumber(
    jurisdictionTenant: string,
    sectionNumber: string,
  ) {
    const primaryHits = await this.primary.getSectionsBySectionNumber(
      jurisdictionTenant,
      sectionNumber,
    );
    const snapshotHits = await this.snapshot.getSectionsBySectionNumber(
      jurisdictionTenant,
      sectionNumber,
    );
    const merged = new Map<string, Extract<CodeAtomInstance, { entityType: "code-section" }>>();
    for (const hit of snapshotHits) {
      merged.set(buildAtomDid(hit.entityType, hit.entityId).raw, hit);
    }
    for (const hit of primaryHits) {
      merged.set(buildAtomDid(hit.entityType, hit.entityId).raw, hit);
    }
    return [...merged.values()];
  }

  async getJurisdictionalOverlays(
    jurisdictionTenant: string,
    baseSectionId: string,
  ) {
    const [primaryHits, snapshotHits] = await Promise.all([
      this.primary.getJurisdictionalOverlays(jurisdictionTenant, baseSectionId),
      this.snapshot.getJurisdictionalOverlays(jurisdictionTenant, baseSectionId),
    ]);
    const merged = new Map<string, (typeof primaryHits)[number]>();
    for (const hit of snapshotHits) {
      merged.set(buildAtomDid(hit.entityType, hit.entityId).raw, hit);
    }
    for (const hit of primaryHits) {
      merged.set(buildAtomDid(hit.entityType, hit.entityId).raw, hit);
    }
    return [...merged.values()].sort((a, b) =>
      a.effectiveDate.localeCompare(b.effectiveDate),
    );
  }

  async traverse(fromAtomDid: string, linkType?: AtomLink["linkType"]) {
    const primaryHits = await this.primary.traverse(fromAtomDid, linkType);
    if (primaryHits.length > 0) return primaryHits;
    return this.snapshot.traverse(fromAtomDid, linkType);
  }

  async traverseInbound(toAtomDid: string, linkType?: AtomLink["linkType"]) {
    const primaryHits = await this.primary.traverseInbound(toAtomDid, linkType);
    if (primaryHits.length > 0) return primaryHits;
    return this.snapshot.traverseInbound(toAtomDid, linkType);
  }

  async listJurisdictionStatus(filter?: {
    qualityBarOnly?: boolean;
    accessPolicies?: ReadonlyArray<
      import("@hauska-engine/atoms").AccessPolicy
    >;
  }): Promise<ReadonlyArray<JurisdictionStatusSnapshot>> {
    const snapshotRows = await this.snapshot.listJurisdictionStatus(filter);
    const primaryRows = await this.primary.listJurisdictionStatus(filter);
    const merged = new Map<string, JurisdictionStatusSnapshot>();
    for (const row of snapshotRows) {
      merged.set(row.jurisdictionTenant, row);
    }
    for (const row of primaryRows) {
      merged.set(row.jurisdictionTenant, row);
    }
    return [...merged.values()];
  }

  upsertJurisdictionStatus(snapshot: JurisdictionStatusSnapshot) {
    return this.primary.upsertJurisdictionStatus(snapshot);
  }

  async countAtoms(): Promise<number> {
    const snapshotCount = await this.snapshot.countAtoms();
    const primaryCount = await this.primary.countAtoms();
    if (primaryCount === 0) return snapshotCount;

    if (
      "listAtomDids" in this.primary &&
      typeof this.primary.listAtomDids === "function"
    ) {
      const primaryDids = await (
        this.primary as StoragePort & {
          listAtomDids: () => Promise<ReadonlyArray<string>>;
        }
      ).listAtomDids();
      let extras = 0;
      for (const did of primaryDids) {
        const inSnapshot = await this.snapshot.getAtomByDid(did);
        if (!inSnapshot) extras++;
      }
      return snapshotCount + extras;
    }

    return Math.max(snapshotCount, snapshotCount + primaryCount);
  }
}
