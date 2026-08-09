/**
 * In-memory StoragePort implementation.
 *
 * Backs tests + the retrieval-api dev mode. Production Postgres + IPFS
 * implementation lives in a sibling file (lands with the storage
 * migration sprint; this in-memory version satisfies the same port
 * so retrieval-api endpoints can be exercised end-to-end pre-Postgres).
 */

import { buildAtomDid, type AtomLink } from "@hauska-engine/atoms";
import type {
  BoundaryEdgeAtomInstance,
  CodeAtomInstance,
  PropertyAtomInstance,
  RoadNodeAtomInstance,
  StoredAtomInstance,
} from "@hauska-engine/atoms";
import { isBoundaryEdgeAtomInstance, isPropertyEntityType, isRoadNodeAtomInstance } from "@hauska-engine/atoms";

import { HotCache, InProcessIpfsPin } from "./in-process-cache.js";
import type {
  AtomQuery,
  AtomSearchResult,
  GraphNodeListQuery,
  GraphNodeListResult,
  GraphNodeListRow,
  JurisdictionStatusSnapshot,
  StoragePort,
} from "./port.js";
import { CORPUS_SNAPSHOT_FORMAT, type CorpusSnapshot } from "./snapshot.js";
import {
  decideRoadSupersede,
  retireRoadNodeInstance,
  type WriteRoadAtomsBatchOptions,
} from "./road-ingest-supersede.js";
import {
  matchesAtomQuery,
  rankSearchResults,
  scoreAtomSearch,
} from "./search-scoring.js";

export class InMemoryStorage implements StoragePort {
  private readonly atoms = new Map<string, StoredAtomInstance>();
  /** atomDid -> cid */
  private readonly cids = new Map<string, string>();
  private readonly links: AtomLink[] = [];
  private readonly jurisdictionStatus = new Map<string, JurisdictionStatusSnapshot>();
  private readonly cache = new HotCache();
  private readonly ipfs = new InProcessIpfsPin();

  async writeAtom(
    instance: CodeAtomInstance,
  ): Promise<{ atomDid: string; cid: string }> {
    const atomDid = buildAtomDid(instance.entityType, instance.entityId).raw;
    const pin = await this.ipfs.pin(instance.contentHash, JSON.stringify(instance));
    this.atoms.set(atomDid, instance);
    this.cids.set(atomDid, pin.cid);
    this.cache.set(atomDid, instance);
    return { atomDid, cid: pin.cid };
  }

  async writePropertyAtom(
    instance: PropertyAtomInstance,
  ): Promise<{ atomDid: string; cid: string }> {
    const atomDid =
      typeof instance.atomDid === "string" &&
      instance.atomDid.startsWith("did:hauska:")
        ? instance.atomDid
        : buildAtomDid(instance.entityType, instance.entityId).raw;
    const pin = await this.ipfs.pin(instance.contentHash, JSON.stringify(instance));
    this.atoms.set(atomDid, instance);
    this.cids.set(atomDid, pin.cid);
    this.cache.set(atomDid, instance);
    return { atomDid, cid: pin.cid };
  }

  async writePropertyAtomsBatch(
    instances: ReadonlyArray<PropertyAtomInstance>,
  ): Promise<ReadonlyArray<{ atomDid: string; cid: string }>> {
    const out: Array<{ atomDid: string; cid: string }> = [];
    for (const inst of instances) {
      out.push(await this.writePropertyAtom(inst));
    }
    return out;
  }

  async listPropertyAtomsByParcelNodeId(
    parcelNodeId: string,
  ): Promise<ReadonlyArray<PropertyAtomInstance>> {
    const byType = new Map<string, PropertyAtomInstance>();
    for (const inst of this.atoms.values()) {
      if (!isPropertyEntityType(inst.entityType)) continue;
      const property = inst as PropertyAtomInstance;
      if (property.parcelNodeId !== parcelNodeId) continue;
      if (property.status && property.status !== "active") continue;
      const prior = byType.get(property.entityType);
      if (!prior || property.entityId === parcelNodeId) {
        byType.set(property.entityType, property);
      }
    }
    return [...byType.values()];
  }

  async writeRoadAtom(
    instance: RoadNodeAtomInstance,
  ): Promise<{ atomDid: string; cid: string }> {
    return this.writePropertyAtom(instance as unknown as PropertyAtomInstance);
  }

  async writeRoadAtomsBatch(
    instances: ReadonlyArray<RoadNodeAtomInstance>,
    opts?: WriteRoadAtomsBatchOptions,
  ): Promise<ReadonlyArray<{ atomDid: string; cid: string }>> {
    if (instances.length === 0) return [];

    const toWrite: PropertyAtomInstance[] = [];
    const incomingWritten: RoadNodeAtomInstance[] = [];
    const retiredAt = new Date().toISOString();

    for (const incoming of instances) {
      const atomDid =
        typeof incoming.atomDid === "string" &&
        incoming.atomDid.startsWith("did:hauska:")
          ? incoming.atomDid
          : buildAtomDid(incoming.entityType, incoming.entityId).raw;
      const existingRaw = this.atoms.get(atomDid);
      const existing =
        existingRaw && isRoadNodeAtomInstance(existingRaw)
          ? {
              atomDid,
              sourceAdapter: existingRaw.sourceAdapter,
              versionStamp: existingRaw.versionStamp,
              status: existingRaw.status,
              body: existingRaw,
            }
          : null;
      const action = decideRoadSupersede(incoming, existing, opts);
      if (action === "skip-protected") continue;
      if (action === "supersede-retire" && existing) {
        toWrite.push(
          retireRoadNodeInstance(
            existing.body,
            `superseded-by:${incoming.sourceAdapter}`,
            retiredAt,
          ) as unknown as PropertyAtomInstance,
        );
      }
      toWrite.push(incoming as unknown as PropertyAtomInstance);
      incomingWritten.push(incoming);
    }

    if (toWrite.length === 0) return [];
    const written = await this.writePropertyAtomsBatch(toWrite);
    const start = written.length - incomingWritten.length;
    return written.slice(start);
  }

  async listRoadAtomsByRoadNodeId(
    roadNodeId: string,
  ): Promise<ReadonlyArray<RoadNodeAtomInstance>> {
    const out: RoadNodeAtomInstance[] = [];
    for (const inst of this.atoms.values()) {
      if (!isRoadNodeAtomInstance(inst)) continue;
      if (inst.roadNodeId !== roadNodeId) continue;
      if (inst.status && inst.status !== "active") continue;
      out.push(inst);
    }
    return out;
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
  ): Promise<ReadonlyArray<RoadNodeAtomInstance>> {
    const out: RoadNodeAtomInstance[] = [];
    for (const inst of this.atoms.values()) {
      if (!isRoadNodeAtomInstance(inst)) continue;
      if (inst.countyFips !== countyFips) continue;
      if (inst.status && inst.status !== "active") continue;
      const coords = inst.centerline?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const hits = coords.some(([lng, lat]) => {
        return (
          lng >= bbox.westLng &&
          lng <= bbox.eastLng &&
          lat >= bbox.southLat &&
          lat <= bbox.northLat
        );
      });
      if (hits) out.push(inst);
    }
    out.sort(
      (a, b) =>
        (b.centerline?.coordinates?.length ?? 0) -
        (a.centerline?.coordinates?.length ?? 0),
    );
    const limit =
      typeof opts?.limit === "number" && Number.isFinite(opts.limit)
        ? Math.max(1, Math.min(Math.floor(opts.limit), 2000))
        : 500;
    return out.slice(0, limit);
  }

  /**
   * County → node roster LIST (CC browse). Same semantics as the PgStorage
   * implementation: parcels = DISTINCT parcelNodeId over property atom
   * families; roads = DISTINCT roadNodeId over road-node atoms. Identifiers
   * only from fields that genuinely exist (propId from the node id; roadName
   * from road displayName) — property atoms carry no address/APN.
   */
  async listGraphNodes(query: GraphNodeListQuery): Promise<GraphNodeListResult> {
    const { countyFips, nodeType, limit, offset } = query;
    const q = (query.q ?? "").trim().toLowerCase();

    interface Agg {
      nodeId: string;
      displayName: string | null;
      families: Set<string>;
    }
    const byNode = new Map<string, Agg>();
    let countyHasNodes = false;

    const PARCEL_FAMILIES = new Set([
      "zoning-fact",
      "setback-rule",
      "buildable-envelope",
      "parcel-terrain-model",
    ]);

    for (const inst of this.atoms.values()) {
      let nodeId: string | null = null;
      let displayName: string | null = null;
      if (nodeType === "road") {
        if (!isRoadNodeAtomInstance(inst)) continue;
        if (inst.countyFips !== countyFips) continue;
        if (inst.status && inst.status !== "active") continue;
        nodeId = inst.roadNodeId;
        displayName =
          typeof inst.displayName === "string" ? inst.displayName : null;
      } else {
        if (!PARCEL_FAMILIES.has(inst.entityType)) continue;
        const parcelNodeId = (inst as { parcelNodeId?: unknown }).parcelNodeId;
        if (typeof parcelNodeId !== "string") continue;
        if (!parcelNodeId.startsWith(`${countyFips}:`)) continue;
        const status = (inst as { status?: string }).status;
        if (status && status !== "active") continue;
        nodeId = parcelNodeId;
      }
      countyHasNodes = true;
      if (q) {
        const idHit = nodeId.toLowerCase().includes(q);
        const nameHit = displayName?.toLowerCase().includes(q) ?? false;
        if (!idHit && !nameHit) continue;
      }
      const agg = byNode.get(nodeId) ?? {
        nodeId,
        displayName: null,
        families: new Set<string>(),
      };
      if (displayName && !agg.displayName) agg.displayName = displayName;
      agg.families.add(inst.entityType);
      byNode.set(nodeId, agg);
    }

    const sorted = [...byNode.values()].sort((a, b) => {
      if (nodeType === "road") {
        const an = a.displayName ?? "￿";
        const bn = b.displayName ?? "￿";
        if (an !== bn) return an < bn ? -1 : 1;
      }
      return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
    });

    const nodes: GraphNodeListRow[] = sorted
      .slice(offset, offset + limit)
      .map((agg) => {
        if (nodeType === "road") {
          return {
            nodeId: agg.nodeId,
            nodeType,
            displayName: agg.displayName,
            identifiers: agg.displayName ? { roadName: agg.displayName } : {},
            atomFamilies: [...agg.families].sort(),
          };
        }
        const propId = agg.nodeId.split(":")[1];
        return {
          nodeId: agg.nodeId,
          nodeType,
          displayName: null,
          identifiers: propId ? { propId } : {},
          atomFamilies: [...agg.families].sort(),
        };
      });

    return {
      nodes,
      total: sorted.length,
      totalCapped: false,
      countyHasNodes,
    };
  }

  async writeBoundaryEdgeAtom(
    instance: BoundaryEdgeAtomInstance,
  ): Promise<{ atomDid: string; cid: string }> {
    return this.writePropertyAtom(instance as unknown as PropertyAtomInstance);
  }

  async writeBoundaryEdgeAtomsBatch(
    instances: ReadonlyArray<BoundaryEdgeAtomInstance>,
  ): Promise<ReadonlyArray<{ atomDid: string; cid: string }>> {
    const out: Array<{ atomDid: string; cid: string }> = [];
    for (const inst of instances) {
      out.push(
        await this.writeBoundaryEdgeAtom(inst),
      );
    }
    return out;
  }

  async listBoundaryEdgesByParcelNodeId(
    parcelNodeId: string,
  ): Promise<ReadonlyArray<BoundaryEdgeAtomInstance>> {
    const out: BoundaryEdgeAtomInstance[] = [];
    for (const inst of this.atoms.values()) {
      if (!isBoundaryEdgeAtomInstance(inst)) continue;
      if (inst.parcelNodeId !== parcelNodeId) continue;
      if (inst.status && inst.status !== "active") continue;
      out.push(inst);
    }
    return out.sort((a, b) => a.edgeIndex - b.edgeIndex);
  }

  async writeAtoms(
    instances: ReadonlyArray<CodeAtomInstance>,
  ): Promise<ReadonlyArray<{ atomDid: string; cid: string }>> {
    const out: Array<{ atomDid: string; cid: string }> = [];
    for (const inst of instances) {
      out.push(await this.writeAtom(inst));
    }
    return out;
  }

  async writeAtomLinks(links: ReadonlyArray<AtomLink>): Promise<void> {
    for (const link of links) {
      const exists = this.links.some(
        (l) =>
          l.fromEntityId === link.fromEntityId &&
          l.fromEntityType === link.fromEntityType &&
          l.toEntityId === link.toEntityId &&
          l.toEntityType === link.toEntityType &&
          l.linkType === link.linkType,
      );
      if (!exists) this.links.push(link);
    }
  }

  async getAtom<T extends CodeAtomInstance>(
    entityType: T["entityType"],
    entityId: string,
  ): Promise<T | null> {
    const atomDid = buildAtomDid(entityType, entityId).raw;
    const cached = this.cache.get(atomDid);
    if (cached) return cached as T;
    const inst = this.atoms.get(atomDid);
    return (inst as T | undefined) ?? null;
  }

  async getAtomByDid(atomDid: string): Promise<StoredAtomInstance | null> {
    const cached = this.cache.get(atomDid);
    if (cached) return cached;
    return this.atoms.get(atomDid) ?? null;
  }

  async search(query: AtomQuery): Promise<ReadonlyArray<AtomSearchResult>> {
    const limit = query.limit ?? 25;
    const results: AtomSearchResult[] = [];
    for (const [atomDid, inst] of this.atoms) {
      if (!matchesAtomQuery(inst, query)) continue;
      const scored = scoreAtomSearch(inst, atomDid, query);
      if (scored) results.push(scored);
    }
    return rankSearchResults(results, limit);
  }

  async traverse(
    fromAtomDid: string,
    linkType?: AtomLink["linkType"],
  ): Promise<ReadonlyArray<AtomLink & { toAtom: StoredAtomInstance | null }>> {
    const out: Array<AtomLink & { toAtom: StoredAtomInstance | null }> = [];
    for (const link of this.links) {
      const fromDid = buildAtomDid(link.fromEntityType, link.fromEntityId).raw;
      if (fromDid !== fromAtomDid) continue;
      if (linkType && link.linkType !== linkType) continue;
      const toDid = buildAtomDid(link.toEntityType, link.toEntityId).raw;
      out.push({ ...link, toAtom: this.atoms.get(toDid) ?? null });
    }
    return out;
  }

  async traverseInbound(
    toAtomDid: string,
    linkType?: AtomLink["linkType"],
  ): Promise<
    ReadonlyArray<AtomLink & { fromAtom: StoredAtomInstance | null }>
  > {
    const out: Array<AtomLink & { fromAtom: StoredAtomInstance | null }> = [];
    for (const link of this.links) {
      const linkToDid = buildAtomDid(link.toEntityType, link.toEntityId).raw;
      if (linkToDid !== toAtomDid) continue;
      if (linkType && link.linkType !== linkType) continue;
      const fromDid = buildAtomDid(link.fromEntityType, link.fromEntityId).raw;
      out.push({ ...link, fromAtom: this.atoms.get(fromDid) ?? null });
    }
    return out;
  }

  async getSectionsBySectionNumber(
    jurisdictionTenant: string,
    sectionNumber: string,
  ): Promise<ReadonlyArray<Extract<CodeAtomInstance, { entityType: "code-section" }>>> {
    const out: Array<Extract<CodeAtomInstance, { entityType: "code-section" }>> = [];
    for (const inst of this.atoms.values()) {
      if (inst.entityType !== "code-section") continue;
      if (inst.jurisdictionTenant !== jurisdictionTenant) continue;
      if (inst.sectionNumber !== sectionNumber) continue;
      out.push(inst);
    }
    return out;
  }

  async getJurisdictionalOverlays(
    jurisdictionTenant: string,
    baseSectionId: string,
  ): Promise<ReadonlyArray<import("@hauska-engine/atoms").JurisdictionalOverlayAmendmentInstance>> {
    const out: Array<
      import("@hauska-engine/atoms").JurisdictionalOverlayAmendmentInstance
    > = [];
    for (const inst of this.atoms.values()) {
      if (inst.entityType !== "code-amendment") continue;
      if (inst.amendmentScope !== "jurisdictional-overlay") continue;
      if (inst.jurisdictionTenant !== jurisdictionTenant) continue;
      if (!inst.affectedSectionIds.includes(baseSectionId)) continue;
      out.push(inst);
    }
    out.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
    return out;
  }

  async listJurisdictionStatus(filter?: {
    qualityBarOnly?: boolean;
    accessPolicies?: ReadonlyArray<import("@hauska-engine/atoms").AccessPolicy>;
  }): Promise<ReadonlyArray<JurisdictionStatusSnapshot>> {
    let snapshots = Array.from(this.jurisdictionStatus.values());
    if (filter?.qualityBarOnly) {
      snapshots = snapshots.filter((s) => s.qualityBar.startsWith("passing"));
    }
    if (filter?.accessPolicies && filter.accessPolicies.length > 0) {
      const allowed = new Set(filter.accessPolicies);
      // Absent accessPolicy is treated as "public-free" per port docs.
      snapshots = snapshots.filter((s) =>
        allowed.has(s.accessPolicy ?? "public-free"),
      );
    }
    return snapshots;
  }

  async upsertJurisdictionStatus(snapshot: JurisdictionStatusSnapshot): Promise<void> {
    this.jurisdictionStatus.set(snapshot.jurisdictionTenant, snapshot);
  }

  /**
   * Serialize the full corpus to a committable snapshot artifact.
   * Atoms and links are emitted verbatim; CIDs are intentionally NOT
   * carried — `importSnapshot` re-pins, recomputing each CID
   * deterministically from `contentHash`, so a snapshot round-trip is
   * stable without persisting a transient CID map.
   */
  exportSnapshot(provenance?: ReadonlyArray<string>): CorpusSnapshot {
    return {
      format: CORPUS_SNAPSHOT_FORMAT,
      generatedAt: new Date().toISOString(),
      ...(provenance ? { provenance } : {}),
      atoms: Array.from(this.atoms.values()).filter(
        (inst): inst is CodeAtomInstance => !isPropertyEntityType(inst.entityType),
      ),
      links: [...this.links],
      jurisdictionStatus: Array.from(this.jurisdictionStatus.values()),
    };
  }

  /**
   * Hydrate this storage from a snapshot. Reuses `writeAtoms` /
   * `writeAtomLinks` / `upsertJurisdictionStatus` so a hydrated storage
   * is indistinguishable from one populated by a live ingest run.
   */
  async importSnapshot(snapshot: CorpusSnapshot): Promise<void> {
    await this.writeAtoms(snapshot.atoms);
    await this.writeAtomLinks(snapshot.links);
    for (const status of snapshot.jurisdictionStatus) {
      await this.upsertJurisdictionStatus(status);
    }
  }

  /** Convenience constructor: a storage hydrated from a snapshot. */
  static async fromSnapshot(snapshot: CorpusSnapshot): Promise<InMemoryStorage> {
    const storage = new InMemoryStorage();
    await storage.importSnapshot(snapshot);
    return storage;
  }

  async countAtoms(): Promise<number> {
    return this.atoms.size;
  }
}
