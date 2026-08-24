/**
 * @hauska-engine/retrieval
 *
 * Hybrid retrieval query layer per ADR-010 §4 (pre-expansion +
 * tool-call traversal). Consumed by `services/retrieval-api`.
 *
 * v1 implementation orchestrates structural search (storage.search) +
 * graph traversal (storage.traverse). Vector similarity lands behind
 * the same interface once pgvector + embedding pipeline are wired.
 */

import {
  isPropertyAtomInstance,
  buildAtomDid,
  isPedestrianOsmHighwayTag,
  PARCEL_KEYED_PROPERTY_ENTITY_TYPES,
} from "@hauska-engine/atoms";
import type {
  AtomLink,
  CodeAtomEntityType,
  RoadNodeAtomInstance,
  StoredAtomInstance,
} from "@hauska-engine/atoms";
import type { Scope } from "@hauska-engine/atom-contract-pin";
import {
  applyPropertyCalibrationAtRead,
  applyStoredAtomCalibrationAtRead,
  type CalibrationOverlayPort,
} from "@hauska-engine/engine-core/property-reasoning";
import { isStaleBastropCitySetbackRule } from "@hauska-engine/adapters";
import { envelopeServeIndependentOfStaleSetback } from "./envelope-serve-independent.js";
import { resolveAttachingRoadNodes } from "@hauska-engine/engine-core/site-plan";
import type {
  AccessPolicy,
  AtomSearchResult,
  GraphNodeListType,
  JurisdictionStatusSnapshot,
  StoragePort,
} from "@hauska-engine/storage";

import { resolveEffectiveRule, type EffectiveSection } from "./effective-rule.js";
import { getAtomTrace, type AtomTraceOutput } from "./atom-trace.js";
import { resolveEditionAtDate, type EditionAtDateResult } from "./edition-at-date.js";
import {
  buildPropertyNodeDetail,
  listBoundaryEdgesWire,
  type PropertyNodeDetail,
} from "./node-detail.js";

export * from "./effective-rule.js";
export * from "./atom-trace.js";
export * from "./edition-at-date.js";
export * from "./node-detail.js";

export interface SearchInput {
  q: string;
  jurisdiction?: string;
  entityType?: CodeAtomEntityType;
  limit?: number;
  /**
   * Default false: superseded-edition code-section results are excluded.
   * true includes them (annotated isCurrentEdition: false rather than
   * dropped). Unresolvable edition status is never excluded (fail-open).
   */
  includeSuperseded?: boolean;
}

export interface SearchOutput {
  results: ReadonlyArray<AtomSearchResult>;
  totalCandidates: number;
}

export interface GetAtomInput {
  atomDid?: string;
  entityType?: CodeAtomEntityType;
  entityId?: string;
  includeComposition?: boolean;
}

export interface GetAtomOutput {
  /** Code-section or property reasoning atom (Gate C serves both). */
  atom: StoredAtomInstance | null;
  /** Composition-resolved children when `includeComposition === true`. */
  composition?: ReadonlyArray<{
    link: AtomLink;
    atom: StoredAtomInstance | null;
  }>;
}

export interface PropertyAtomChainWire {
  parcelNodeId: string;
  /**
   * zoningFact / setbackRule / buildableEnvelope: each served slot is
   * guaranteed to carry `atomDid` (backfilled via buildAtomDid when the
   * stored row predates the field — same fallback the `atoms` list below
   * already used). `sourceCitation` and, when the entity type carries one,
   * `sourceCodeAtomRef` (setback-rule always; zoning-fact when the district
   * code-section map resolves) pass through as their own properties on the
   * stored instance — additive, no wrapping, honest absence when unset.
   */
  zoningFact: StoredAtomInstance | null;
  setbackRule: StoredAtomInstance | null;
  buildableEnvelope: StoredAtomInstance | null;
  /**
   * One served slot per parcel-keyed property entity type (derived from
   * {@link PARCEL_KEYED_PROPERTY_ENTITY_TYPES}; `road-node` excluded).
   * Honest null when no active row exists for that type on this parcel.
   */
  atomsByType: Record<string, StoredAtomInstance | null>;
  /**
   * Road-node atoms attaching to this parcel (Track B1). Empty when none attach.
   * Resolved from boundary-edge facingRoad (and proximity when a ring is supplied
   * via getAttachingRoads). Never fabricated.
   */
  attachingRoads: ReadonlyArray<StoredAtomInstance>;
  atoms: ReadonlyArray<{
    did: string;
    type: string;
    kind: string;
    accessPolicy: string;
    payload: StoredAtomInstance;
  }>;
}

/**
 * Guarantee `atomDid` on a served property/road atom slot without mutating
 * the caller's object. Same fallback the atoms-list mapper already used
 * (buildAtomDid(entityType, entityId) when the stored atomDid is missing or
 * not a `did:`-prefixed string) — pulled out so the top-level chain slots
 * (zoningFact / setbackRule / buildableEnvelope) get the identical guarantee
 * the atoms list already had. `sourceCitation` / `sourceCodeAtomRef` are
 * left untouched (already own-properties on the stored instance when present).
 */
function withGuaranteedAtomDid<T extends StoredAtomInstance>(payload: T): T {
  const existing = (payload as { atomDid?: unknown }).atomDid;
  if (typeof existing === "string" && existing.startsWith("did:")) return payload;
  return {
    ...payload,
    atomDid: buildAtomDid(payload.entityType, payload.entityId).raw,
  };
}

export interface RoadAtomChainWire {
  roadNodeId: string;
  roadNode: StoredAtomInstance | null;
  atoms: ReadonlyArray<{
    did: string;
    type: string;
    kind: string;
    accessPolicy: string;
    payload: StoredAtomInstance;
  }>;
}

/** One node row on the county roster wire (snake_case pinned with CC). */
export interface NodeListWireNode {
  node_id: string;
  node_type: GraphNodeListType;
  display_name: string | null;
  identifiers: { propId?: string; roadName?: string };
  atom_families?: string[];
}

/** GET /nodes wire shape (county → parcel/road roster; CC browse). */
export interface NodeListWire {
  available: boolean;
  reason?: string;
  county: string;
  nodeType: GraphNodeListType;
  nodes: NodeListWireNode[];
  /** Real count for the filtered query; a floor when total_capped is true. */
  total: number;
  /** Present (true) when the count scan hit its bound — total is a floor. */
  total_capped?: true;
  limit: number;
  offset: number;
}

export interface QueryJurisdictionInput {
  jurisdictionTenant: string;
  queryType?: "summary" | "permits";
  projectType?: string;
}

export interface QueryJurisdictionOutput {
  status: JurisdictionStatusSnapshot | null;
  /** Used for `/jurisdictions/:id/permits?projectType=` (renamed `search_permit_atoms` target). */
  permitAtoms?: ReadonlyArray<AtomSearchResult>;
}

export interface HybridRetrievalOptions {
  /**
   * Optional migration-0037 overlay port (cortex Neon). When set, property
   * atom READ paths resolve `calibratedConfidence` via overlay keyed on
   * parcel node / atom DID. Absent → served atoms keep asserted placeholders.
   */
  calibrationOverlay?: CalibrationOverlayPort | null;
}

/**
 * Ensure near-bbox (and any road wire) carries isPedestrianWay without re-ingest.
 * Prefers the persisted flag; otherwise derives from provenance.osmHighwayTag
 * via the shared atoms denylist (same as emit / frontage).
 */
export function ensureRoadPedestrianWayFlag(
  road: StoredAtomInstance,
): StoredAtomInstance {
  const body = road as Partial<RoadNodeAtomInstance> & StoredAtomInstance;
  if (typeof body.isPedestrianWay === "boolean") return road;
  const prov = body.row?.provenance as { osmHighwayTag?: string } | undefined;
  const tag =
    typeof prov?.osmHighwayTag === "string" ? prov.osmHighwayTag : undefined;
  return {
    ...body,
    isPedestrianWay: isPedestrianOsmHighwayTag(tag),
  } as StoredAtomInstance;
}

export class HybridRetrieval {
  private readonly overlay: CalibrationOverlayPort | null;

  constructor(
    private readonly storage: StoragePort,
    options: HybridRetrievalOptions = {},
  ) {
    this.overlay = options.calibrationOverlay ?? null;
  }

  async search(input: SearchInput): Promise<SearchOutput> {
    const baseQuery: import("@hauska-engine/storage").AtomQuery = {
      ...(input.q.length > 0 ? { q: input.q } : {}),
      ...(input.jurisdiction ? { jurisdiction: input.jurisdiction } : {}),
      ...(input.entityType ? { entityType: input.entityType } : {}),
      limit: input.limit ?? 25,
    };
    const rawResults = await this.storage.search(baseQuery);
    const annotated = await this.annotateEditionCurrency(rawResults);

    if (input.includeSuperseded) {
      return { results: annotated, totalCandidates: annotated.length };
    }
    // Exclude only rows POSITIVELY known superseded; unresolved (undefined)
    // and current (true) both stay — fail-open on unknown edition status.
    const filtered = annotated.filter((r) => r.isCurrentEdition !== false);
    return { results: filtered, totalCandidates: filtered.length };
  }

  /**
   * Resolve each distinct jurisdictionTenant's current edition ONCE (no
   * per-row storage calls), then annotate code-section results with
   * editionId / isCurrentEdition. Non-code-section rows and rows already
   * lacking an editionId pass through unchanged. Unresolvable jurisdiction
   * or edition => isCurrentEdition left undefined (fail-open honest flag,
   * never excluded).
   */
  private async annotateEditionCurrency(
    results: ReadonlyArray<import("@hauska-engine/storage").AtomSearchResult>,
  ): Promise<ReadonlyArray<import("@hauska-engine/storage").AtomSearchResult>> {
    const jurisdictionTenants = [
      ...new Set(
        results
          .filter((r) => typeof r.editionId === "string" && r.editionId.length > 0)
          .map((r) => r.jurisdictionTenant),
      ),
    ];
    if (jurisdictionTenants.length === 0) return results;

    const currentEditionByTenant = new Map<string, string | null>();
    await Promise.all(
      jurisdictionTenants.map(async (tenant) => {
        try {
          const corpus = await this.storage.getAtom("jurisdiction-corpus", tenant);
          currentEditionByTenant.set(tenant, corpus?.currentEditionId ?? null);
        } catch {
          // Unresolvable corpus => leave unset; annotation below stays undefined.
        }
      }),
    );

    return results.map((r) => {
      if (!r.editionId) return r;
      if (!currentEditionByTenant.has(r.jurisdictionTenant)) return r;
      const currentEditionId = currentEditionByTenant.get(r.jurisdictionTenant);
      if (currentEditionId == null) return r; // unresolvable => fail-open, undefined stays
      return { ...r, isCurrentEdition: r.editionId === currentEditionId };
    });
  }

  async getAtom(input: GetAtomInput): Promise<GetAtomOutput> {
    let atom: StoredAtomInstance | null = null;
    if (input.atomDid) {
      atom = await this.storage.getAtomByDid(input.atomDid);
    } else if (input.entityType && input.entityId) {
      atom = await this.storage.getAtom(input.entityType, input.entityId);
    }
    if (!atom) return { atom: null };
    atom = await applyStoredAtomCalibrationAtRead(atom, this.overlay);
    if (!input.includeComposition) return { atom };
    const atomDid =
      input.atomDid ??
      (isPropertyAtomInstance(atom)
        ? (atom.atomDid ?? buildAtomDid(atom.entityType, atom.entityId).raw)
        : buildAtomDid(atom.entityType, atom.entityId).raw);
    const composition = await this.storage.traverse(atomDid);
    return {
      atom,
      composition: await Promise.all(
        composition.map(async (edge) => ({
          link: {
            fromEntityType: edge.fromEntityType,
            fromEntityId: edge.fromEntityId,
            toEntityType: edge.toEntityType,
            toEntityId: edge.toEntityId,
            linkType: edge.linkType,
            ...(edge.context ? { context: edge.context } : {}),
          },
          atom: edge.toAtom
            ? await applyStoredAtomCalibrationAtRead(edge.toAtom, this.overlay)
            : null,
        })),
      ),
    };
  }

  /**
   * Resolve zoning-fact → setback-rule → buildable-envelope for a parcel node.
   * Always-on storage read; empty slots when no PROPERTY_ATOM_PATH rows exist.
   * Calibrated axis resolves at READ via overlay (I-E / Master WDLL 3.10).
   */
  async getPropertyAtomChain(parcelNodeId: string): Promise<PropertyAtomChainWire> {
    const rows = await this.storage.listPropertyAtomsByParcelNodeId(parcelNodeId);
    const resolved = await Promise.all(
      rows.map((row) =>
        isPropertyAtomInstance(row)
          ? applyPropertyCalibrationAtRead(row, this.overlay)
          : Promise.resolve(row),
      ),
    );
    let zoningFact: StoredAtomInstance | null = null;
    let setbackRule: StoredAtomInstance | null = null;
    let buildableEnvelope: StoredAtomInstance | null = null;
    for (const row of resolved) {
      if (row.entityType === "zoning-fact") zoningFact = row;
      else if (row.entityType === "setback-rule") setbackRule = row;
      else if (row.entityType === "buildable-envelope") buildableEnvelope = row;
    }

    const zoningAdapter =
      zoningFact && typeof zoningFact.sourceAdapter === "string"
        ? zoningFact.sourceAdapter
        : "";
    const isBastropCityZoning =
      zoningAdapter.includes("bastrop-city") ||
      zoningAdapter.includes("txgio-zoning-stamp:bastrop-city-tx");
    // R13/R27 — a stale/repealed-source Bastrop city setback rule is UNSERVABLE,
    // and its DEPENDENT buildable-envelope is invalidated (not just card-suppressed)
    // so no raw-chain / cached-tile consumer draws a repealed-source envelope.
    let staleSetbackSuppressed = false;
    if (
      setbackRule &&
      isBastropCityZoning &&
      isStaleBastropCitySetbackRule({
        parcelNodeId,
        sourceAdapter:
          typeof setbackRule.sourceAdapter === "string"
            ? setbackRule.sourceAdapter
            : null,
        sourceCodeAtomDid:
          setbackRule.sourceCodeAtomRef &&
          typeof setbackRule.sourceCodeAtomRef === "object" &&
          typeof (setbackRule.sourceCodeAtomRef as { atomDid?: string }).atomDid ===
            "string"
            ? (setbackRule.sourceCodeAtomRef as { atomDid: string }).atomDid
            : null,
      })
    ) {
      setbackRule = null;
      staleSetbackSuppressed = true;
      if (!envelopeServeIndependentOfStaleSetback(buildableEnvelope)) {
        buildableEnvelope = null; // R27 — invalidate dependent envelope on source-repeal.
      }
    }
    const atoms = resolved
      // R27 — drop stale setback-rule; drop dependent envelope only (warm declines survive).
      .filter((payload) => {
        if (!staleSetbackSuppressed) return true;
        if (payload.entityType === "setback-rule") return false;
        if (payload.entityType === "buildable-envelope") {
          return envelopeServeIndependentOfStaleSetback(payload);
        }
        return true;
      })
      .map((payload) => {
      const did =
        typeof payload.atomDid === "string" && payload.atomDid.startsWith("did:")
          ? payload.atomDid
          : buildAtomDid(payload.entityType, payload.entityId).raw;
      return {
        did,
        type: payload.entityType,
        kind: payload.entityType,
        accessPolicy:
          payload.accessPolicy != null ? payload.accessPolicy : "",
        payload,
      };
    });
    // Track B1: attaching road-nodes for STREET/map render (boundary-edge path;
    // empty ring skips proximity — callers with a ring use getAttachingRoads).
    const attaching = await resolveAttachingRoadNodes({
      parcelNodeId,
      ringWgs84: [],
      storage: this.storage,
    });
    // Prefer the legacy suppressed slots for zoning/setback/envelope so
    // atomsByType cannot resurrect a Bastrop stale setback the camelCase
    // fields already nulled. Other parcel-keyed types come from `resolved`.
    const atomsByType: Record<string, StoredAtomInstance | null> = {};
    for (const entityType of PARCEL_KEYED_PROPERTY_ENTITY_TYPES) {
      let slot: StoredAtomInstance | null = null;
      if (entityType === "zoning-fact") slot = zoningFact;
      else if (entityType === "setback-rule") slot = setbackRule;
      else if (entityType === "buildable-envelope") slot = buildableEnvelope;
      else {
        slot = resolved.find((r) => r.entityType === entityType) ?? null;
      }
      atomsByType[entityType] = slot ? withGuaranteedAtomDid(slot) : null;
    }

    return {
      parcelNodeId,
      zoningFact: zoningFact ? withGuaranteedAtomDid(zoningFact) : null,
      setbackRule: setbackRule ? withGuaranteedAtomDid(setbackRule) : null,
      buildableEnvelope: buildableEnvelope
        ? withGuaranteedAtomDid(buildableEnvelope)
        : null,
      atomsByType,
      attachingRoads: attaching.roads,
      atoms,
    };
  }

  /**
   * Resolve attaching road-nodes for a parcel (Track B1). Optional ring enables
   * proximity fallback when boundary-edge facingRoad refs are absent.
   */
  async getAttachingRoads(
    parcelNodeId: string,
    ringWgs84: ReadonlyArray<readonly [number, number]> = [],
  ): Promise<{
    parcelNodeId: string;
    attachingRoads: ReadonlyArray<StoredAtomInstance>;
    source: "boundary-edge" | "proximity" | "none";
    reason?: string;
  }> {
    const attaching = await resolveAttachingRoadNodes({
      parcelNodeId,
      ringWgs84,
      storage: this.storage,
    });
    return {
      parcelNodeId,
      attachingRoads: attaching.roads,
      source: attaching.source,
      reason: attaching.reason,
    };
  }

  /**
   * Resolve road-node atoms for inspect (27c WDLL 3).
   * Road nodes are not property atoms — skip migration-0037 calibration overlay
   * (overlay keys on parcelNodeId; road rows have roadNodeId only).
   */
  async getRoadAtomChain(roadNodeId: string): Promise<RoadAtomChainWire> {
    const resolved = await this.storage.listRoadAtomsByRoadNodeId(roadNodeId);
    const roadNode = resolved[0] ?? null;
    const atoms = resolved.map((payload) => {
      const did =
        typeof payload.atomDid === "string" && payload.atomDid.startsWith("did:")
          ? payload.atomDid
          : buildAtomDid(payload.entityType, payload.entityId).raw;
      return {
        did,
        type: payload.entityType,
        kind: payload.entityType,
        accessPolicy:
          payload.accessPolicy != null ? payload.accessPolicy : "",
        payload,
      };
    });
    return { roadNodeId, roadNode, atoms };
  }

  /**
   * Viewport road layer (Track B1-map). Serves road-nodes whose centerline
   * intersects a WGS84 bbox — same StoragePort as site-plan proximity, now
   * reachable over HTTP so PE is not stranded on per-parcel attaching-roads.
   */
  async listRoadNodesNearBbox(input: {
    countyFips: string;
    westLng: number;
    southLat: number;
    eastLng: number;
    northLat: number;
    limit?: number;
  }): Promise<{
    countyFips: string;
    bbox: {
      westLng: number;
      southLat: number;
      eastLng: number;
      northLat: number;
    };
    limit: number;
    count: number;
    roads: ReadonlyArray<StoredAtomInstance>;
  }> {
    const limit =
      typeof input.limit === "number" && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(Math.floor(input.limit), 2000))
        : 400;
    const bbox = {
      westLng: input.westLng,
      southLat: input.southLat,
      eastLng: input.eastLng,
      northLat: input.northLat,
    };
    const listFn = this.storage.listRoadAtomsNearBbox?.bind(this.storage);
    const roads = listFn
      ? await listFn(input.countyFips, bbox, { limit })
      : [];
    // Enrich isPedestrianWay for pre-flag atoms (no re-ingest) from osmHighwayTag.
    const enriched = roads.map(ensureRoadPedestrianWayFlag);
    return {
      countyFips: input.countyFips,
      bbox,
      limit,
      count: enriched.length,
      roads: enriched,
    };
  }

  /**
   * Viewport building-footprint layer (P-60). Serves present building-footprint
   * atoms whose footprintGeometry intersects a WGS84 bbox.
   */
  async listBuildingFootprintsNearBbox(input: {
    countyFips: string;
    westLng: number;
    southLat: number;
    eastLng: number;
    northLat: number;
    limit?: number;
  }): Promise<{
    countyFips: string;
    bbox: {
      westLng: number;
      southLat: number;
      eastLng: number;
      northLat: number;
    };
    limit: number;
    count: number;
    footprints: ReadonlyArray<StoredAtomInstance>;
  }> {
    const limit =
      typeof input.limit === "number" && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(Math.floor(input.limit), 2000))
        : 400;
    const bbox = {
      westLng: input.westLng,
      southLat: input.southLat,
      eastLng: input.eastLng,
      northLat: input.northLat,
    };
    const listFn = this.storage.listBuildingFootprintsNearBbox?.bind(this.storage);
    const rows = listFn ? await listFn(input.countyFips, bbox, { limit }) : [];
    const footprints = await Promise.all(
      rows.map((row) =>
        isPropertyAtomInstance(row)
          ? applyPropertyCalibrationAtRead(row, this.overlay)
          : Promise.resolve(row as StoredAtomInstance),
      ),
    );
    return {
      countyFips: input.countyFips,
      bbox,
      limit,
      count: footprints.length,
      footprints,
    };
  }

  /**
   * Viewport special-district layer (P-60 / mud-pid registry slot). Serves
   * TCEQ water-district polygons — the same source layer cited by
   * special-district-fact atoms, not a separate mud-pid GIS bake.
   */
  async listSpecialDistrictsNearBbox(input: {
    countyFips: string;
    westLng: number;
    southLat: number;
    eastLng: number;
    northLat: number;
    limit?: number;
    districtType?: string;
  }): Promise<{
    countyFips: string;
    bbox: {
      westLng: number;
      southLat: number;
      eastLng: number;
      northLat: number;
    };
    limit: number;
    count: number;
    districts: ReadonlyArray<{
      districtRowId: string;
      districtId: string;
      districtName: string;
      districtType: string;
      countyFips: string;
      geometry: unknown;
      sourceCitation: string;
    }>;
  }> {
    const limit =
      typeof input.limit === "number" && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(Math.floor(input.limit), 2000))
        : 200;
    const bbox = {
      westLng: input.westLng,
      southLat: input.southLat,
      eastLng: input.eastLng,
      northLat: input.northLat,
    };
    const listFn = this.storage.listSpecialDistrictPolygonsNearBbox?.bind(
      this.storage,
    );
    const districts = listFn
      ? await listFn(input.countyFips, bbox, {
          limit,
          ...(input.districtType !== undefined
            ? { districtType: input.districtType }
            : {}),
        })
      : [];
    return {
      countyFips: input.countyFips,
      bbox,
      limit,
      count: districts.length,
      districts,
    };
  }

  /**
   * County → node roster LIST (CC browse; Control-Tower flow port). Wire
   * shape pinned with Command Center: snake_case node rows, real (capped)
   * total, honest-degrade `{ available: false, reason }` when the county has
   * no nodes of the requested type or the backend cannot list.
   *
   * `identifiers` only carries fields that genuinely exist in atom bodies:
   * parcel → propId (from parcelNodeId); road → roadName (displayName).
   * No address/APN — persisted property atoms do not carry them.
   */
  async listGraphNodes(input: {
    county: string;
    nodeType: GraphNodeListType;
    q?: string;
    limit: number;
    offset: number;
  }): Promise<NodeListWire> {
    const { county, nodeType, limit, offset } = input;
    const base = { county, nodeType, limit, offset };
    const listFn = this.storage.listGraphNodes?.bind(this.storage);
    if (!listFn) {
      return {
        available: false,
        reason: "node listing not supported by this storage backend",
        ...base,
        nodes: [],
        total: 0,
      };
    }
    const result = await listFn({
      countyFips: county,
      nodeType,
      ...(input.q !== undefined ? { q: input.q } : {}),
      limit,
      offset,
    });
    if (!result.countyHasNodes) {
      return {
        available: false,
        reason: `no ${nodeType} nodes persisted for county ${county} (honest empty — not an error)`,
        ...base,
        nodes: [],
        total: 0,
      };
    }
    return {
      available: true,
      ...base,
      nodes: result.nodes.map((row) => ({
        node_id: row.nodeId,
        node_type: row.nodeType,
        display_name: row.displayName,
        identifiers: row.identifiers,
        atom_families: [...row.atomFamilies],
      })),
      total: result.total,
      ...(result.totalCapped ? { total_capped: true as const } : {}),
    };
  }

  /**
   * Control-Tower-shaped node detail for parcel / road / boundary-edge
   * (CC-A U1 / WDLL 1, 2, 6). Edges from StoragePort boundary primitives.
   */
  async getPropertyNodeDetail(nodeId: string): Promise<PropertyNodeDetail> {
    return buildPropertyNodeDetail(this.storage, nodeId);
  }

  /** Raw boundary-edge list for a parcel (stranded StoragePort → HTTP). */
  async listBoundaryEdgesByParcelNodeId(parcelNodeId: string) {
    return listBoundaryEdgesWire(this.storage, parcelNodeId);
  }

  async queryJurisdiction(
    input: QueryJurisdictionInput,
  ): Promise<QueryJurisdictionOutput> {
    const statuses = await this.storage.listJurisdictionStatus();
    const status =
      statuses.find((s) => s.jurisdictionTenant === input.jurisdictionTenant) ??
      null;
    if (input.queryType === "permits" && input.projectType) {
      const permitAtoms = await this.storage.search({
        q: input.projectType,
        jurisdiction: input.jurisdictionTenant,
        limit: 25,
      });
      return { status, permitAtoms };
    }
    return { status };
  }

  /**
   * Resolve the ADR-019 effective rule for a Layer 1 base section in a
   * jurisdiction: the base section composed with that jurisdiction's
   * Layer 2 overlays. This is the "what does the IRC require for X in
   * jurisdiction Y" query path.
   */
  async resolveEffectiveRule(input: {
    jurisdictionTenant: string;
    baseSectionId: string;
  }): Promise<EffectiveSection> {
    return resolveEffectiveRule(this.storage, input);
  }

  async getAtomTrace(input: {
    atomDid: string;
    audience?: Scope["audience"];
  }): Promise<AtomTraceOutput | null> {
    return getAtomTrace(this.storage, input);
  }

  /** K2 — edition in effect at a historical date for retrodiction. */
  async resolveEditionAtDate(args: {
    jurisdictionTenant: string;
    asOf: string;
  }): Promise<EditionAtDateResult> {
    return resolveEditionAtDate(this.storage, args);
  }

  async listJurisdictions(filter?: {
    qualityBarOnly?: boolean;
    /**
     * Access-policy allow-list (ADR-017 / `@hauska/atom-contract@^1.1.0`).
     * Used by surfaces that gate on visibility:
     * `MCP list_jurisdictions` for unauthenticated callers passes
     * `["public-free"]`. Omitted = no access-policy filter. Snapshots
     * whose `accessPolicy` is absent are treated as `"public-free"`.
     */
    accessPolicies?: ReadonlyArray<AccessPolicy>;
  }): Promise<ReadonlyArray<JurisdictionStatusSnapshot>> {
    return this.storage.listJurisdictionStatus(filter);
  }
}
