import type {
  CadParcelRollAtomInstance,
  BuildingFootprintAtomInstance,
  FloodHazardFactAtomInstance,
  LandUseFactAtomInstance,
  OwnerFactAtomInstance,
  ParcelTerrainModelAtomInstance,
  RrcPipelineFactAtomInstance,
  SpecialDistrictFactAtomInstance,
  WellFactAtomInstance,
} from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import {
  composeSitePlanModelForParcel,
  type AuthorParcelSitePlanExportOptions,
} from "./author.js";
import type { TerrainArtifactStore } from "../parcel-terrain/author.js";
import { sitePlanUnavailableFromError } from "./site-plan-unavailable.js";
import type { SitePlanModel } from "./site-model.js";
import type { DischargePointResolver } from "./discharge-point.js";
import {
  runFloodDrainageStudy,
  type FloodDrainageStudy,
  type RunFloodDrainageStudyOptions,
} from "./flood-drainage-study.js";
import {
  present,
  absent,
  type FeasibilityFactState,
  type JurisdictionFacts,
  type ParcelOwnershipFacts,
  type FloodFacts,
  type SpecialDistrictFacts,
  type WellsPipelinesFacts,
  type TerrainFacts,
  type UtilityWhoServesFacts,
  type WhoServesResolver,
  type HoaFacts,
  type FootprintFacts,
  type DataQualityNote,
  type OpenItem,
  type DischargePointFacts,
} from "./feasibility-model.js";
import type {
  FirmPanelCitation,
  FloodplainAcreageFacts,
  FloodplainFactResolution,
} from "../floodplain-acreage-fact/index.js";
import type { SoilFactResult, SoilFacts } from "../soil-fact/index.js";
import type {
  ElectricProviderFacts,
  ElectricProviderResult,
  GasProviderResult,
} from "../electric-provider-fact/index.js";

/**
 * The composition root (P-120 reports re-cut, R1-R3).
 *
 * `_inbox/2026-09-07_reports_one_model_recut_WDLL.md`. ONE read of the
 * parcel, ONE geometry composition, ONE resolution of every fact family,
 * returning a model where every family carries its own present/absent state
 * with provenance — never a second derivation for a second product to
 * disagree with. `feasibility-model.ts` keeps the per-section fact TYPES
 * (`FeasibilityFactState`, `present`/`absent`, `JurisdictionFacts`, etc.) —
 * they already had exactly this shape; this file promotes the COMPOSITION
 * (previously `composeFeasibilityModel`, feasibility-only) to cover every
 * product, and adds the two things that were missing: the geometry
 * composition itself as an isolatable section (R2), and the REAL drainage
 * study in place of the `floodStudyAvailable` caller boolean (R3).
 *
 * Two-layer split, mirroring the existing `composeSitePlanModelForParcel` /
 * `authorParcelSitePlanExport` pattern in `author.ts`:
 *
 * - `composeParcelReportFacts` — geometry state + drainage state already
 *   known, does the atoms-driven half. This is what a test (or a future
 *   caller that already has a `SitePlanModel`) calls directly.
 * - `composeParcelReport` — the full orchestration: composes geometry,
 *   resolves drainage, then calls the above. This is what an author calls.
 *
 * Both are READ-ONLY. When drainage composition computes a genuinely NEW
 * study (cache miss or stale), it is returned as `freshDrainageStudy` for
 * the CALLER to persist — composition itself never writes, matching every
 * other `compose*` function in this package.
 */

// ─────────────────────────────────────────────────────────────────────────
// R2 — section-level failure isolation. A section that cannot compose
// becomes a declared absence; it never fails the document. Verified by
// violation in report-model.test.ts (each section forced to throw in turn).
// ─────────────────────────────────────────────────────────────────────────

function safeSection<T extends object>(sectionName: string, compute: () => FeasibilityFactState<T>): FeasibilityFactState<T> {
  try {
    return compute();
  } catch (error) {
    return absent<T>(
      "failed-this-run",
      `${sectionName} section failed to compose: ${error instanceof Error ? error.message : String(error)}`,
      "This section could not be produced on this run. It is a gap on our side, not a finding about the parcel.",
    );
  }
}

async function safeSectionAsync<T extends object>(
  sectionName: string,
  compute: () => Promise<FeasibilityFactState<T>>,
): Promise<FeasibilityFactState<T>> {
  try {
    return await compute();
  } catch (error) {
    return absent<T>(
      "failed-this-run",
      `${sectionName} section failed to compose: ${error instanceof Error ? error.message : String(error)}`,
      "This section could not be produced on this run. It is a gap on our side, not a finding about the parcel.",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Geometry and drainage are large composed sub-models, not small per-fact
// records, so each gets its own nested discriminated state rather than
// riding through the generic `present()/absent()` spread (which is built
// for the small `ParcelOwnershipFacts`-shaped records below).
// ─────────────────────────────────────────────────────────────────────────

export type ParcelGeometryState =
  | { status: "present"; model: SitePlanModel }
  | { status: "absent"; reason: string };

export type ParcelDrainageState =
  | { status: "present"; study: FloodDrainageStudy }
  | { status: "absent"; reason: string };

/**
 * The three fact families PR #404 shipped and nothing consumed. Injected as
 * seams rather than imported and called directly, matching this file's own
 * whoServes / dischargeResolver pattern: an interface at the boundary keeps
 * the composer testable without live NFHL, SSURGO and HIFLD calls on every
 * unit test.
 *
 * Kept as five INDEPENDENT families rather than folded into flood, terrain
 * and utilities. Floodplain acreage and the FIRM panel citation come back
 * from one resolver but can genuinely disagree on present/absent -- a parcel
 * can intersect a mapped zone while sitting on an unprinted panel -- and
 * collapsing them would force one to inherit the other's state. Grouping for
 * presentation is the renderer's job; preserving the independence is the
 * model's.
 */
export interface ParcelReportFactResolvers {
  floodplain?: (ring: ReadonlyArray<[number, number]>) => Promise<FloodplainFactResolution>;
  soil?: (point: { latitude: number; longitude: number }) => Promise<SoilFactResult>;
  electricProvider?: (point: { latitude: number; longitude: number }) => Promise<ElectricProviderResult>;
  gasProvider?: () => GasProviderResult;
}

export interface ParcelReportFacts {
  jurisdiction: JurisdictionFacts;
  parcelOwnership: FeasibilityFactState<ParcelOwnershipFacts>;
  flood: FeasibilityFactState<FloodFacts>;
  specialDistricts: FeasibilityFactState<SpecialDistrictFacts>;
  wellsPipelines: FeasibilityFactState<WellsPipelinesFacts>;
  terrain: FeasibilityFactState<TerrainFacts>;
  utilities: FeasibilityFactState<UtilityWhoServesFacts>;
  hoa: HoaFacts;
  footprint: FeasibilityFactState<FootprintFacts>;
  dischargePoint: FeasibilityFactState<DischargePointFacts>;
  floodplainAcreage: FeasibilityFactState<FloodplainAcreageFacts>;
  firmPanel: FeasibilityFactState<{ panels: ReadonlyArray<FirmPanelCitation> }>;
  soil: FeasibilityFactState<SoilFacts>;
  electricProvider: FeasibilityFactState<ElectricProviderFacts>;
  gasProvider: FeasibilityFactState<Record<string, never>>;
}

/** R5's "package layer": narrative, open items, verdict, data quality —
 * computed across every section above, never one product's own slice. */
export interface PackageLayer {
  verdict: string;
  narrativeSkeleton: string;
  openItems: ReadonlyArray<OpenItem>;
  dataQuality: DataQualityNote;
}

export interface ParcelReportModel {
  parcelNodeId: string;
  geometry: ParcelGeometryState;
  facts: ParcelReportFacts;
  drainage: ParcelDrainageState;
  package: PackageLayer;
}

// ─────────────────────────────────────────────────────────────────────────
// composeParcelReportFacts — geometry + drainage already known.
// ─────────────────────────────────────────────────────────────────────────

export interface ComposeParcelReportFactsOptions {
  parcelNodeId: string;
  storage: StoragePort;
  geometry: ParcelGeometryState;
  drainage: ParcelDrainageState;
  /** Parcel centroid for the who-serves point read. Omit to skip (honest
   * absence, never a blocking failure). */
  centroid?: { latitude: number; longitude: number };
  whoServes?: WhoServesResolver;
  /** P-120 R-04: the fact families from PR #404. An omitted resolver reports
   * out-of-scope rather than being silently skipped. */
  factResolvers?: ParcelReportFactResolvers;
  /** WGS84 exterior ring, needed for the polygon-intersection floodplain read.
   * SitePlanModel carries ringLocal and bboxWgs84 but NOT the WGS84 ring, so
   * it is threaded from whoever resolved the geometry rather than
   * back-projected out of local coordinates. */
  ringWgs84?: ReadonlyArray<[number, number]>;
  dischargeExitPoint?: { lat: number; lng: number };
  dischargeResolver?: DischargePointResolver;
}

const JURISDICTION_ACTION_SENTENCE = "Confirm city-limits and ETJ status with the county before proceeding.";
const HOA_ACTION_SENTENCE = "Search county records directly for recorded restrictions and HOA documents.";
const FIXED_ACTION_SENTENCES: Record<string, string> = {
  parcelOwnership: "Order a title or CAD roll pull to confirm ownership and value.",
  flood: "Order a site-specific flood determination before relying on this parcel's flood status.",
  specialDistricts: "Confirm special-district membership with the county tax office.",
  wellsPipelines: "Confirm well and pipeline proximity with a site survey.",
  utilities: "Request a service-availability letter from the listed utility before assuming capacity.",
  footprint: "Confirm existing structures and conformance with a site survey.",
  drainage: "Order a parcel-scoped drainage study before relying on flow or ponding conclusions for this parcel.",
};

/** Duplicated from `pdf/format.ts`'s `countyDisplayName` deliberately: the
 * composition layer must not depend on the presentation layer (`pdf/`), and
 * this is 4 lines. Same rule — a raw FIPS code is never a display name. */
function countyNameOrUnresolved(name: string | undefined | null): string | undefined {
  const s = (name ?? "").trim();
  if (s.length === 0) return undefined;
  if (/^\d{3,6}$/.test(s)) return undefined;
  return s;
}

function composeVerdict(model: Omit<ParcelReportModel, "package">, openItemCount: number): string {
  const itemsPhrase = `${openItemCount} open item${openItemCount === 1 ? "" : "s"} to resolve`;
  if (model.geometry.status === "absent") {
    return `Buildable area could not be determined for this parcel: ${model.geometry.reason}. ${itemsPhrase}.`;
  }
  const sp = model.geometry.model.summary;
  if (sp.buildableAreaSqFt == null) {
    return `Buildable area could not be determined for this parcel. ${itemsPhrase}.`;
  }
  return `${sp.buildablePdfLabel} under the facts on file. ${itemsPhrase} before proceeding.`;
}

function composeNarrativeSkeleton(model: Omit<ParcelReportModel, "package">, openItems: ReadonlyArray<OpenItem>): string {
  const paragraphs: string[] = [];
  const countyLabel = countyNameOrUnresolved(model.facts.jurisdiction.countyName) ?? "an unresolved county";

  paragraphs.push(
    `This parcel (${model.parcelNodeId}) sits in ${countyLabel}. ` +
      "City-limits and ETJ status are not yet resolved for this jurisdiction. " +
      (model.geometry.status === "present"
        ? `Zoning reads ${model.geometry.model.summary.zoningDistrict ?? "not on file"}, on a lot of ${model.geometry.model.summary.lotAreaSqFt.toLocaleString()} square feet.`
        : `Zoning and lot area could not be determined: ${model.geometry.reason}.`),
  );

  const flood = model.facts.flood;
  paragraphs.push(
    flood.status === "present"
      ? `Flood exposure: ${
          flood.floodZone ?? (flood.inSpecialFloodHazardArea ? "the parcel is in a mapped special flood hazard area" : "the parcel reads outside every mapped special flood hazard area (Zone X)")
        }` + (model.drainage.status === "present" ? ", corroborated by a site-specific drainage study on file." : ".")
      : `Flood exposure could not be determined: ${flood.reason}`,
  );

  const otherAbsences = openItems.filter((i) => i.section !== "jurisdiction" && i.section !== "hoa").map((i) => i.section);
  if (otherAbsences.length > 0) {
    paragraphs.push(
      `Open items remain in: ${otherAbsences.join(", ")}. Each is named with a specific next action in the open-items table below rather than left as a silent gap.`,
    );
  } else {
    paragraphs.push("No open items remain outside jurisdiction and HOA, which are structurally unresolved for every parcel in wave 1.");
  }

  return paragraphs.join("\n\n");
}

function composePackageLayer(model: Omit<ParcelReportModel, "package">): PackageLayer {
  const items: OpenItem[] = [];
  if (model.geometry.status === "absent") {
    items.push({
      section: "geometry",
      actionSentence: `Site geometry could not be composed for this parcel (${model.geometry.reason}); retry once resolved.`,
    });
  }
  if (model.facts.jurisdiction.cityLimitsStatus === "unresolved") {
    items.push({ section: "jurisdiction", actionSentence: JURISDICTION_ACTION_SENTENCE });
  }
  // `terrain` is excluded here on purpose: it has no independent failure mode
  // — it is 100% derived from `geometry` — so a `geometry` absence already
  // reported above would otherwise double-report the identical root cause.
  const sections: ReadonlyArray<[string, FeasibilityFactState<object> | ParcelDrainageState]> = [
    ["parcelOwnership", model.facts.parcelOwnership],
    ["flood", model.facts.flood],
    ["specialDistricts", model.facts.specialDistricts],
    ["wellsPipelines", model.facts.wellsPipelines],
    ["utilities", model.facts.utilities],
    ["footprint", model.facts.footprint],
    ["drainage", model.drainage],
  ];
  for (const [key, section] of sections) {
    if (section.status === "absent") {
      items.push({ section: key, actionSentence: FIXED_ACTION_SENTENCES[key] ?? "Confirm this fact directly with the relevant authority." });
    }
  }
  items.push({ section: "hoa", actionSentence: HOA_ACTION_SENTENCE });

  const dataQuality: DataQualityNote = {
    supersededNotes:
      model.facts.flood.status === "present" && model.drainage.status === "present"
        ? [
            "Flood determination: the parcel-scoped drainage study supersedes the statewide screening fact; the screening value is not shown as a second, independent finding.",
          ]
        : [],
  };

  return {
    verdict: composeVerdict(model, items.length),
    narrativeSkeleton: composeNarrativeSkeleton(model, items),
    openItems: items,
    dataQuality,
  };
}

export async function composeParcelReportFacts(options: ComposeParcelReportFactsOptions): Promise<ParcelReportModel> {
  const { parcelNodeId, geometry, drainage } = options;

  let atoms: Awaited<ReturnType<StoragePort["listPropertyAtomsByParcelNodeId"]>> = [];
  let atomsFetchFailureReason: string | undefined;
  try {
    atoms = await options.storage.listPropertyAtomsByParcelNodeId(parcelNodeId);
  } catch (error) {
    atomsFetchFailureReason = `Parcel atom read failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  const parcelOwnership = safeSection<ParcelOwnershipFacts>("parcelOwnership", () => {
    if (atomsFetchFailureReason) return absent("failed-this-run", atomsFetchFailureReason);
    const cadRoll = atoms.find((a): a is CadParcelRollAtomInstance => a.entityType === "cad-parcel-roll");
    const owner = atoms.find((a): a is OwnerFactAtomInstance => a.entityType === "owner-fact");
    const landUse = atoms.find((a): a is LandUseFactAtomInstance => a.entityType === "land-use-fact");
    if (!cadRoll && !owner) {
      return absent(
        "blocked-at-source",
        "The county appraisal roll carries no record for this parcel.",
        "Ownership, value and building characteristics cannot be stated. Order a title or CAD roll pull before relying on any of them.",
      );
    }
    return present<ParcelOwnershipFacts>(
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
    );
  });

  const flood = safeSection<FloodFacts>("flood", () => {
    if (atomsFetchFailureReason) return absent("failed-this-run", atomsFetchFailureReason);
    const floodAtom = atoms.find((a): a is FloodHazardFactAtomInstance => a.entityType === "flood-hazard-fact");
    if (!floodAtom) {
      return absent(
        "blocked-at-source",
        "No FEMA flood-hazard mapping covers this parcel.",
        "This is NOT a finding that the parcel is outside the floodplain. Order a site-specific flood determination before relying on flood status.",
      );
    }
    return present<FloodFacts>(
      {
        inSpecialFloodHazardArea: Boolean(floodAtom.inSpecialFloodHazardArea),
        floodZone: floodAtom.floodZone,
        baseFloodElevation: floodAtom.baseFloodElevation,
      },
      { sourceCitation: floodAtom.sourceCitation, asOfIso: floodAtom.extractedAt },
    );
  });

  const specialDistricts = safeSection<SpecialDistrictFacts>("specialDistricts", () => {
    if (atomsFetchFailureReason) return absent("failed-this-run", atomsFetchFailureReason);
    // well-fact / special-district-fact / rrc-pipeline-fact / building-footprint
    // persist an honest "checked, found nothing" row carrying an `absence`
    // field, rather than having no row at all — filtering on entityType
    // alone would read that row as a present fact.
    const districts = atoms.filter(
      (a): a is SpecialDistrictFactAtomInstance => a.entityType === "special-district-fact" && !a.absence,
    );
    if (districts.length === 0) {
      // An absence-carrying row means the source RAN and found nothing. No row
      // at all means nothing ever looked. Same empty list, opposite meanings,
      // and collapsing them is the absent/zero/unmeasured error directly.
      const checked = atoms.some((a) => a.entityType === "special-district-fact" && a.absence);
      return checked
        ? absent(
            "clear",
            "Checked against every mapped special-district boundary; this parcel falls outside all of them.",
            "No MUD, PID or special-assessment district applies, so no district levy attaches to this parcel.",
          )
        : absent(
            "blocked-at-source",
            "Special-district boundaries have not been checked for this parcel.",
            "District membership is unknown, not absent. Confirm with the county tax office.",
          );
    }
    return present<SpecialDistrictFacts>({ districts: districts.map((d) => ({ districtName: d.districtName, districtType: d.districtType })) });
  });

  const wellsPipelines = safeSection<WellsPipelinesFacts>("wellsPipelines", () => {
    if (atomsFetchFailureReason) return absent("failed-this-run", atomsFetchFailureReason);
    const wells = atoms.filter((a): a is WellFactAtomInstance => a.entityType === "well-fact" && !a.absence);
    const pipeline = atoms.find((a): a is RrcPipelineFactAtomInstance => a.entityType === "rrc-pipeline-fact" && !a.absence);
    if (wells.length === 0 && !pipeline) {
      const checked = atoms.some(
        (a) => (a.entityType === "well-fact" || a.entityType === "rrc-pipeline-fact") && a.absence,
      );
      return checked
        ? absent(
            "clear",
            "Checked against the state well and pipeline records; none intersect this parcel.",
            "No plugging, offset or pipeline-easement constraint applies from these records.",
          )
        : absent(
            "blocked-at-source",
            "State well and pipeline records have not been checked for this parcel.",
            "Confirm well and pipeline proximity with a site survey.",
          );
    }
    return present<WellsPipelinesFacts>({
      wells: wells.map((w) => ({ wellStatus: w.wellStatus, wellType: w.wellType, orphaned: w.orphaned })),
      nearPipeline: pipeline?.nearPipeline,
      nearestPipelineDistanceMeters: pipeline?.nearestPipelineDistanceMeters,
      pipelineOperatorName: pipeline?.operatorName,
    });
  });

  const footprint = safeSection<FootprintFacts>("footprint", () => {
    if (atomsFetchFailureReason) return absent("failed-this-run", atomsFetchFailureReason);
    const footprints = atoms.filter((a): a is BuildingFootprintAtomInstance => a.entityType === "building-footprint" && !a.absence);
    if (footprints.length === 0) {
      const checked = atoms.some((a) => a.entityType === "building-footprint" && a.absence);
      return checked
        ? absent(
            "clear",
            "Checked against the building-footprint source; no structure is mapped on this parcel.",
            "The site reads as unimproved, so redevelopment is unlikely to require demolition.",
          )
        : absent(
            "blocked-at-source",
            "Building-footprint mapping has not been checked for this parcel.",
            "Existing structures are unknown, not absent. Confirm with a site survey.",
          );
    }
    return present<FootprintFacts>({
      footprints: footprints.map((f) => ({ footprintId: f.footprintId, structureRole: f.structureRole, sourceTier: f.sourceTier })),
    });
  });

  const terrain = safeSection<TerrainFacts>("terrain", () => {
    if (geometry.status === "absent") {
      return absent(
        "failed-this-run",
        `Terrain facts require the parcel's composed geometry, which is unavailable: ${geometry.reason}`,
        "Elevation range and contour interval are unavailable for this run.",
      );
    }
    return present<TerrainFacts>({
      elevationRangeMeters: geometry.model.summary.elevationRangeMeters,
      contourIntervalMeters: geometry.model.contourIntervalMeters,
    });
  });

  const utilities = await safeSectionAsync<UtilityWhoServesFacts>("utilities", async () => {
    if (!options.whoServes || !options.centroid) {
      return absent(
        "failed-this-run",
        "The utility service-territory lookup did not run for this parcel.",
        "Service territory is unknown for this run. This is a gap on our side, not a finding about the parcel.",
      );
    }
    const result = await options.whoServes.resolve(options.centroid);
    return result.status === "measured"
      ? present<UtilityWhoServesFacts>({ holders: result.holders, residual: result.residual }, { asOfIso: result.asOf ?? undefined })
      : absent(
          "blocked-at-source",
          result.basis,
          "Territory holders could not be resolved. Request a service-availability letter before assuming capacity.",
        );
  });

  const dischargePoint = await safeSectionAsync<DischargePointFacts>("dischargePoint", async () => {
    if (!options.dischargeExitPoint || !options.dischargeResolver) {
      return absent(
        "out-of-scope",
        "No modeled drainage exit point was available for this parcel.",
        "The named downstream receiving water is not reported. This is a coverage limitation, not something to go confirm.",
      );
    }
    const result = await options.dischargeResolver.resolve(options.dischargeExitPoint);
    return result.status === "present"
      ? present<DischargePointFacts>({ point: result.point })
      : absent(
          "blocked-at-source",
          result.reason,
          "No county hydrography source resolves a named receiving water here.",
        );
  });

  // The PR #404 fact families, finally reaching a report.
  //
  // An omitted resolver is out-of-scope, NOT failed-this-run: the caller did
  // not ask for this family, which is a scope decision rather than a gap on
  // our side. A supplied resolver that then fails carries whichever kind the
  // resolver itself declared, which is why those results had to grow a kind
  // before this wiring could be honest.
  const notRequested = (family: string) =>
    absent<never>(
      "out-of-scope",
      family + " was not requested for this run.",
      "This family can be produced on request; nothing about this parcel prevented it.",
    );

  const floodplainResolution = await (async () => {
    if (!options.factResolvers?.floodplain || !options.ringWgs84) return null;
    try {
      return await options.factResolvers.floodplain(options.ringWgs84!);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) } as const;
    }
  })();

  const floodplainAcreage = safeSection<FloodplainAcreageFacts>("floodplainAcreage", () => {
    if (!options.factResolvers?.floodplain) return notRequested("Floodplain acreage");
    if (!options.ringWgs84) {
      return absent(
        "failed-this-run",
        "Floodplain acreage needs the parcel boundary ring, which was not supplied for this run.",
        "Acreage inside the mapped floodplain could not be measured.",
      );
    }
    if (!floodplainResolution) return notRequested("Floodplain acreage");
    if ("error" in floodplainResolution) {
      return absent("failed-this-run", "FEMA NFHL floodplain read failed: " + floodplainResolution.error);
    }
    const r = floodplainResolution.acreage;
    return r.status === "present"
      ? present<FloodplainAcreageFacts>(r.facts, {
          consequence:
            r.facts.sfhaAcres > 0
              ? r.facts.sfhaAcres.toFixed(2) +
                " of " +
                r.facts.parcelAcres.toFixed(2) +
                " acres sit inside the mapped special flood hazard area, which constrains where a structure can go and triggers federal flood-insurance requirements on a federally backed loan."
              : "No part of this parcel falls inside the mapped special flood hazard area, so no federal flood-insurance requirement attaches on that basis. This is a mapping finding, not a drainage finding.",
        })
      : absent(r.kind, r.reason);
  });

  const firmPanel = safeSection<{ panels: ReadonlyArray<FirmPanelCitation> }>("firmPanel", () => {
    if (!options.factResolvers?.floodplain) return notRequested("FIRM panel citation");
    if (!floodplainResolution || "error" in floodplainResolution) {
      return absent("failed-this-run", "The FIRM panel read did not complete for this parcel.");
    }
    const r = floodplainResolution.firmPanel;
    return r.status === "present"
      ? present<{ panels: ReadonlyArray<FirmPanelCitation> }>(
          { panels: r.panels },
          {
            consequence:
              "Cite this panel and its effective date when relying on the flood determination; a panel revision supersedes it.",
          },
        )
      : absent(r.kind, r.reason);
  });

  const soil = await safeSectionAsync<SoilFacts>("soil", async () => {
    if (!options.factResolvers?.soil || !options.centroid) return notRequested("Soil");
    const r = await options.factResolvers.soil(options.centroid);
    return r.status === "present"
      ? present<SoilFacts>(r.facts, {
          consequence:
            "Soil group and drainage class drive foundation design and on-site septic feasibility. Confirm with a geotechnical report before design.",
        })
      : absent(r.kind, r.reason);
  });

  const electricProvider = await safeSectionAsync<ElectricProviderFacts>("electricProvider", async () => {
    if (!options.factResolvers?.electricProvider || !options.centroid) return notRequested("Electric provider");
    const r = await options.factResolvers.electricProvider(options.centroid);
    return r.status === "present"
      ? present<ElectricProviderFacts>(r.facts, {
          sourceCitation: r.facts.sourceCitation,
          consequence: r.facts.ambiguous
            ? "More than one retail territory covers this point, so the serving utility is genuinely ambiguous here. Confirm with the county before assuming either."
            : "This is the retail service territory, not a service commitment. Request a service-availability letter before assuming capacity.",
        })
      : absent(r.kind, r.reason);
  });

  const gasProvider = safeSection<Record<string, never>>("gasProvider", () => {
    if (!options.factResolvers?.gasProvider) return notRequested("Gas provider");
    const r = options.factResolvers.gasProvider();
    return absent(
      r.kind,
      r.reason,
      "Gas service must be confirmed directly with the local distribution utility; no territory GIS exists to check.",
    );
  });

  const jurisdiction: JurisdictionFacts = {
    countyFips: geometry.status === "present" ? geometry.model.summary.countyFips : null,
    countyName: geometry.status === "present" ? geometry.model.summary.countyName : undefined,
    cityLimitsStatus: "unresolved",
    etjStatus: "unresolved",
  };

  const hoa: HoaFacts = { searchStatus: "not-searched" };

  const withoutPackage: Omit<ParcelReportModel, "package"> = {
    parcelNodeId,
    geometry,
    drainage,
    facts: {
      jurisdiction,
      parcelOwnership,
      flood,
      specialDistricts,
      wellsPipelines,
      terrain,
      utilities,
      floodplainAcreage,
      firmPanel,
      soil,
      electricProvider,
      gasProvider,
      hoa,
      footprint,
      dischargePoint,
    },
  };

  return { ...withoutPackage, package: composePackageLayer(withoutPackage) };
}

// ─────────────────────────────────────────────────────────────────────────
// Drainage resolution (R3) — reads the real persisted study when present and
// fresh; runs one fresh ONLY when the caller opts in. See the module doc for
// why this defaults to off: making it automatic would silently turn every
// existing Site-Plan/X-Ray/unit-test caller into a drainage-study caller,
// which is precisely the cost blowup the WDLL's own reversal criterion warns
// against. The real Feasibility route opts in explicitly.
// ─────────────────────────────────────────────────────────────────────────

/** No staleness convention exists anywhere else in this codebase for this
 * study — this is a new, explicit, reversible default (not a discovered
 * precedent) pending an operator ruling on the study's true invalidation
 * trigger (new DEM vintage, new rainfall model, etc.). */
export const DRAINAGE_STUDY_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface ReadableTerrainArtifactStore extends TerrainArtifactStore {
  get(ref: string): Promise<Uint8Array | null>;
}

export interface ResolveParcelDrainageOptions extends Omit<RunFloodDrainageStudyOptions, "parcelNodeId"> {
  parcelNodeId: string;
  storage: StoragePort;
  artifactStore: ReadableTerrainArtifactStore;
  /** Opt-in: omit/false reads only a persisted study already on file (one
   * atom lookup + one blob read, no DEM/hydrology/rainfall IO). */
  runWhenStale?: boolean;
  staleAfterMs?: number;
}

export interface ResolveParcelDrainageResult {
  state: ParcelDrainageState;
  /** Set only when a NEW study was computed this call — the caller persists
   * it (composition stays read-only, matching every other compose* here). */
  freshlyComputed?: FloodDrainageStudy;
}

export async function resolveParcelDrainage(options: ResolveParcelDrainageOptions): Promise<ResolveParcelDrainageResult> {
  const existing = (await options.storage.listPropertyAtomsByParcelNodeId(options.parcelNodeId)).find(
    (a): a is ParcelTerrainModelAtomInstance => a.entityType === "parcel-terrain-model",
  );
  const persistedArtifact = existing?.artifacts["json-flood-drainage-study"];

  if (persistedArtifact && !persistedArtifact.deferred) {
    try {
      const bytes = await options.artifactStore.get(persistedArtifact.ref);
      if (bytes) {
        const study = JSON.parse(new TextDecoder().decode(bytes)) as FloodDrainageStudy;
        const ageMs = Date.now() - Date.parse(study.generatedAt);
        const staleAfterMs = options.staleAfterMs ?? DRAINAGE_STUDY_STALE_AFTER_MS;
        if (Number.isFinite(ageMs) && ageMs <= staleAfterMs) {
          return { state: { status: "present", study } };
        }
      }
    } catch {
      // A corrupt or evicted cached blob is an honest cache miss, not a hard
      // failure — fall through to a fresh run (if permitted) or absence.
    }
  }

  if (!options.runWhenStale) {
    return {
      state: {
        status: "absent",
        reason: persistedArtifact
          ? "The persisted drainage study for this parcel is stale and a fresh run was not requested for this composition."
          : "No parcel-scoped drainage study is on file for this parcel.",
      },
    };
  }

  try {
    const { study } = await runFloodDrainageStudy(options);
    return { state: { status: "present", study }, freshlyComputed: study };
  } catch (error) {
    return {
      state: { status: "absent", reason: `Drainage study could not be run for this parcel: ${error instanceof Error ? error.message : String(error)}` },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// composeParcelReport — the full orchestrator (R1). ONE read, ONE geometry
// composition, ONE resolution of every fact family.
// ─────────────────────────────────────────────────────────────────────────

export interface ComposeParcelReportOptions extends Omit<AuthorParcelSitePlanExportOptions, "artifactStore"> {
  artifactStore: ReadableTerrainArtifactStore;
  centroidOverride?: { latitude: number; longitude: number };
  whoServes?: WhoServesResolver;
  factResolvers?: ParcelReportFactResolvers;
  dischargeExitPoint?: { lat: number; lng: number };
  dischargeResolver?: DischargePointResolver;
  /** Omit entirely to skip drainage composition (absent, zero IO cost) —
   * the default for every caller that has not asked for it. */
  drainage?: { runWhenStale?: boolean; staleAfterMs?: number } & Omit<
    RunFloodDrainageStudyOptions,
    "parcelNodeId" | "resolver" | "bboxOverride" | "ringOverride"
  >;
}

export interface ComposeParcelReportResult {
  model: ParcelReportModel;
  /** Present only when a NEW drainage study was computed this call — the
   * author layer persists it onto the shared parcel-terrain-model atom. */
  freshDrainageStudy?: FloodDrainageStudy;
}

function centroidOfRing(ringWgs84: ReadonlyArray<[number, number]>): { latitude: number; longitude: number } {
  const n = ringWgs84.length;
  let sumLng = 0;
  let sumLat = 0;
  for (const [lng, lat] of ringWgs84) {
    sumLng += lng;
    sumLat += lat;
  }
  return { longitude: sumLng / n, latitude: sumLat / n };
}

export async function composeParcelReport(options: ComposeParcelReportOptions): Promise<ComposeParcelReportResult> {
  let geometry: ParcelGeometryState;
  try {
    const composed = await composeSitePlanModelForParcel(options);
    geometry = { status: "present", model: composed.model };
  } catch (error) {
    // R2: the outage this generalises. A parcel whose geometry cannot be
    // composed no longer takes the whole report down with it.
    geometry = { status: "absent", reason: sitePlanUnavailableFromError(error).summary };
  }

  const centroid = options.centroidOverride ?? (options.ringOverride ? centroidOfRing(options.ringOverride) : undefined);

  let drainageResult: ResolveParcelDrainageResult;
  if (!options.drainage) {
    drainageResult = { state: { status: "absent", reason: "Drainage composition was not requested for this report." } };
  } else {
    const { runWhenStale, staleAfterMs, ...runOptions } = options.drainage;
    drainageResult = await resolveParcelDrainage({
      ...runOptions,
      parcelNodeId: options.parcelNodeId,
      resolver: options.resolver,
      bboxOverride: options.bboxOverride,
      ringOverride: options.ringOverride,
      storage: options.storage,
      artifactStore: options.artifactStore,
      runWhenStale,
      staleAfterMs,
    });
  }

  const model = await composeParcelReportFacts({
    ...(options.ringOverride ? { ringWgs84: options.ringOverride } : {}),
    ...(options.factResolvers ? { factResolvers: options.factResolvers } : {}),
    parcelNodeId: options.parcelNodeId,
    storage: options.storage,
    geometry,
    drainage: drainageResult.state,
    centroid,
    whoServes: options.whoServes,
    dischargeExitPoint: options.dischargeExitPoint,
    dischargeResolver: options.dischargeResolver,
  });

  return { model, freshDrainageStudy: drainageResult.freshlyComputed };
}
