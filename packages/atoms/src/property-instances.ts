/**
 * Property reasoning atom instances (Gate C / Phase 1c).
 *
 * Contract shapes come from `@empressaio/atom-contract/property` (>=1.10.0;
 * package pin 1.11.0). Engine persistence fields (`entityId`, `contentHash`,
 * `status`, …) layer on top so StoragePort + MCP `AtomInstanceBase` stay
 * compatible. Do not invent a parallel SourceAttribution type — obligations
 * reuse actor-record + ObligationAtomInstance from the contract.
 */

import type {
  AtomInputRef,
  BuildableEnvelopeAtomInstance as ContractBuildableEnvelopeAtomInstance,
  BuildingFootprintAtomInstance as ContractBuildingFootprintAtomInstance,
  CadParcelRollAtomInstance as ContractCadParcelRollAtomInstance,
  FloodHazardFactAtomInstance as ContractFloodHazardFactAtomInstance,
  LandUseFactAtomInstance as ContractLandUseFactAtomInstance,
  OwnerFactAtomInstance as ContractOwnerFactAtomInstance,
  SpecialDistrictFactAtomInstance as ContractSpecialDistrictFactAtomInstance,
  RailCorridorFactAtomInstance as ContractRailCorridorFactAtomInstance,
  WellFactAtomInstance as ContractWellFactAtomInstance,
  ParcelNodeAtomInstance as ContractParcelNodeAtomInstance,
  ParcelTerrainModelAtomInstance as ContractParcelTerrainModelAtomInstance,
  SetbackMatchBasis,
  SetbackRuleAtomInstance as ContractSetbackRuleAtomInstance,
  TerrainExportFormat as ContractTerrainExportFormat,
  UtilityEasementAtomInstance as ContractUtilityEasementAtomInstance,
  ZoningFactAtomInstance as ContractZoningFactAtomInstance,
} from "@empressaio/atom-contract/property";
import type { ReasoningReadContract } from "@empressaio/atom-contract/read-contract";

import type { CodeAtomInstance } from "./instances.js";

export type {
  ZoningAbsence,
  SetbackAbsence,
  SetbackMatchBasis,
  SetbackFieldProvenance,
  SetbackFieldProvenanceEntry,
  ZoningFactAtomInstance as ContractZoningFactAtomInstance,
  SetbackRuleAtomInstance as ContractSetbackRuleAtomInstance,
  BuildableEnvelopeAtomInstance as ContractBuildableEnvelopeAtomInstance,
  ParcelTerrainModelAtomInstance as ContractParcelTerrainModelAtomInstance,
  TerrainExportFormat as ContractTerrainExportFormat,
  ParcelNodeAtomInstance as ContractParcelNodeAtomInstance,
  BuildingFootprintAtomInstance as ContractBuildingFootprintAtomInstance,
  UtilityEasementAtomInstance as ContractUtilityEasementAtomInstance,
  FloodHazardFactAtomInstance as ContractFloodHazardFactAtomInstance,
  CadParcelRollAtomInstance as ContractCadParcelRollAtomInstance,
  LandUseFactAtomInstance as ContractLandUseFactAtomInstance,
  OwnerFactAtomInstance as ContractOwnerFactAtomInstance,
  SpecialDistrictFactAtomInstance as ContractSpecialDistrictFactAtomInstance,
  RailCorridorFactAtomInstance as ContractRailCorridorFactAtomInstance,
  WellFactAtomInstance as ContractWellFactAtomInstance,
  WellFactAbsence,
  WellStatus,
  WellType,
  WellParcelRelation,
  OwnerExemptionFlags,
  OwnerFactAbsence,
  OwnerFactAbsenceKind,
  ParcelKeyKind,
  ParcelNodeAbsence,
  ParcelNodeAbsenceKind,
  ParcelGeometrySourceTier,
  ParcelGeometryStoreRef,
  ParcelExternalKey,
  SiteLayerVerifiedAbsence,
  BuildingFootprintAbsence,
  BuildingFootprintSourceTier,
  UtilityEasementAbsence,
  UtilityEasementClass,
  UtilityEasementSourceTier,
} from "@empressaio/atom-contract/property";

export {
  ZONING_ABSENCE_KIND,
  SETBACK_ABSENCE_KIND,
  SETBACK_MATCH_BASIS_VALUES,
  PROPERTY_ATOM_TIER,
  PROPERTY_DEFAULT_ACCESS_POLICY,
  BUILDABLE_ENVELOPE_DERIVATION_METHOD,
  PARCEL_TERRAIN_DERIVATION_METHOD,
  TERRAIN_DEFAULT_ACCESS_POLICY,
  TERRAIN_EXPORT_FORMATS,
  createZoningFact,
  createSetbackRule,
  createBuildableEnvelope,
  createParcelTerrainModel,
  createParcelNode,
  createBuildingFootprint,
  createUtilityEasement,
  createFloodHazardFact,
  createCadParcelRoll,
  createLandUseFact,
  createOwnerFact,
  createSpecialDistrictFact,
  createRailCorridorFact,
  createWellFact,
  PARCEL_NODE_SCHEMA,
  BUILDING_FOOTPRINT_SCHEMA,
  UTILITY_EASEMENT_SCHEMA,
  FLOOD_HAZARD_FACT_SCHEMA,
  CAD_PARCEL_ROLL_SCHEMA,
  LAND_USE_FACT_SCHEMA,
  OWNER_FACT_SCHEMA,
  SPECIAL_DISTRICT_FACT_SCHEMA,
  WELL_FACT_SCHEMA,
  OWNER_EXEMPTION_FLAGS_SCHEMA,
  OWNER_FACT_ABSENCE_KINDS,
  RAIL_CORRIDOR_FACT_SCHEMA,
  RAIL_CORRIDOR_DEFAULT_BUFFER_METERS,
  RAIL_CORRIDOR_STATUS_VALUES,
  RAIL_CORRIDOR_CLASS_VALUES,
  parcelNodeAtomDid,
  countyCoverageParcelNodeId,
  PARCEL_NODE_ID_PATTERN,
  PARCEL_NODE_ABSENCE_KINDS,
  BUILDING_FOOTPRINT_ABSENCE_KIND,
  UTILITY_EASEMENT_ABSENCE_KIND,
} from "@empressaio/atom-contract/property";

/**
 * Property entity types the engine persists and serves.
 *
 * 1.13.0 registration wave adds `parcel-node` (Rail 1 anchor, previously
 * advertised by MCP with no engine writer) plus the two ADR-029 site layers
 * that shipped in contract 1.12.0 but were never registered here — which is
 * why their manifest columns read UNPUB.
 *
 * 1.14.0 registration wave adds `flood-hazard-fact`, `cad-parcel-roll`, and
 * `land-use-fact` (manifest rails flood / cad / landuse — same UNPUB gap as
 * footprint/easement before #282).
 *
 * 1.16.0 registration wave adds `owner-fact` (manifest rail OWN, which read
 * NO ATOM while `cad_property` already carried 4.5M owner rows — the ruling
 * that owner is `public-paid` predated any atom to carry it; see doc_repo
 * `90_operations/OPS-15_owner_and_rrc_rail_gap_analysis.md`).
 *
 * 1.17.0/1.18.0 registration wave adds `rail-corridor-fact` (manifest rail
 * rail-corridor — NTAD NARN railroad tracks, NOT RRC oil/gas) and
 * `well-fact` (manifest rail rrc-wells, operations-lens public-record
 * surface wells from Texas RRC GIS). The two rails were built in parallel
 * and de-conflicted at the contract repo: rail-corridor-fact shipped
 * 1.17.0, well-fact 1.18.0.
 *
 * 1.19.0 registration wave adds `road-node` (manifest roads rail, ordinal 15).
 * It is `roadNodeId`-keyed, not `parcelNodeId`-keyed — registration here is for
 * manifest/engine truth only; it is not a member of `PropertyAtomInstance` and
 * must not satisfy `isPropertyAtomInstance`.
 *
 * `owner-fact` is the ONLY entry in this list that is not `public-free`. Its
 * contract schema pins `public-paid` and rejects anything else, so the gate —
 * not this list — is what keeps owner identity off the free tier.
 *
 * All entries except `road-node` are keyed on `parcelNodeId`, which is what
 * `listPropertyAtomsByParcelNodeId` and the snapshot partition in
 * `@hauska-engine/storage` assume of anything in `PropertyAtomInstance`.
 */
export type PropertyEntityType =
  | "parcel-node"
  | "zoning-fact"
  | "setback-rule"
  | "buildable-envelope"
  | "parcel-terrain-model"
  | "building-footprint"
  | "utility-easement"
  | "flood-hazard-fact"
  | "cad-parcel-roll"
  | "land-use-fact"
  | "owner-fact"
  | "rail-corridor-fact"
  | "well-fact"
  | "special-district-fact"
  | "road-node";

export const PROPERTY_ENTITY_TYPES: ReadonlyArray<PropertyEntityType> = [
  "parcel-node",
  "zoning-fact",
  "setback-rule",
  "buildable-envelope",
  "parcel-terrain-model",
  "building-footprint",
  "utility-easement",
  "flood-hazard-fact",
  "cad-parcel-roll",
  "land-use-fact",
  "owner-fact",
  "rail-corridor-fact",
  "well-fact",
  "special-district-fact",
  "road-node",
];

export type PropertyAtomStatus = "active" | "retired";

/** Alias kept for emitter call sites. */
export type MatchBasis = SetbackMatchBasis;

/**
 * Engine + MCP persistence fields layered on the contract property payload.
 * Canonical active `entityId` is the parcel node id (MCP
 * `did:hauska:<entityType>:<parcelNodeId>`).
 */
export interface EnginePropertyPersistence {
  entityId: string;
  jurisdictionTenant: string;
  fetchedAt: string;
  sourceAdapter: string;
  sourceUrl: string;
  contentHash: string;
  status: PropertyAtomStatus;
  versionStamp?: string;
  retiredAt?: string;
  supersedesEntityId?: string;
}

/** Optional envelope geometry outcome (engine extension; not a confidence multiply). */
export type EnvelopeHonestOutcome =
  | { kind: "buildable"; areaSqFt: number }
  | { kind: "no-buildable-area"; reason: string }
  | { kind: "provisional-front-edge"; reason: string };

/** Dimensional helper used by setback table resolution (maps to contract front/side/rear). */
export interface SetbackDimensions {
  frontFt: number;
  rearFt: number;
  sideFt: number;
  sideCornerFt: number;
  maxHeightFt?: number;
  maxLotCoveragePct?: number;
  maxImperviousPct?: number;
}

export type ZoningFactAtomInstance = ContractZoningFactAtomInstance &
  EnginePropertyPersistence & {
    districtLabel?: string;
    matchBasis?: MatchBasis;
    prefixMatched?: string;
    /**
     * Optional narrative code-section citation for the district's dimensional
     * requirements (same AtomInputRef shape as setback-rule's
     * `sourceCodeAtomRef`, role "rule" / entityType "code-section"). Present
     * only when a static jurisdiction map resolves the district; absent
     * otherwise (WDLL 3.8 — honest absence, no invented citation).
     */
    sourceCodeAtomRef?: AtomInputRef;
    /** Both refs together — district requirements + permitted-use table. */
    codeSectionRefs?: {
      districtRequirements: AtomInputRef;
      permittedUseTable: AtomInputRef;
    };
  };

/** R22/R24/R25/R26 — full-field + disclosure metadata surfaced on the PE card. */
export interface SetbackRuleDisplayMeta {
  /** Minimum lot size verbatim (e.g. "1/4 ac"). */
  minLotSize?: string;
  /** R22 — side yard resolved from a building/fire-code deferral (5ft), not a printed scalar. */
  sideFireCodeDeferral?: boolean;
  /** City's verbatim side-yard language when deferred to building/fire code. */
  sideCityLanguage?: string;
  /** R26 — dominant district when a split-zone parcel's stamp differed. */
  resolvedDistrictCode?: string | null;
  /** R26/R25 — minor zones present on a split-zoned parcel. */
  splitZoneMinorZones?: Array<{ districtCode: string | null; shapeArea?: number }>;
  /** R25 — conflicting second source (e.g. Bastrop layer-83 Revisions). */
  secondSource?: { source: string; note: string; citationUrl?: string };
}

export type SetbackRuleAtomInstance = ContractSetbackRuleAtomInstance &
  EnginePropertyPersistence & {
    districtCode?: string;
    prefixMatched?: string;
    /** Interior side yard (distinct from corner side — AMENDMENT 2 R2). */
    sideInteriorFt?: number;
    sideCornerFt?: number;
    maxHeightFt?: number;
    maxLotCoveragePct?: number;
    maxImperviousPct?: number;
    /** Minimum lot size verbatim (R24 full-field parity). */
    minLotSize?: string;
    /** R22/R24/R25/R26 — display + disclosure metadata for the PE card. */
    displayMeta?: SetbackRuleDisplayMeta;
  };

export type BuildableEnvelopeAtomInstance = ContractBuildableEnvelopeAtomInstance &
  EnginePropertyPersistence & {
    outcome?: EnvelopeHonestOutcome;
  };

/**
 * Contract terrain formats (1.10+) plus engine site-plan formats not yet in
 * the published `TERRAIN_EXPORT_FORMATS` enum.
 */
export type TerrainExportFormat =
  | ContractTerrainExportFormat
  /** Site-plan sprint (2026-07-25): closed-solid terrain mass + annotation
   * layers, additive to the thin-surface terrain formats above. */
  | "dxf-site-plan"
  | "ifc-site-plan"
  /** Site-plan sprint Wave 2: PDF sheet rendered from the SAME SitePlanModel
   * as dxf-site-plan/ifc-site-plan (WDLL 5/6) — drawing + summary block +
   * provenance panel + honesty line. Additive, never a second geometry
   * source. */
  | "pdf-site-plan"
  /** Property dossier (2026-07-29): one hand-to-client PDF — Standard-styled
   * cover (verdict) + cited brief facts + AI chat summary + owner notes, with
   * the parcel's site-plan sheets APPENDED and renumbered. Composed from the
   * SAME SitePlanModel as pdf-site-plan; user-supplied content is rendered
   * verbatim (labeled), never verified or fabricated by the engine. */
  | "pdf-dossier"
  /** Flood & Drainage report (2026-07-29, R3): parcel-scoped screening-level
   * drainage study rendered as a Sheet-Standard PDF (drawing + summary).
   * The companion json artifact caches the study payload the PE dock
   * visualizes — same run, never a second computation. */
  | "pdf-flood-drainage"
  | "json-flood-drainage-study";

/**
 * Engine overlay on published `@empressaio/atom-contract/property`
 * ParcelTerrainModelAtomInstance (>=1.10.0). Adds StoragePort persistence and
 * site-plan artifact fields. Prefer `createParcelTerrainModel` for contract-
 * shaped construction; this type is the persisted engine shape.
 */
export interface ParcelTerrainModelAtomInstance extends EnginePropertyPersistence {
  entityType: "parcel-terrain-model";
  atomDid: string;
  parcelNodeId: string;
  accessPolicy: "public-paid";
  atomTier: "data";
  extractedAt: string;
  sourceCitation: string;
  readContract?: ReasoningReadContract;
  reasoningChain: {
    reasoningKind: "derived";
    derivationMethod: "parcel-terrain-mesh-ifc-v1";
    inputAtomRefs: Array<{
      atomDid: string;
      role: "reference-field";
      citationLabel: "usgs-3dep-dem";
    }>;
  };
  artifacts: Partial<
    Record<
      TerrainExportFormat,
      {
        format: TerrainExportFormat;
        ref: string;
        byteCount?: number;
        vertexCount?: number;
        triangleCount?: number;
        contourIntervalMeters?: number;
        contourPolylineCount?: number;
        deferred?: boolean;
        deferredReason?: string;
        /** dxf-site-plan / ifc-site-plan only: setback offset ring degenerated
         * (e.g. front+rear consumed the lot) — drawn honestly, not fabricated. */
        setbackDegenerate?: boolean;
        setbackDegenerateReason?: string;
        /** dxf-site-plan / ifc-site-plan only: no road-anchor atom was available. */
        streetHonestAbsence?: boolean;
        /** site-plan only: no setback-rule atom on file — setback layer drawn
         * honest-absent (no F/S/R fabricated), not a refusal to export. */
        setbackHonestAbsence?: boolean;
        setbackHonestAbsenceReason?: string;
        annotationCount?: number;
        /** pdf-site-plan only: page count and honesty flags for the summary block. */
        pageCount?: number;
        zoningHonestAbsence?: boolean;
        floodZoneHonestUnavailable?: boolean;
        /** pdf-site-plan only: sheet-3 aerial imagery outcome. The page always
         * ships; false means it carries the honest "imagery unavailable" note
         * (bounded fetch failed/timed out) instead of Esri World Imagery. */
        aerialImageryEmbedded?: boolean;
        aerialImageryUnavailableReason?: string;
        /** pdf-dossier only: dossier composition record. Site-plan sheets are
         * appended when authorable; a missing site-plan capability NEVER
         * fails the dossier — `sitePlanAppended: false` plus the honest
         * reason instead. */
        dossierPageCount?: number;
        sitePlanAppended?: boolean;
        sitePlanUnavailableReason?: string;
        verdictIncluded?: boolean;
        briefSectionCount?: number;
        briefFactCount?: number;
        chatSummaryIncluded?: boolean;
        notesIncluded?: boolean;
        /** pdf-flood-drainage / json-flood-drainage-study only: study record.
         * honestEmpty=true means flat terrain / DEM void — the sheets still
         * ship with the honest panel, never fabricated geometry. */
        honestEmpty?: boolean;
        honestEmptyReason?: string;
        rainfallDepthInches?: number;
        rainfallSource?: "noaa-atlas14" | "parameter" | "default";
        computationLibrary?: string;
        flowExitCount?: number;
        /** pdf-flood-drainage / json-flood-drainage-study only (v2): the
         * water-gradient raster shipped in the study payload / composited
         * onto sheet 1. False = degenerate field, honestly absent. */
        gradientIncluded?: boolean;
      }
    >
  >;
  coverage: {
    coverageFraction: number;
    nodataCount: number;
    totalCells: number;
    resolutionMetersRequested: number | null;
    resolutionMetersActual: number | null;
    /** Effective DEM resolution actually fetched after adaptive tighten/relax
     * (may differ from requested when a large bbox is auto-coarsened to fit the
     * pixel cap, or a small bbox auto-tightened to meet the floor). */
    resolutionMetersAdapted?: number | null;
    touchesNodata: boolean;
    /** Contour-rendering tier provenance (qa/topo-fidelity-1ft). The mesh Z is
     * always 3DEP; this describes the source of the CONTOUR LINES only. */
    contourSource?: {
      tier: "authoritative-1ft" | "derived-3dep";
      source: string;
      vintage: string;
      intervalLabel: string;
      polylineCount: number;
      fallbackReason?: string;
    };
  };
  confidence:
    | ContractParcelTerrainModelAtomInstance["confidence"]
    | {
        value: number;
        kind: "asserted";
        provenance: string;
        n: number;
        intervalWidth: number;
      };
}

/**
 * Rail 1 parcel anchor as persisted by the engine.
 *
 * The contract payload carries identity and ring PROVENANCE; `txgio_parcel`
 * stays the one geometry truth frame (Geometry Law rule 1). Nothing here adds
 * a geometry body, and nothing here bolts an engine-only decline field onto the
 * instance — typed absence is already first-class on the contract shape
 * (`absence` / `verifiedAbsence`), unlike the `buildable-envelope` case.
 */
export type ParcelNodeAtomInstance = ContractParcelNodeAtomInstance &
  EnginePropertyPersistence;

/** ADR-029 building footprint as persisted by the engine (contract 1.12.0). */
export type BuildingFootprintAtomInstance = ContractBuildingFootprintAtomInstance &
  EnginePropertyPersistence;

/** ADR-029 utility easement as persisted by the engine (contract 1.12.0). */
export type UtilityEasementAtomInstance = ContractUtilityEasementAtomInstance &
  EnginePropertyPersistence;

/** FEMA NFHL flood screening fact as persisted by the engine (contract 1.14.0). */
export type FloodHazardFactAtomInstance = ContractFloodHazardFactAtomInstance &
  EnginePropertyPersistence;

/** County CAD roll attributes as persisted by the engine (contract 1.14.0). */
export type CadParcelRollAtomInstance = ContractCadParcelRollAtomInstance &
  EnginePropertyPersistence;

/** NLCD / land-cover fact as persisted by the engine (contract 1.14.0). */
export type LandUseFactAtomInstance = ContractLandUseFactAtomInstance &
  EnginePropertyPersistence;

/**
 * CAD owner identity as persisted by the engine (contract 1.16.0).
 * The one `public-paid` property atom — see PROPERTY_ENTITY_TYPES.
 */
export type OwnerFactAtomInstance = ContractOwnerFactAtomInstance &
  EnginePropertyPersistence;

/** NTAD NARN rail corridor proximity as persisted by the engine (contract 1.17.0). */
export type RailCorridorFactAtomInstance = ContractRailCorridorFactAtomInstance &
  EnginePropertyPersistence;

/** RRC surface well on/near parcel as persisted by the engine (contract 1.18.0). */
export type WellFactAtomInstance = ContractWellFactAtomInstance &
  EnginePropertyPersistence;

export type SpecialDistrictFactAtomInstance = ContractSpecialDistrictFactAtomInstance &
  EnginePropertyPersistence;

export type PropertyAtomInstance =
  | ParcelNodeAtomInstance
  | ZoningFactAtomInstance
  | SetbackRuleAtomInstance
  | BuildableEnvelopeAtomInstance
  | ParcelTerrainModelAtomInstance
  | BuildingFootprintAtomInstance
  | UtilityEasementAtomInstance
  | FloodHazardFactAtomInstance
  | CadParcelRollAtomInstance
  | LandUseFactAtomInstance
  | OwnerFactAtomInstance
  | RailCorridorFactAtomInstance
  | WellFactAtomInstance
  | SpecialDistrictFactAtomInstance;

export function isPropertyEntityType(
  value: string,
): value is PropertyEntityType {
  return (PROPERTY_ENTITY_TYPES as ReadonlyArray<string>).includes(value);
}

export function isPropertyAtomInstance(
  body: unknown,
): body is PropertyAtomInstance {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Partial<PropertyAtomInstance>;
  return (
    typeof candidate.entityType === "string" &&
    isPropertyEntityType(candidate.entityType) &&
    typeof candidate.parcelNodeId === "string" &&
    (typeof candidate.atomDid === "string" ||
      typeof candidate.entityId === "string")
  );
}

export type StoredAtomInstance =
  | CodeAtomInstance
  | PropertyAtomInstance
  | import("./road-instances.js").RoadNodeAtomInstance
  | import("./boundary-instances.js").BoundaryEdgeAtomInstance;
