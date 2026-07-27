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
  BuildableEnvelopeAtomInstance as ContractBuildableEnvelopeAtomInstance,
  ParcelTerrainModelAtomInstance as ContractParcelTerrainModelAtomInstance,
  SetbackMatchBasis,
  SetbackRuleAtomInstance as ContractSetbackRuleAtomInstance,
  TerrainExportFormat as ContractTerrainExportFormat,
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
} from "@empressaio/atom-contract/property";

export type PropertyEntityType =
  | "zoning-fact"
  | "setback-rule"
  | "buildable-envelope"
  | "parcel-terrain-model";

export const PROPERTY_ENTITY_TYPES: ReadonlyArray<PropertyEntityType> = [
  "zoning-fact",
  "setback-rule",
  "buildable-envelope",
  "parcel-terrain-model",
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
  };

export type SetbackRuleAtomInstance = ContractSetbackRuleAtomInstance &
  EnginePropertyPersistence & {
    districtCode?: string;
    prefixMatched?: string;
    sideCornerFt?: number;
    maxHeightFt?: number;
    maxLotCoveragePct?: number;
    maxImperviousPct?: number;
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
  | "pdf-site-plan";

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
        annotationCount?: number;
        /** pdf-site-plan only: page count and honesty flags for the summary block. */
        pageCount?: number;
        zoningHonestAbsence?: boolean;
        floodZoneHonestUnavailable?: boolean;
      }
    >
  >;
  coverage: {
    coverageFraction: number;
    nodataCount: number;
    totalCells: number;
    resolutionMetersRequested: number | null;
    resolutionMetersActual: number | null;
    touchesNodata: boolean;
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

export type PropertyAtomInstance =
  | ZoningFactAtomInstance
  | SetbackRuleAtomInstance
  | BuildableEnvelopeAtomInstance
  | ParcelTerrainModelAtomInstance;

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
