/**
 * Storage port — the abstract surface every storage back-end satisfies.
 *
 * Postgres + IPFS implementation lives in `./pg-storage.ts`; the
 * `./in-memory-storage.ts` implementation supports tests and the
 * retrieval-api dev mode. Production retrieval-api uses `LayeredStorage`
 * to merge Postgres overlay reads with the committed snapshot corpus.
 *
 * Reads + writes are framed in atom-DID + atom-link terms. The port
 * does NOT expose Postgres or IPFS primitives directly — consumers
 * never know which back-end is wired underneath.
 */

import type {
  AtomLink,
  BoundaryEdgeAtomInstance,
  JurisdictionalOverlayAmendmentInstance,
  PropertyAtomInstance,
  RoadNodeAtomInstance,
  StoredAtomInstance,
} from "@hauska-engine/atoms";

import type {
  AccessPolicy,
  CodeAtomInstance,
  CodeAtomEntityType,
} from "@hauska-engine/atoms";

export interface AtomQuery {
  q?: string;
  jurisdiction?: string;
  entityType?: CodeAtomEntityType | string;
  limit?: number;
}

export interface AtomSearchResult {
  atomDid: string;
  entityType: string;
  entityId: string;
  jurisdictionTenant: string;
  sectionNumber: string | null;
  /** Prose snippet from the atom's bodyText/term/definition. */
  snippet: string;
  score: number;
  /** code-section rows only: the code-edition entityId the section belongs to. */
  editionId?: string | null;
  /**
   * Populated by the retrieval layer (not the storage port) after a
   * jurisdiction-corpus lookup: true when `editionId` matches the
   * jurisdiction's current edition, false when it does not, undefined when
   * edition status could not be resolved (fail-open — never treated as
   * superseded). Storage-port search() implementations leave this unset.
   */
  isCurrentEdition?: boolean;
}

/** Node kinds servable by the county node roster (CC browse). */
export type GraphNodeListType = "parcel" | "road";

/**
 * One roster row for the county node LIST (CC county → parcel/road browse).
 *
 * `identifiers` carries ONLY fields that genuinely exist in atom bodies:
 * - parcel: `propId` (derived from `parcelNodeId` = `{fips}:{propId}`). The
 *   persisted property atom shapes (zoning-fact / setback-rule /
 *   buildable-envelope / parcel-terrain-model) carry NO situs address and NO
 *   APN — those fields are never fabricated here.
 * - road: `roadName` (from the road-node atom's optional `displayName`).
 */
export interface GraphNodeListRow {
  nodeId: string;
  nodeType: GraphNodeListType;
  /** Road `displayName` when present; parcels have no display name in data. */
  displayName: string | null;
  identifiers: { propId?: string; roadName?: string };
  /** DISTINCT atom entity_types persisted against this node. */
  atomFamilies: ReadonlyArray<string>;
}

export interface GraphNodeListResult {
  nodes: ReadonlyArray<GraphNodeListRow>;
  /**
   * Count of DISTINCT nodes matching the filtered query. When
   * `totalCapped` is true the count scan hit its bound and `total` is a
   * floor (documented estimate), never a silent lie.
   */
  total: number;
  totalCapped: boolean;
  /**
   * False when the county has NO nodes of this type at all (regardless of
   * `q`) — the honest-degrade signal for the wire layer.
   */
  countyHasNodes: boolean;
}

export interface GraphNodeListQuery {
  countyFips: string;
  nodeType: GraphNodeListType;
  /** Case-insensitive substring over nodeId/propId (parcel) or nodeId/displayName (road). */
  q?: string;
  limit: number;
  offset: number;
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
  /**
   * ADR-017 access tier propagated from the jurisdiction-corpus atom.
   * Absent does not match any filter; writers refuse when omitted.
   */
  accessPolicy?: AccessPolicy;
}

export interface StoragePort {
  /** Atomic write: pin to IPFS, index in Postgres, emit event. */
  writeAtom(instance: CodeAtomInstance): Promise<{ atomDid: string; cid: string }>;

  /**
   * Property reasoning atoms (zoning-fact / setback-rule / buildable-envelope /
   * parcel-terrain-model).
   * Persists jsonb body to the same `atoms` table (Phase 1b).
   */
  writePropertyAtom(
    instance: PropertyAtomInstance,
  ): Promise<{ atomDid: string; cid: string }>;

  /**
   * Batch property-atom write (breadth bake). Same semantics as
   * writePropertyAtom; multi-row INSERT for county-scale throughput.
   */
  writePropertyAtomsBatch(
    instances: ReadonlyArray<PropertyAtomInstance>,
    lease?: import("./atoms-writer-lease.js").HeldLease,
  ): Promise<ReadonlyArray<{ atomDid: string; cid: string }>>;

  /**
   * Active property atoms linked to a parcel node via body.parcelNodeId
   * (no schema migration — linkage lives in jsonb payload).
   */
  listPropertyAtomsByParcelNodeId(
    parcelNodeId: string,
  ): Promise<ReadonlyArray<PropertyAtomInstance>>;

  /** Road spine nodes (27c WDLL 3 / R1). Same atoms table, roadNodeId linkage. */
  writeRoadAtom(
    instance: RoadNodeAtomInstance,
  ): Promise<{ atomDid: string; cid: string }>;

  writeRoadAtomsBatch(
    instances: ReadonlyArray<RoadNodeAtomInstance>,
    opts?: import("./road-ingest-supersede.js").WriteRoadAtomsBatchOptions,
  ): Promise<ReadonlyArray<{ atomDid: string; cid: string }>>;

  listRoadAtomsByRoadNodeId(
    roadNodeId: string,
  ): Promise<ReadonlyArray<RoadNodeAtomInstance>>;

  /**
   * Road-nodes whose centerline intersects a WGS84 bbox (Track B1 site-plan /
   * PE viewport road layer). Optional on older ports — callers must feature-detect.
   * `limit` caps rows for map payloads (default left to implementation).
   */
  listRoadAtomsNearBbox?(
    countyFips: string,
    bbox: {
      westLng: number;
      southLat: number;
      eastLng: number;
      northLat: number;
    },
    opts?: { limit?: number },
  ): Promise<ReadonlyArray<RoadNodeAtomInstance>>;

  /**
   * Present building-footprint atoms whose footprintGeometry intersects a WGS84
   * bbox (P-60 map layer). Optional on older ports — callers must feature-detect.
   */
  listBuildingFootprintsNearBbox?(
    countyFips: string,
    bbox: {
      westLng: number;
      southLat: number;
      eastLng: number;
      northLat: number;
    },
    opts?: { limit?: number },
  ): Promise<ReadonlyArray<PropertyAtomInstance>>;

  /**
   * TCEQ water-district polygons intersecting a WGS84 bbox — the same source
   * layer cited by special-district-fact atoms (P-60 mud-pid map slot). Returns
   * [] when tx_special_district is not installed. Optional on older ports.
   */
  listSpecialDistrictPolygonsNearBbox?(
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
  >;

  /**
   * County → node roster LIST (CC browse; Control-Tower flow port). Pages
   * DISTINCT parcel / road node ids for a county with a real (capped) count.
   * Optional on older ports — callers must feature-detect.
   */
  listGraphNodes?(query: GraphNodeListQuery): Promise<GraphNodeListResult>;

  /** Property boundary edges (27f S2-U2). Same atoms table, parcelNodeId linkage. */
  writeBoundaryEdgeAtom(
    instance: BoundaryEdgeAtomInstance,
  ): Promise<{ atomDid: string; cid: string }>;

  writeBoundaryEdgeAtomsBatch(
    instances: ReadonlyArray<BoundaryEdgeAtomInstance>,
  ): Promise<ReadonlyArray<{ atomDid: string; cid: string }>>;

  listBoundaryEdgesByParcelNodeId(
    parcelNodeId: string,
  ): Promise<ReadonlyArray<BoundaryEdgeAtomInstance>>;

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
  getAtomByDid(atomDid: string): Promise<StoredAtomInstance | null>;

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

  /**
   * Return a jurisdiction's ADR-019 Layer 2 overlay amendments targeting
   * a given Layer 1 base `code-section`. Used by effective-rule
   * composition: every `code-amendment` whose `amendmentScope` is
   * `"jurisdictional-overlay"`, whose `jurisdictionTenant` matches, and
   * whose `affectedSectionIds` includes `baseSectionId`. Returned
   * ascending by `effectiveDate` so the composition step can apply them
   * in order without re-sorting.
   */
  getJurisdictionalOverlays(
    jurisdictionTenant: string,
    baseSectionId: string,
  ): Promise<ReadonlyArray<JurisdictionalOverlayAmendmentInstance>>;

  /** Graph traversal: outbound edges from an atom by link type. */
  traverse(
    fromAtomDid: string,
    linkType?: AtomLink["linkType"],
  ): Promise<ReadonlyArray<AtomLink & { toAtom: StoredAtomInstance | null }>>;

  /** Graph traversal: inbound edges pointing at an atom by link type. */
  traverseInbound(
    toAtomDid: string,
    linkType?: AtomLink["linkType"],
  ): Promise<
    ReadonlyArray<AtomLink & { fromAtom: StoredAtomInstance | null }>
  >;

  /** Per-jurisdiction status snapshot for the coverage dashboard + MCP list_jurisdictions tool. */
  listJurisdictionStatus(filter?: {
    qualityBarOnly?: boolean;
    /**
     * Optional access-policy allow-list. Used by surfaces that gate on
     * visibility: MCP `list_jurisdictions` for unauthenticated callers
     * passes `["public-free"]`; platform-internal callers pass all four.
     * Omitted = no access-policy filter. Snapshots whose `accessPolicy`
     * is absent do not match any allow-list entry.
     */
    accessPolicies?: ReadonlyArray<AccessPolicy>;
  }): Promise<ReadonlyArray<JurisdictionStatusSnapshot>>;

  upsertJurisdictionStatus(snapshot: JurisdictionStatusSnapshot): Promise<void>;

  /**
   * Total atom instances loaded in this back-end (all entity types).
   *
   * On Postgres (2026-09-06 hardening) this is `pg_stat_user_tables.n_live_tup`
   * — the SAME statistics-based estimate `estimateAtomCount()` uses, not an
   * exact `COUNT(*)`. It used to be a plain unbounded full-table scan; a real
   * incident found a still-unidentified caller hitting it every ~30s, each
   * call taking minutes on a 100M+-row table and piling up concurrently
   * against shared compute. Every legitimate caller left on main only needed
   * an approximate/observability number anyway (nothing correctness-critical
   * called this), so the interface method's exactness guarantee is gone on
   * Postgres — a caller that genuinely needs an exact total should count a
   * narrower, indexed slice, not the whole table. `InMemoryStorage` stays
   * exact (a Map size lookup is cheap regardless).
   */
  countAtoms(): Promise<number>;

  /**
   * Cheap presence check: does this back-end hold at least one atom?
   * For a liveness/health check that only needs `count > 0` — never use
   * `countAtoms()` for that; even hardened to an estimate, `hasAtoms()` is
   * the one actually documented and tested for a recurring health-check path.
   */
  hasAtoms(): Promise<boolean>;

  /**
   * Cheap, approximate atom count for observability (boot/startup logs,
   * dashboards) — not correctness-critical code. On Postgres this reads
   * `pg_stat_user_tables.n_live_tup`, a statistics-based estimate updated by
   * autovacuum/autoanalyze (can lag real time by hours/days on a quiet
   * table) — same query `countAtoms()` now uses on Postgres. Every Cloud Run
   * instance start (deploy, autoscale-out, cold start after scale-to-zero)
   * runs whatever this backs, so it must stay cheap regardless of table size.
   */
  estimateAtomCount(): Promise<number>;
}
