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
  type AbsenceKind,
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
import {
  recordCityLimitsDisposition,
  recordScalarNumber,
  recordSpecialDistrictNames,
  type ParcelRecordResponse,
  type RecordReaderClient,
} from "./parcel-record-reader-client.js";

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
/**
 * Per-read budget for the three live outbound fact reads. Deliberately well
 * under a customer's patience: the point is that a slow source degrades ONE
 * family honestly rather than holding the whole document.
 */
export const DEFAULT_FACT_READ_TIMEOUT_MS = 8_000;

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
  /** Override the per-read budget. Tests use a small value to assert the
   * timeout path without waiting on it. */
  factReadTimeoutMs?: number;
  dischargeExitPoint?: { lat: number; lng: number };
  dischargeResolver?: DischargePointResolver;
  /** Set by composeParcelReport when dischargeExitPoint ended up undefined
   * for a reason more specific than "not requested" -- see dischargePoint's
   * own section below for why this matters. */
  dischargeUnavailableReason?: { kind: AbsenceKind; reason: string };
  /**
   * P152-RAILS (OPS-23 P-152 lane 3): the Hauska retrieval service reader —
   * the SAME `/property-nodes/:id/record` the Property Explorer panel and
   * cortex already consume (R-6, one reader). Omit to skip (honest
   * unresolved/absent, same shape as every other optional resolver here —
   * never a blocking failure). See `recordReaderFromEnv` for how the caller
   * builds this from `RETRIEVAL_API_URL`/`RETRIEVAL_API_KEY`, which are NOT
   * mounted on hauska-engine-api in production as of this lane's close.
   */
  recordReader?: RecordReaderClient;
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
  const printed = model.geometry.model.summary.printedBuildable;
  // P-159 / Ruling B: the verdict is the FIRST place a reader (and, via
  // `narrative-section-client.ts`'s `verdict` field, the narrative-generating
  // model) sees a buildable-area claim. It must say exactly what every other
  // surface says — one atom-backed figure, or a declared refusal — never the
  // locally-derived offset-ring number `buildablePdfLabel` used to prefer.
  return printed.kind === "atom"
    ? `${Math.round(printed.areaSqFt).toLocaleString("en-US")} sq ft of buildable area under the facts on file. ${itemsPhrase} before proceeding.`
    : `Buildable area is refused: ${printed.reason}. ${itemsPhrase}.`;
}

/**
 * Evidence from the appraisal roll (a DIFFERENT source than the building-footprint
 * layer) that a parcel carries a structure. `FootprintFacts` carries a LIST of
 * mapped structures and no area at all, so a footprint miss says only that one GIS
 * layer has no polygon here; a year built or a living area on the CAD roll is
 * direct evidence of a building from an entirely separate party.
 *
 * Lives here (composition layer), not in `pdf/feasibility.ts` (presentation),
 * because P-159 needs the SAME check to gate what the narrative-generation payload
 * says about the parcel's structures — a presentation-layer import from this
 * module's own composer would invert the dependency direction this file's header
 * comment already declares (composition must not depend on `pdf/`).
 * `pdf/feasibility.ts` re-exports this rather than redefining it.
 */
export function improvementEvidence(
  model: ParcelReportModel,
): { summary: string; yearBuilt?: number; livingAreaSqft?: number } | null {
  const po = model.facts.parcelOwnership;
  if (po.status !== "present") return null;
  const { yearBuilt, livingAreaSqft } = po;
  const hasArea = typeof livingAreaSqft === "number" && livingAreaSqft > 0;
  const hasYear = typeof yearBuilt === "number" && yearBuilt > 0;
  if (!hasArea && !hasYear) return null;
  const parts: string[] = [];
  if (hasArea) parts.push(`${Math.round(livingAreaSqft!).toLocaleString("en-US")} sq ft of living area`);
  if (hasYear) parts.push(`a structure built in ${yearBuilt}`);
  return {
    summary: parts.join(" and "),
    ...(hasYear ? { yearBuilt } : {}),
    ...(hasArea ? { livingAreaSqft } : {}),
  };
}

/** True when the footprint layer reports nothing AND the appraisal roll says the
 * parcel is improved. Named because more than one place must react to it — the
 * facts page (via `attachConsequences`) and, since P-159, the narrative-generation
 * payload (`narrative-section-client.ts`). */
export function footprintContradictsAppraisal(model: ParcelReportModel): boolean {
  return model.facts.footprint.status !== "present" && improvementEvidence(model) !== null;
}

/**
 * The ONE sentence every consumer of a contradicted footprint state must use —
 * the facts page's consequence row and, since P-159, the narrative payload's
 * footprint fact. Returns null when the contradiction does not fire, so a caller
 * can tell "nothing to override" from "override to this text" without re-deriving
 * either check itself (never a second copy of this wording).
 */
export function footprintContradictionConsequence(model: ParcelReportModel): string | null {
  if (!footprintContradictsAppraisal(model)) return null;
  const evidence = improvementEvidence(model);
  if (!evidence) return null;
  return (
    `Sources disagree. The building-footprint layer maps no structure, while county appraisal records carry ` +
    `${evidence.summary}. Do not treat this parcel as vacant: confirm what is standing with a site visit or ` +
    "survey before any demolition, valuation or yield assumption."
  );
}

/** Sheet-2 / narrative-skeleton sentence on the lot's structures (P-159 item 5):
 * never "absent" when the footprint layer's miss is contradicted by the appraisal
 * roll, and never "absent" when the footprint fact itself was merely unchecked
 * (`blocked-at-source`) — only a genuine, uncontradicted `clear` miss reads as
 * unimproved. Shared by the deterministic skeleton AND, since the same honesty
 * rule applies to whatever the generated narrative is allowed to say, available
 * for the same purpose there. */
function composeStructuresSentence(model: Omit<ParcelReportModel, "package">): string {
  const contradiction = footprintContradictionConsequence(model as ParcelReportModel);
  if (contradiction) return contradiction;
  const fp = model.facts.footprint;
  if (fp.status === "present") {
    const count = fp.footprints.length;
    return `Structures on file: ${count} mapped footprint${count === 1 ? "" : "s"}.`;
  }
  return fp.consequence ?? "Existing structures are unresolved for this parcel; confirm with a site survey.";
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

  paragraphs.push(composeStructuresSentence(model));

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

  const specialDistrictsDisagreement =
    model.facts.specialDistricts.status === "present" &&
    model.facts.specialDistricts.substrateOnlyDistricts &&
    model.facts.specialDistricts.substrateOnlyDistricts.length > 0
      ? `Special districts: the Hauska retrieval reader names ${model.facts.specialDistricts.districts
          .map((d) => d.districtName)
          .filter(Boolean)
          .join(", ") || "no district"}; this engine's own TCEQ-sourced records separately name ${model.facts.specialDistricts.substrateOnlyDistricts.join(
          ", ",
        )}. Both are shown; neither is discarded (P152-RAILS item 7 — not resolved here).`
      : null;

  const dataQuality: DataQualityNote = {
    supersededNotes: [
      ...(model.facts.flood.status === "present" && model.drainage.status === "present"
        ? [
            "Flood determination: the parcel-scoped drainage study supersedes the statewide screening fact; the screening value is not shown as a second, independent finding.",
          ]
        : []),
      ...(specialDistrictsDisagreement ? [specialDistrictsDisagreement] : []),
    ],
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

  // P152-RAILS: `readBudgetMs` MUST be initialized before the first call to
  // `bounded` below -- `bounded` is a hoisted function DECLARATION (its name
  // is usable from anywhere in this function body), but it closes over the
  // `const readBudgetMs` binding from the ENCLOSING scope, and a `const` is
  // NOT initialized just because the function that reads it is hoisted.
  // Calling `bounded` before this line executes throws "Cannot access
  // 'readBudgetMs' before initialization" INSIDE the Promise executor that
  // arms the timeout race -- the Promise constructor swallows that throw and
  // turns it into an already-rejected promise, which then wins Promise.race
  // against the real fetch almost every time in production (a real network
  // call takes real wall-clock time; the TDZ rejection is next-microtask
  // instant). This was a genuine live defect (found via a fresh production
  // probe on 48453:474034, 2026-09-12: the reader was reachable, authenticated,
  // and returned correct record-served data, but composeParcelReportFacts's
  // output reflected none of it) that this file's own unit tests did not
  // catch, because every fake `recordReader.fetchRecord` in this package's
  // tests resolves with no real `await` inside -- exactly as instant as the
  // TDZ rejection, so simple Promise.race MICROTASK REGISTRATION ORDER (the
  // real fetch's `.then` is attached first, inside the `Promise.race` array
  // literal, ahead of the timeout branch) let the fake reader win the race
  // every time regardless of the bug. A test that cannot fail for the right
  // reason (DEV_PROCESS 2.2) -- see the new delayed-fake-reader regression
  // test below this function for the fix that actually exercises this path.
  const readBudgetMs = options.factReadTimeoutMs ?? DEFAULT_FACT_READ_TIMEOUT_MS;

  async function bounded<T>(
    label: string,
    run: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} exceeded the ${readBudgetMs}ms read budget`)),
            readBudgetMs,
          );
        }),
      ]);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // P152-RAILS: fetched EARLY (ahead of parcelOwnership/specialDistricts/
  // jurisdiction below, which are computed synchronously via safeSection)
  // rather than alongside the later floodplain/soil/electric Promise.all.
  // Any failure (timeout, non-2xx, invalid JSON, or a whole-parcel refusal)
  // leaves `record` null and every composer below falls back to its existing
  // substrate-atom / constant path -- never a crash, never a fabricated
  // record value (same "declared, never silent" posture as hauska-map's own
  // outage handling, P152-RAILS item 3 -- this read simply has no wire
  // surface of its own to declare the outage on, since the ENGINE'S existing
  // fallback already IS an honest, independently-sourced absence, not a copy
  // of a stale value).
  const recordFetch = options.recordReader
    ? await bounded("parcel_record reader read", () => options.recordReader!.fetchRecord(parcelNodeId))
    : null;
  const record: ParcelRecordResponse | null =
    recordFetch && recordFetch.ok && recordFetch.value.ok && !recordFetch.value.record.refused
      ? recordFetch.value.record
      : null;

  const parcelOwnership = safeSection<ParcelOwnershipFacts>("parcelOwnership", () => {
    if (atomsFetchFailureReason) return absent("failed-this-run", atomsFetchFailureReason);
    const cadRoll = atoms.find((a): a is CadParcelRollAtomInstance => a.entityType === "cad-parcel-roll");
    const owner = atoms.find((a): a is OwnerFactAtomInstance => a.entityType === "owner-fact");
    const landUse = atoms.find((a): a is LandUseFactAtomInstance => a.entityType === "land-use-fact");

    // P152-RAILS: the reader wins per-field, over the substrate cad-parcel-
    // roll atom, for exactly the rails it slates "record" for this county --
    // never a wider override, matching hauska-map's own per-rail pattern.
    // This is what fixes FS-48453-474034 (values UNAVAILABLE beside the
    // card's dollars): that parcel has no cad-parcel-roll atom in the
    // engine's substrate store, but its marketValue/assessedValue rails ARE
    // slated "record" (wave-3 verify doc B6), so the reader alone can now
    // make this section present where the substrate atom never could.
    const marketValue = recordScalarNumber(record?.rails.marketValue) ?? cadRoll?.marketValue;
    const assessedValue = recordScalarNumber(record?.rails.assessedValue) ?? cadRoll?.assessedValue;
    const landValue = recordScalarNumber(record?.rails.landValue) ?? cadRoll?.landValue;
    const improvementValue = recordScalarNumber(record?.rails.improvementValue) ?? cadRoll?.improvementValue;
    const yearBuilt = recordScalarNumber(record?.rails.yearBuilt) ?? cadRoll?.yearBuilt;
    const livingAreaSqft = recordScalarNumber(record?.rails.livingAreaSqft) ?? cadRoll?.livingAreaSqft;
    const recordSuppliedAnything =
      marketValue !== undefined ||
      assessedValue !== undefined ||
      landValue !== undefined ||
      improvementValue !== undefined ||
      yearBuilt !== undefined ||
      livingAreaSqft !== undefined;

    if (!cadRoll && !owner && !recordSuppliedAnything) {
      return absent(
        "blocked-at-source",
        "The county appraisal roll carries no record for this parcel.",
        "Ownership, value and building characteristics cannot be stated. Order a title or CAD roll pull before relying on any of them.",
      );
    }
    const usedRecordForAnyField =
      recordScalarNumber(record?.rails.marketValue) !== undefined ||
      recordScalarNumber(record?.rails.assessedValue) !== undefined ||
      recordScalarNumber(record?.rails.landValue) !== undefined ||
      recordScalarNumber(record?.rails.improvementValue) !== undefined ||
      recordScalarNumber(record?.rails.yearBuilt) !== undefined ||
      recordScalarNumber(record?.rails.livingAreaSqft) !== undefined;
    return present<ParcelOwnershipFacts>(
      {
        legalDescription: cadRoll?.legalDescription,
        exemptionCodes: cadRoll?.exemptionCodes,
        marketValue,
        assessedValue,
        landValue,
        improvementValue,
        yearBuilt,
        livingAreaSqft,
        ownerName: owner?.ownerName,
        ownerMailingAddress: owner?.ownerMailingAddress,
        absenteeOwner:
          owner?.ownerMailingAddress && cadRoll?.situsAddress
            ? owner.ownerMailingAddress.trim().toLowerCase() !== cadRoll.situsAddress.trim().toLowerCase()
            : undefined,
        landUseCode: landUse?.landUseCode,
        landUseLabel: landUse?.landUseLabel,
      },
      {
        sourceCitation: usedRecordForAnyField
          ? cadRoll?.sourceCitation
            ? `parcel_record (Hauska retrieval reader), supplementing the county appraisal roll (${cadRoll.sourceCitation})`
            : "parcel_record (Hauska retrieval reader)"
          : cadRoll?.sourceCitation ?? owner?.sourceCitation,
        asOfIso: cadRoll?.extractedAt ?? owner?.extractedAt ?? record?.readAt,
      },
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
    const substrateDistricts = atoms.filter(
      (a): a is SpecialDistrictFactAtomInstance => a.entityType === "special-district-fact" && !a.absence,
    );

    // P152-RAILS item 7: the reader's specialDistricts rail wins when it
    // serves "record" for this parcel -- the SAME precedence every other
    // rail in this program applies (R-6). The substrate TCEQ atoms are never
    // discarded: when they name a district the reader's list does not,
    // that's reported on `substrateOnlyDistricts`, not silently dropped
    // (dispatch item 7: "a disagreement... is reported... not resolved
    // here").
    const recordDistrictNames = recordSpecialDistrictNames(record?.rails.specialDistricts);
    if (recordDistrictNames && recordDistrictNames.length > 0) {
      const substrateNames = substrateDistricts.map((d) => d.districtName).filter((n): n is string => !!n);
      const recordSet = new Set(recordDistrictNames.map((n) => n.trim().toLowerCase()));
      const substrateOnly = substrateNames.filter((n) => !recordSet.has(n.trim().toLowerCase()));
      return present<SpecialDistrictFacts>(
        {
          districts: recordDistrictNames.map((districtName) => ({ districtName })),
          ...(substrateOnly.length > 0 ? { substrateOnlyDistricts: substrateOnly } : {}),
        },
        { sourceCitation: "parcel_record (Hauska retrieval reader)", asOfIso: record?.readAt },
      );
    }

    if (substrateDistricts.length === 0) {
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
    return present<SpecialDistrictFacts>({
      districts: substrateDistricts.map((d) => ({ districtName: d.districtName, districtType: d.districtType })),
    });
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
      // Not "failed-this-run": nothing was reached and nothing failed. A
      // missing whoServes resolver is a caller decision, the same shape as
      // an omitted factResolvers entry (notRequested() below) -- previously
      // mislabeled as our own failure, which is exactly the shape the
      // 2026-09-09 operator ruling forbids surfacing to a customer.
      return absent(
        "out-of-scope",
        "Utility service-territory lookup was not requested for this run.",
        "This family can be produced on request; nothing about this parcel prevented it.",
      );
    }
    const result = await options.whoServes.resolve(options.centroid);
    return result.status === "measured"
      ? present<UtilityWhoServesFacts>({ holders: result.holders, residual: result.residual }, { asOfIso: result.asOf ?? undefined })
      : absent(
          // A resolver that threw/timed out failed THIS run, ours; a
          // resolver that ran cleanly and found no coverage is an honest
          // declared absence. Collapsing both into blocked-at-source (the
          // previous unconditional behavior) would misreport a live outage
          // as a permanent finding about the parcel.
          result.kind ?? "blocked-at-source",
          result.basis,
          "Territory holders could not be resolved. Request a service-availability letter before assuming capacity.",
        );
  });

  const dischargePoint = await safeSectionAsync<DischargePointFacts>("dischargePoint", async () => {
    if (!options.dischargeExitPoint || !options.dischargeResolver) {
      // "Not requested" is the right story only when nothing was ever
      // attempted. composeParcelReport sets dischargeUnavailableReason when
      // it knows better: the drainage study genuinely ran and modeled zero
      // flow exits (a real, checked finding -- blocked-at-source, not a
      // scope decision), or the study itself failed to compute this run
      // (failed-this-run -- ours, not the parcel's).
      const fallback = options.dischargeUnavailableReason;
      return absent(
        fallback?.kind ?? "out-of-scope",
        fallback?.reason ?? "No modeled drainage exit point was available for this parcel.",
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
  // Latency budget, added after the 2026-09-08 canary measured 82.9s against
  // production's 6.4s on the same parcel. Three live outbound reads on a path
  // a customer waits on synchronously, run one after another, is not a
  // deployable shape however correct each read is.
  //
  // Two changes: the three run CONCURRENTLY rather than serially, and each is
  // bounded. A source that hangs now costs the budget once rather than the
  // whole report, and a source that exceeds it reports `failed-this-run` --
  // which is true, ours, and never mistakable for a finding about the parcel.
  // (`readBudgetMs` and `bounded` itself now declared earlier in this
  // function, ahead of the P152-RAILS record fetch that also needs them --
  // see that declaration's own comment for why moving it was the fix for a
  // real live defect.)

  const notRequested = (family: string) =>
    absent<never>(
      "out-of-scope",
      family + " was not requested for this run.",
      "This family can be produced on request; nothing about this parcel prevented it.",
    );

  const [floodplainSettled, soilSettled, electricSettled] = await Promise.all([
    options.factResolvers?.floodplain && options.ringWgs84
      ? bounded("FEMA NFHL floodplain read", () =>
          options.factResolvers!.floodplain!(options.ringWgs84!),
        )
      : Promise.resolve(null),
    options.factResolvers?.soil && options.centroid
      ? bounded("USDA SSURGO soil read", () => options.factResolvers!.soil!(options.centroid!))
      : Promise.resolve(null),
    options.factResolvers?.electricProvider && options.centroid
      ? bounded("HIFLD electric-territory read", () =>
          options.factResolvers!.electricProvider!(options.centroid!),
        )
      : Promise.resolve(null),
  ]);

  const floodplainResolution = floodplainSettled
    ? floodplainSettled.ok
      ? floodplainSettled.value
      : ({ error: floodplainSettled.reason } as const)
    : null;

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

  const soil = safeSection<SoilFacts>("soil", () => {
    if (!soilSettled) return notRequested("Soil");
    if (!soilSettled.ok) return absent("failed-this-run", soilSettled.reason);
    const r = soilSettled.value;
    return r.status === "present"
      ? present<SoilFacts>(r.facts, {
          consequence:
            "Soil group and drainage class drive foundation design and on-site septic feasibility. Confirm with a geotechnical report before design.",
        })
      : absent(r.kind, r.reason);
  });

  const electricProvider = safeSection<ElectricProviderFacts>("electricProvider", () => {
    if (!electricSettled) return notRequested("Electric provider");
    if (!electricSettled.ok) return absent("failed-this-run", electricSettled.reason);
    const r = electricSettled.value;
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

  // P152-RAILS item 4: composed from the reader's cityLimits rail when it
  // serves "record" for this parcel -- replacing the constant every parcel
  // in every county previously carried (report-model.ts:791-796 before this
  // lane; deleted per the wave-3 verify doc A2). "unresolved" remains the
  // honest default when no recordReader was supplied, the fetch failed, or
  // the rail is not yet slated "record".
  const cityLimits = recordCityLimitsDisposition(record?.rails.cityLimits);
  const jurisdiction: JurisdictionFacts = {
    countyFips: geometry.status === "present" ? geometry.model.summary.countyFips : null,
    countyName: geometry.status === "present" ? geometry.model.summary.countyName : undefined,
    cityLimitsStatus: cityLimits?.status ?? "unresolved",
    ...(cityLimits?.cityName ? { cityName: cityLimits.cityName } : {}),
    ...(cityLimits ? { cityLimitsSourceCitation: `parcel_record (${cityLimits.source})` } : {}),
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
  /** P152-RAILS: threaded straight through to composeParcelReportFacts — see its own option doc. */
  recordReader?: RecordReaderClient;
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
  // The REAL ring/centroid composeSitePlanModelForParcel resolved from the
  // live parcel-geometry resolver on this call -- the actual parcel
  // boundary, not a test-only override. Previously only options.ringOverride/
  // centroidOverride (caller-supplied test escape hatches production never
  // sends) fed the fact resolvers below, so floodplainAcreage, firmPanel,
  // soil and electricProvider never reached their live NFHL/SSURGO/HIFLD
  // reads on any real request. Threading the resolved values through fixes
  // all four with one change.
  let resolvedRingWgs84: ReadonlyArray<[number, number]> | undefined;
  let resolvedCentroid: { latitude: number; longitude: number } | undefined;
  try {
    const composed = await composeSitePlanModelForParcel(options);
    geometry = { status: "present", model: composed.model };
    resolvedRingWgs84 = composed.ringWgs84;
    resolvedCentroid = composed.centroid;
  } catch (error) {
    // R2: the outage this generalises. A parcel whose geometry cannot be
    // composed no longer takes the whole report down with it.
    geometry = { status: "absent", reason: sitePlanUnavailableFromError(error).summary };
  }

  // ringOverride/centroidOverride remain an explicit escape hatch (tests, or
  // a caller with its own reason to force a specific ring) and win when
  // supplied; otherwise use what geometry composition actually resolved.
  const ringWgs84ForFacts = options.ringOverride ?? resolvedRingWgs84;
  const centroid =
    options.centroidOverride ?? resolvedCentroid ?? (ringWgs84ForFacts ? centroidOfRing(ringWgs84ForFacts) : undefined);

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

  // item 19: the D8 drainage study, when this call ran one, already computes
  // a real, un-named exit coordinate per flow line (discharge-point.ts's own
  // module doc). Use the first one as the discharge-point resolver's input
  // when the caller did not supply one explicitly -- previously this only
  // ever fired for a caller that already knew the coordinate in advance,
  // which no real caller does; the study this same request may have just
  // computed is exactly that coordinate.
  const firstFlowExit =
    drainageResult.state.status === "present" ? drainageResult.state.study.flowExits[0] : undefined;
  const dischargeExitPoint =
    options.dischargeExitPoint ?? (firstFlowExit ? { lat: firstFlowExit.lat, lng: firstFlowExit.lng } : undefined);

  // dischargeExitPoint can end up undefined for three different reasons that
  // must not read the same to a customer: never requested (out-of-scope,
  // the default below), the study ran and genuinely modeled zero surface
  // flow exits (a real checked finding -- live-verified 2026-09-09 against
  // Bastrop 48021:52727, which drains nowhere on the modeled catchment),
  // or a requested fresh run failed to compute at all (ours, this run).
  let dischargeUnavailableReason: { kind: AbsenceKind; reason: string } | undefined;
  if (!options.dischargeExitPoint && !dischargeExitPoint) {
    if (drainageResult.state.status === "present" && drainageResult.state.study.flowExits.length === 0) {
      dischargeUnavailableReason = {
        kind: "blocked-at-source",
        reason: "The parcel-scoped drainage study ran and modeled no surface flow exit for this parcel.",
      };
    } else if (options.drainage?.runWhenStale && drainageResult.state.status === "absent") {
      dischargeUnavailableReason = {
        kind: "failed-this-run",
        reason: `The drainage study needed to locate a discharge point did not complete: ${drainageResult.state.reason}`,
      };
    }
  }

  const model = await composeParcelReportFacts({
    ...(ringWgs84ForFacts ? { ringWgs84: ringWgs84ForFacts } : {}),
    ...(options.factResolvers ? { factResolvers: options.factResolvers } : {}),
    parcelNodeId: options.parcelNodeId,
    storage: options.storage,
    geometry,
    drainage: drainageResult.state,
    centroid,
    whoServes: options.whoServes,
    ...(options.recordReader ? { recordReader: options.recordReader } : {}),
    dischargeExitPoint,
    dischargeResolver: options.dischargeResolver,
    ...(dischargeUnavailableReason ? { dischargeUnavailableReason } : {}),
  });

  return { model, freshDrainageStudy: drainageResult.freshlyComputed };
}
