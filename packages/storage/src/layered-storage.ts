/**
 * LayeredStorage — Postgres-first reads merged with a snapshot back-end.
 *
 * retrieval-api boots with a committed corpus snapshot (InMemoryStorage) plus
 * an optional Postgres overlay (PgStorage). Postgres wins on DID collisions;
 * search merges and dedupes by atomDid; countAtoms preserves the snapshot base
 * and adds Postgres-only atoms so /healthz corpus>0 stays true.
 */

import { buildAtomDid, type AtomLink, type CodeAtomInstance, type PropertyAtomInstance, type StoredAtomInstance } from "@hauska-engine/atoms";

import type {
  AtomQuery,
  AtomSearchResult,
  GraphNodeListQuery,
  GraphNodeListResult,
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

  writePropertyAtom(instance: PropertyAtomInstance) {
    return this.primary.writePropertyAtom(instance);
  }

  writePropertyAtomsBatch(
    instances: ReadonlyArray<PropertyAtomInstance>,
    lease?: import("./atoms-writer-lease.js").HeldLease,
  ) {
    return this.primary.writePropertyAtomsBatch(instances, lease);
  }

  async listPropertyAtomsByParcelNodeId(
    parcelNodeId: string,
  ): Promise<ReadonlyArray<PropertyAtomInstance>> {
    const primary = await this.primary.listPropertyAtomsByParcelNodeId(
      parcelNodeId,
    );
    if (primary.length > 0) return primary;
    return this.snapshot.listPropertyAtomsByParcelNodeId(parcelNodeId);
  }

  writeRoadAtom(
    instance: import("@hauska-engine/atoms").RoadNodeAtomInstance,
  ) {
    return this.primary.writeRoadAtom(instance);
  }

  writeRoadAtomsBatch(
    instances: ReadonlyArray<import("@hauska-engine/atoms").RoadNodeAtomInstance>,
    opts?: import("./road-ingest-supersede.js").WriteRoadAtomsBatchOptions,
  ) {
    return this.primary.writeRoadAtomsBatch(instances, opts);
  }

  async listRoadAtomsByRoadNodeId(
    roadNodeId: string,
  ): Promise<ReadonlyArray<import("@hauska-engine/atoms").RoadNodeAtomInstance>> {
    const primary = await this.primary.listRoadAtomsByRoadNodeId(roadNodeId);
    if (primary.length > 0) return primary;
    return this.snapshot.listRoadAtomsByRoadNodeId(roadNodeId);
  }

  async listRoadAtomsNearBbox(
    countyFips: string,
    bbox: {
      westLng: number;
      southLat: number;
      eastLng: number;
      northLat: number;
    },
    opts?: { limit?: number },
  ): Promise<ReadonlyArray<import("@hauska-engine/atoms").RoadNodeAtomInstance>> {
    const primaryFn = this.primary.listRoadAtomsNearBbox?.bind(this.primary);
    const snapshotFn = this.snapshot.listRoadAtomsNearBbox?.bind(this.snapshot);
    if (primaryFn) {
      const primary = await primaryFn(countyFips, bbox, opts);
      if (primary.length > 0) return primary;
    }
    if (snapshotFn) return snapshotFn(countyFips, bbox, opts);
    return [];
  }

  async listBuildingFootprintsNearBbox(
    countyFips: string,
    bbox: {
      westLng: number;
      southLat: number;
      eastLng: number;
      northLat: number;
    },
    opts?: { limit?: number },
  ): Promise<ReadonlyArray<import("@hauska-engine/atoms").PropertyAtomInstance>> {
    const primaryFn = this.primary.listBuildingFootprintsNearBbox?.bind(this.primary);
    const snapshotFn = this.snapshot.listBuildingFootprintsNearBbox?.bind(this.snapshot);
    if (primaryFn) {
      const primary = await primaryFn(countyFips, bbox, opts);
      if (primary.length > 0) return primary;
    }
    if (snapshotFn) return snapshotFn(countyFips, bbox, opts);
    return [];
  }

  async listSpecialDistrictPolygonsNearBbox(
    countyFips: string,
    bbox: {
      westLng: number;
      southLat: number;
      eastLng: number;
      northLat: number;
    },
    opts?: { limit?: number; districtType?: string },
  ): Promise<
    ReadonlyArray<{
      districtRowId: string;
      districtId: string;
      districtName: string;
      districtType: string;
      countyFips: string;
      geometry: unknown;
      sourceCitation: string;
    }>
  > {
    const primaryFn = this.primary.listSpecialDistrictPolygonsNearBbox?.bind(
      this.primary,
    );
    if (primaryFn) return primaryFn(countyFips, bbox, opts);
    const snapshotFn = this.snapshot.listSpecialDistrictPolygonsNearBbox?.bind(
      this.snapshot,
    );
    if (snapshotFn) return snapshotFn(countyFips, bbox, opts);
    return [];
  }

  /**
   * County node roster: primary wins when it has any nodes for the county;
   * fall back to snapshot otherwise (same shape as listRoadAtomsNearBbox).
   */
  async listGraphNodes(query: GraphNodeListQuery): Promise<GraphNodeListResult> {
    const primaryFn = this.primary.listGraphNodes?.bind(this.primary);
    const snapshotFn = this.snapshot.listGraphNodes?.bind(this.snapshot);
    if (primaryFn) {
      const primary = await primaryFn(query);
      if (primary.countyHasNodes) return primary;
    }
    if (snapshotFn) return snapshotFn(query);
    return { nodes: [], total: 0, totalCapped: false, countyHasNodes: false };
  }

  writeBoundaryEdgeAtom(
    instance: import("@hauska-engine/atoms").BoundaryEdgeAtomInstance,
  ) {
    return this.primary.writeBoundaryEdgeAtom(instance);
  }

  writeBoundaryEdgeAtomsBatch(
    instances: ReadonlyArray<import("@hauska-engine/atoms").BoundaryEdgeAtomInstance>,
  ) {
    return this.primary.writeBoundaryEdgeAtomsBatch(instances);
  }

  async listBoundaryEdgesByParcelNodeId(
    parcelNodeId: string,
  ): Promise<ReadonlyArray<import("@hauska-engine/atoms").BoundaryEdgeAtomInstance>> {
    const primary = await this.primary.listBoundaryEdgesByParcelNodeId(parcelNodeId);
    if (primary.length > 0) return primary;
    return this.snapshot.listBoundaryEdgesByParcelNodeId(parcelNodeId);
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

  async getAtomByDid(atomDid: string): Promise<StoredAtomInstance | null> {
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

    // Exact dedupe via listAtomDids is O(primary) and OOMs when the durable
    // store holds millions of property atoms (G2 / F1 Phase 0 outage). Cap
    // the walk; above the cap return a safe upper bound for /healthz.
    const EXACT_DEDUPE_CAP = 10_000;
    if (
      primaryCount <= EXACT_DEDUPE_CAP &&
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

    return snapshotCount + primaryCount;
  }
}
