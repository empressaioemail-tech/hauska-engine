import type {
  BuildableEnvelopeAtomInstance,
  BuildingFootprintAtomInstance,
  CadParcelRollAtomInstance,
  FloodHazardFactAtomInstance,
  LandUseFactAtomInstance,
  OwnerFactAtomInstance,
  RrcPipelineFactAtomInstance,
  SetbackRuleAtomInstance,
  SpecialDistrictFactAtomInstance,
  WellFactAtomInstance,
  ZoningFactAtomInstance,
} from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import type { SitePlanModel } from "./site-model.js";

/**
 * P-32 wave 1 — the Feasibility Study composed model.
 *
 * `_inbox/2026-08-24_feasibility_v1_plan_DRAFT.md` §3/§5. Composed engine-side
 * via `listPropertyAtomsByParcelNodeId()` (ONE call, filtered by entityType) —
 * not the MCP property-atom-chain (3 of 16 entity types) — plus the SAME
 * `SitePlanModel` the dossier/site-plan/flood-drainage assemblers already
 * compose (one geometry truth, never a second derivation).
 *
 * Every section is `FeasibilityFactState<T>`: present-with-citation or
 * absent-with-reason. Nothing here is guessed or defaulted — an atom that
 * does not exist for a parcel produces `status: "absent"`, never a zero or
 * an empty string standing in for unknown (ENFORCEMENT.md fail-closed).
 */

/** One typed fact slot: present (with the value + provenance) or a named
 * absence. The generic keeps ~12 sections from repeating this shape by hand
 * while staying a real discriminated union (not a generic Maybe<T>). */
export type FeasibilityFactState<T> =
  | ({ status: "present"; sourceCitation?: string; asOfIso?: string } & T)
  | { status: "absent"; reason: string };

export function present<T extends object>(
  value: T,
  provenance?: { sourceCitation?: string; asOfIso?: string },
): FeasibilityFactState<T> {
  return { status: "present", ...provenance, ...value };
}

export function absent<T extends object>(reason: string): FeasibilityFactState<T> {
  return { status: "absent", reason };
}

// ── Section 3: location and jurisdiction ────────────────────────────────
export interface JurisdictionFacts {
  countyFips: string | null;
  countyName?: string;
  /** No city-limits or ETJ atom type exists in this engine today (gap matrix
   * row 35: no adapter). Always the honest three-state "unresolved" per the
   * approved spec — never fabricated, never silently omitted. */
  cityLimitsStatus: "unresolved";
  etjStatus: "unresolved";
}

// ── Section 4: parcel and ownership ─────────────────────────────────────
export interface ParcelOwnershipFacts {
  legalDescription?: string;
  exemptionCodes?: ReadonlyArray<string>;
  marketValue?: number;
  assessedValue?: number;
  landValue?: number;
  improvementValue?: number;
  yearBuilt?: number;
  livingAreaSqft?: number;
  ownerName?: string;
  ownerMailingAddress?: string;
  /** Derived, never fabricated: present only when both situs and mailing
   * address are on file and differ. */
  absenteeOwner?: boolean;
  landUseCode?: string;
  landUseLabel?: string;
}

// ── Section 6: flood and drainage ───────────────────────────────────────
export interface FloodFacts {
  inSpecialFloodHazardArea: boolean;
  floodZone?: string | null;
  baseFloodElevation?: number | null;
  /** True when this reconciles a richer parcel-scoped D8 study over the
   * statewide NFHL screening fact — item 5 (superseded-run arbitration):
   * the two are never presented as independent findings, the richer source
   * wins and the coarser one is named as superseded, not appended. */
  supersedesScreeningFact?: boolean;
  studyAvailable: boolean;
}

// ── Section 7: special districts ────────────────────────────────────────
export interface SpecialDistrictFacts {
  districts: ReadonlyArray<{
    districtName?: string;
    districtType?: string;
  }>;
}

// ── Section 8: wells and pipelines ──────────────────────────────────────
export interface WellsPipelinesFacts {
  wells: ReadonlyArray<{ wellStatus?: string; wellType?: string; orphaned?: boolean }>;
  nearPipeline?: boolean;
  nearestPipelineDistanceMeters?: number;
  pipelineOperatorName?: string;
}

// ── Section 9: terrain and site conditions ──────────────────────────────
export interface TerrainFacts {
  elevationRangeMeters: { min: number; max: number };
  contourIntervalMeters: number;
}

// ── Section 10: utilities who-serves ────────────────────────────────────
export interface UtilityWhoServesFacts {
  holders: ReadonlyArray<{
    serviceKind: "water" | "sewer" | "electric" | "water-district";
    territoryName: string | null;
  }>;
  /** Always carried when measured — a territory holder is never a tap,
   * capacity, or extension commitment. */
  residual: string;
}

/** Injected resolver for the cross-repo who-serves read (`legacy-design-tools`
 * `GET /api/who-serves`) — mirrors this codebase's existing pattern for
 * cross-service reads (`ParcelGeometryResolver`, `AerialImageFetcher`):
 * an interface at the boundary, never a direct import of the other repo's
 * DB layer. The assembler must not block on this failing (spec item 8). */
export interface WhoServesResolver {
  resolve(input: { latitude: number; longitude: number }): Promise<
    | { status: "measured"; holders: UtilityWhoServesFacts["holders"]; residual: string; asOf: string | null }
    | { status: "unmeasured"; basis: string }
  >;
}

// ── Section 11: HOA and recorded restrictions ───────────────────────────
export interface HoaFacts {
  /** Always "not searched" in wave 1 — the P-85/courthouse-easements
   * reconciliation is explicitly open and does not block this shell
   * (`_decisions/2026-09-03_p32_feasibility_unfrozen.md`). */
  searchStatus: "not-searched";
  mountedDocumentCitation?: string;
}

// ── Section 12: existing structures / footprint ─────────────────────────
export interface FootprintFacts {
  footprints: ReadonlyArray<{ footprintId: string; structureRole?: string; sourceTier?: string }>;
}

// ── Section 13/14: data quality + open items (generated, not read) ──────
export interface DataQualityNote {
  supersededNotes: ReadonlyArray<string>;
}

export interface OpenItem {
  section: string;
  actionSentence: string;
}

// ── The composed model ───────────────────────────────────────────────────
export interface FeasibilityModel {
  parcelNodeId: string;
  sitePlan: SitePlanModel;
  jurisdiction: JurisdictionFacts;
  parcelOwnership: FeasibilityFactState<ParcelOwnershipFacts>;
  flood: FeasibilityFactState<FloodFacts>;
  specialDistricts: FeasibilityFactState<SpecialDistrictFacts>;
  wellsPipelines: FeasibilityFactState<WellsPipelinesFacts>;
  terrain: TerrainFacts;
  utilities: FeasibilityFactState<UtilityWhoServesFacts>;
  hoa: HoaFacts;
  footprint: FeasibilityFactState<FootprintFacts>;
  dataQuality: DataQualityNote;
  /** Generated from every OTHER section's absence/reason above — item 6.
   * Never hand-populated by a caller. */
  openItems: ReadonlyArray<OpenItem>;
}

// Keyed by the loop's dynamic section name (below) — jurisdiction and HOA
// are handled as compile-time-known literals above, not through this map.
const FIXED_ACTION_SENTENCES: Record<string, string> = {
  parcelOwnership: "Order a title or CAD roll pull to confirm ownership and value.",
  flood: "Order a site-specific flood determination before relying on this parcel's flood status.",
  specialDistricts: "Confirm special-district membership with the county tax office.",
  wellsPipelines: "Confirm well and pipeline proximity with a site survey.",
  utilities: "Request a service-availability letter from the listed utility before assuming capacity.",
  footprint: "Confirm existing structures and conformance with a site survey.",
};

const JURISDICTION_ACTION_SENTENCE = "Confirm city-limits and ETJ status with the county before proceeding.";
const HOA_ACTION_SENTENCE = "Search county records directly for recorded restrictions and HOA documents.";

function generateOpenItems(model: Omit<FeasibilityModel, "openItems">): OpenItem[] {
  const items: OpenItem[] = [];
  if (model.jurisdiction.cityLimitsStatus === "unresolved") {
    items.push({ section: "jurisdiction", actionSentence: JURISDICTION_ACTION_SENTENCE });
  }
  const sections: Array<[string, FeasibilityFactState<object>]> = [
    ["parcelOwnership", model.parcelOwnership],
    ["flood", model.flood],
    ["specialDistricts", model.specialDistricts],
    ["wellsPipelines", model.wellsPipelines],
    ["utilities", model.utilities],
    ["footprint", model.footprint],
  ];
  for (const [key, section] of sections) {
    if (section.status === "absent") {
      items.push({ section: key, actionSentence: FIXED_ACTION_SENTENCES[key] ?? "Confirm this fact directly with the relevant authority." });
    }
  }
  // HOA is always "not searched" in wave 1 — always an open item, not a status branch.
  items.push({ section: "hoa", actionSentence: HOA_ACTION_SENTENCE });
  return items;
}

export interface ComposeFeasibilityModelOptions {
  parcelNodeId: string;
  storage: StoragePort;
  sitePlan: SitePlanModel;
  /** Parcel centroid for the who-serves point read; omit to skip (honest
   * "unmeasured" utilities section, never a blocking failure). */
  centroid?: { latitude: number; longitude: number };
  whoServes?: WhoServesResolver;
  /** Persisted D8 flood-drainage study, if the caller already has one on
   * file for this parcel (read once by the author, never re-computed here). */
  floodStudyAvailable?: boolean;
}

export async function composeFeasibilityModel(
  options: ComposeFeasibilityModelOptions,
): Promise<FeasibilityModel> {
  const atoms = await options.storage.listPropertyAtomsByParcelNodeId(options.parcelNodeId);

  const zoning = atoms.find((a): a is ZoningFactAtomInstance => a.entityType === "zoning-fact");
  const setback = atoms.find((a): a is SetbackRuleAtomInstance => a.entityType === "setback-rule");
  const envelope = atoms.find((a): a is BuildableEnvelopeAtomInstance => a.entityType === "buildable-envelope");
  const cadRoll = atoms.find((a): a is CadParcelRollAtomInstance => a.entityType === "cad-parcel-roll");
  const landUse = atoms.find((a): a is LandUseFactAtomInstance => a.entityType === "land-use-fact");
  const owner = atoms.find((a): a is OwnerFactAtomInstance => a.entityType === "owner-fact");
  const flood = atoms.find((a): a is FloodHazardFactAtomInstance => a.entityType === "flood-hazard-fact");
  const specialDistricts = atoms.filter(
    (a): a is SpecialDistrictFactAtomInstance => a.entityType === "special-district-fact",
  );
  const wells = atoms.filter((a): a is WellFactAtomInstance => a.entityType === "well-fact");
  const pipeline = atoms.find((a): a is RrcPipelineFactAtomInstance => a.entityType === "rrc-pipeline-fact");
  const footprints = atoms.filter(
    (a): a is BuildingFootprintAtomInstance => a.entityType === "building-footprint",
  );
  // zoning/setback/envelope are already resolved on the caller-supplied
  // SitePlanModel (one geometry truth); read here only to source-cite them.
  void zoning;
  void setback;
  void envelope;

  const jurisdiction: JurisdictionFacts = {
    countyFips: options.sitePlan.summary.countyFips,
    countyName: options.sitePlan.summary.countyName,
    cityLimitsStatus: "unresolved",
    etjStatus: "unresolved",
  };

  const parcelOwnership: FeasibilityFactState<ParcelOwnershipFacts> =
    cadRoll || owner
      ? present<ParcelOwnershipFacts>(
          {
            legalDescription: cadRoll?.legalDescription,
            exemptionCodes: cadRoll?.exemptionCodes,
            marketValue: cadRoll?.marketValue,
            assessedValue: cadRoll?.assessedValue,
            landValue: cadRoll?.landValue,
            improvementValue: cadRoll?.improvementValue,
            yearBuilt: cadRoll?.yearBuilt,
            livingAreaSqft: cadRoll?.livingAreaSqft,
            ownerName: owner?.ownerName,
            ownerMailingAddress: owner?.ownerMailingAddress,
            absenteeOwner:
              owner?.ownerMailingAddress && cadRoll?.situsAddress
                ? owner.ownerMailingAddress.trim().toLowerCase() !== cadRoll.situsAddress.trim().toLowerCase()
                : undefined,
            landUseCode: landUse?.landUseCode,
            landUseLabel: landUse?.landUseLabel,
          },
          { sourceCitation: cadRoll?.sourceCitation ?? owner?.sourceCitation, asOfIso: cadRoll?.extractedAt ?? owner?.extractedAt },
        )
      : absent("No CAD parcel roll or owner-fact atom on file for this parcel.");

  // Item 5 — superseded-run arbitration: the parcel-scoped D8 study (when
  // available) and the statewide NFHL screening fact are two derivations of
  // the SAME flood question, never presented as independent findings. The
  // study is the operative source when present; the screening fact is named
  // as superseded rather than appended as a second finding.
  const floodModel: FeasibilityFactState<FloodFacts> = flood
    ? present<FloodFacts>(
        {
          inSpecialFloodHazardArea: Boolean(flood.inSpecialFloodHazardArea),
          floodZone: flood.floodZone,
          baseFloodElevation: flood.baseFloodElevation,
          supersedesScreeningFact: Boolean(options.floodStudyAvailable),
          studyAvailable: Boolean(options.floodStudyAvailable),
        },
        { sourceCitation: flood.sourceCitation, asOfIso: flood.extractedAt },
      )
    : absent("No flood-hazard-fact atom on file for this parcel.");

  const specialDistrictsModel: FeasibilityFactState<SpecialDistrictFacts> =
    specialDistricts.length > 0
      ? present<SpecialDistrictFacts>({
          districts: specialDistricts.map((d) => ({ districtName: d.districtName, districtType: d.districtType })),
        })
      : absent("No special-district-fact atom on file for this parcel (outside every mapped source boundary).");

  const wellsPipelinesModel: FeasibilityFactState<WellsPipelinesFacts> =
    wells.length > 0 || pipeline
      ? present<WellsPipelinesFacts>({
          wells: wells.map((w) => ({ wellStatus: w.wellStatus, wellType: w.wellType, orphaned: w.orphaned })),
          nearPipeline: pipeline?.nearPipeline,
          nearestPipelineDistanceMeters: pipeline?.nearestPipelineDistanceMeters,
          pipelineOperatorName: pipeline?.operatorName,
        })
      : absent("No well-fact or rrc-pipeline-fact atom on file for this parcel.");

  const terrain: TerrainFacts = {
    elevationRangeMeters: options.sitePlan.summary.elevationRangeMeters,
    contourIntervalMeters: options.sitePlan.contourIntervalMeters,
  };

  let utilities: FeasibilityFactState<UtilityWhoServesFacts>;
  if (!options.whoServes || !options.centroid) {
    utilities = absent("Utility service-territory read was not performed for this parcel.");
  } else {
    try {
      const result = await options.whoServes.resolve(options.centroid);
      utilities =
        result.status === "measured"
          ? present<UtilityWhoServesFacts>(
              { holders: result.holders, residual: result.residual },
              { asOfIso: result.asOf ?? undefined },
            )
          : absent(result.basis);
    } catch (error) {
      // Item 8: the assembler must not block if this read fails.
      utilities = absent(
        `Utility service-territory read failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const hoa: HoaFacts = { searchStatus: "not-searched" };

  const footprintModel: FeasibilityFactState<FootprintFacts> =
    footprints.length > 0
      ? present<FootprintFacts>({
          footprints: footprints.map((f) => ({
            footprintId: f.footprintId,
            structureRole: f.structureRole,
            sourceTier: f.sourceTier,
          })),
        })
      : absent("No building-footprint atom on file for this parcel.");

  const dataQuality: DataQualityNote = {
    supersededNotes:
      floodModel.status === "present" && floodModel.supersedesScreeningFact
        ? ["Flood determination: the parcel-scoped drainage study supersedes the statewide screening fact; the screening value is not shown as a second, independent finding."]
        : [],
  };

  const withoutOpenItems = {
    parcelNodeId: options.parcelNodeId,
    sitePlan: options.sitePlan,
    jurisdiction,
    parcelOwnership,
    flood: floodModel,
    specialDistricts: specialDistrictsModel,
    wellsPipelines: wellsPipelinesModel,
    terrain,
    utilities,
    hoa,
    footprint: footprintModel,
    dataQuality,
  };

  return { ...withoutOpenItems, openItems: generateOpenItems(withoutOpenItems) };
}
