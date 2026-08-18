// project-sheet.ts
//
// One parcel in, one classified observation out. This is where a served wire
// body becomes the Fact states the frozen `FieldTally` counts.
//
// EVERY COUNTING RULE IS STATED HERE, AT THE POINT OF USE, per DEV_PROCESS 1.2.
// The rules are not neutral and two of them are the finding itself, so they are
// spelled out rather than buried in a methodology section:
//
//  - A served `situsAddress` of `", ,"` is counted as ABSENT, not present. The
//    serving code counts it as present (`typeof s === "string" && s.trim()` is
//    true for `", ,"`), and that is exactly how a store-side "99.3% populated"
//    figure and a human looking at a blank address line can both be right. The
//    sweep counts what a human can read. It also emits the card's own verdict
//    separately (`servedCardCallsPresent`) so the divergence is a published
//    number rather than a definition the sweep chose quietly.
//
//  - A card facet in state `pending` is counted as UNRESOLVED, not as an
//    absence. `baked-facets.ts` says so in its own words: "atom_path_pending is
//    a FAILED/INCOMPLETE READ shell, not honest absence — never render it as
//    'not verified here'". Folding it into an absence would hide an outage
//    inside a coverage gap, which the frozen record forbids.

import { deriveBakedCardModel } from "./vendor/baked-facets.js";
import type { BakedFacetPayload } from "./vendor/baked-facets.js";
import type { FieldKey } from "./types.js";

export type FactState = "present" | "absentCovered" | "absentUncovered" | "unresolved";

export interface FieldObservation {
  state: FactState;
  /** Machine reason token, tallied so absences can be traced to a source. */
  reason: string;
}

export type ContradictionFlag =
  | "envelope-not-derived-but-area-shown"
  | "flood-zone-disagreement"
  | "field-unavailable-but-present-upstream"
  | "address-absent-but-on-cad-roll"
  | "setbacks-present-card-absent-brief";

export interface ParcelObservation {
  parcelNodeId: string;
  /** True when the served land-use code is a single-family residential class. */
  singleFamily: boolean;
  fields: Record<FieldKey, FieldObservation>;
  contradictions: ContradictionFlag[];
  /** The served card's OWN verdict on situs, before this sweep's stricter rule. */
  servedCardCallsSitusPresent: boolean;
  /** Zones on the parcel's flood determination, from the tier-2 overlay. */
  floodZoneCount: number;
  /** Centroid for absence clustering; null when the sweep has no point. */
  centroid: { lat: number; lng: number } | null;
}

export interface SheetInputs {
  parcelNodeId: string;
  /** The wire body a browser would receive, from `composeServedResponse`. */
  servedBody: Record<string, unknown>;
  /**
   * The tier-2 overlay as the STORE holds it. Not necessarily what is served —
   * proving that gap is half of this lane.
   */
  storeTier2Flood: Record<string, unknown> | null;
  /** `flood-hazard-fact` atom, the SECOND flood code path. */
  floodHazardFact: Record<string, unknown> | null;
  /** `cad-parcel-roll` atom, the county appraisal roll of record. */
  cadRoll: Record<string, unknown> | null;
  centroid: { lat: number; lng: number } | null;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Human-legible: at least one letter or digit. `", ,"` and `"--"` are not. */
export function isLegibleText(v: unknown): boolean {
  return typeof v === "string" && /[A-Za-z0-9]/.test(v);
}

/**
 * Single-family classification. Texas CAD state codes: `A` is single-family
 * residential (A1 improved, A2 mobile home, ...). The sweep uses the SERVED
 * land-use code, not the CAD roll's, because the class breakout is about what
 * the consumer surface shows. A parcel whose land use is not served at all is
 * NOT counted as single family — measured, never inferred (DEV_PROCESS 1.3).
 */
export function isSingleFamilyCode(code: string | null): boolean {
  if (!code) return false;
  return /^A\d?$/i.test(code.trim());
}

export function projectSheet(input: SheetInputs): ParcelObservation {
  const body = input.servedBody;
  const facets = (rec(body.facets) ?? {}) as BakedFacetPayload &
    Record<string, unknown>;
  const card = deriveBakedCardModel(facets);
  const base = rec(facets.baseFacts) ?? {};
  const cov = rec(facets.facetCoverage) ?? {};
  const env = rec(facets.envelope);
  const servedTier2 = rec(body.tier2);
  const contradictions: ContradictionFlag[] = [];

  // ---------------------------------------------------------------- identity
  const cadSitus = input.cadRoll ? str(input.cadRoll.situsAddress) : null;
  const cadHasLegibleSitus = isLegibleText(cadSitus);
  const servedSitus = base.situsAddress;
  const servedCardCallsSitusPresent = card.situsAddress.state === "present";
  let situs: FieldObservation;
  if (isLegibleText(servedSitus)) {
    situs = { state: "present", reason: "served" };
  } else if (typeof servedSitus === "string" && servedSitus.trim().length > 0) {
    // Non-empty but illegible — the `", ,"` class. The card calls this present.
    situs = { state: "absentCovered", reason: "served-punctuation-sentinel" };
    if (cadHasLegibleSitus) contradictions.push("address-absent-but-on-cad-roll");
  } else if (cadHasLegibleSitus) {
    situs = { state: "absentUncovered", reason: "absent-on-sheet-present-on-cad-roll" };
    contradictions.push("address-absent-but-on-cad-roll");
  } else {
    situs = { state: "absentCovered", reason: "absent-on-sheet-and-on-cad-roll" };
  }

  const apn: FieldObservation = isLegibleText(base.apn)
    ? { state: "present", reason: "served" }
    : { state: "absentCovered", reason: "no-apn-on-sheet" };

  // ---------------------------------------------------------------- land use
  const landUseCode = str(rec(base.landUse)?.code);
  const landUse: FieldObservation = landUseCode
    ? { state: "present", reason: "served" }
    : cov.landUse === true
      ? { state: "absentCovered", reason: "covered-no-value-on-record" }
      : {
          state: "absentUncovered",
          reason: rec(facets.provenance)?.landUseGateBlocked === true
            ? "land-use-gate-blocked"
            : "no-land-use-coverage",
        };

  // ------------------------------------------------------------------ zoning
  // COUNTING RULE: `no-zoning-stamp` is classified absentUncovered, because the
  // served reason is a statement about OUR stamp coverage, not about the world.
  // Most unincorporated Texas is genuinely unzoned, so a large share of this
  // class is expected to be irreducible — the report says so and never presents
  // it as a backlog. The reason token is preserved so the two can be separated
  // later without re-running the sweep.
  const declineReason =
    env && env.status === "declined" ? str(env.declineReason) : null;
  const district = str(rec(facets.zoning)?.district);
  let zoning: FieldObservation;
  if (cov.zoning === true && district) {
    zoning = { state: "present", reason: "served" };
  } else if (declineReason === "atom_path_pending") {
    zoning = { state: "unresolved", reason: "atom-path-pending" };
  } else if (declineReason === "no-zoning-stamp") {
    zoning = { state: "absentUncovered", reason: "no-zoning-stamp" };
  } else if (declineReason) {
    zoning = { state: "absentUncovered", reason: declineReason };
  } else {
    zoning = { state: "absentUncovered", reason: "no-district-no-reason" };
  }

  // ---------------------------------------------------------------- setbacks
  const wireSetbacks = rec(env?.setbacks);
  const cardSetbackState = card.setbacks.state;
  let setbacks: FieldObservation;
  if (cardSetbackState === "present") {
    setbacks = { state: "present", reason: "served" };
  } else if (cardSetbackState === "pending") {
    setbacks = { state: "unresolved", reason: "atom-path-pending" };
  } else {
    setbacks = {
      state: "absentUncovered",
      reason: declineReason ?? "no-setback-rule",
    };
  }
  // CONTRADICTION: the wire carries a setbacks object while the card's
  // coverage gate hides it. `brief-view-model.ts:365` reads `env.setbacks`
  // straight off the payload with no coverage check; `compare-facts.ts:269`
  // reads the coverage-gated `card.setbacks`. Same parcel, same payload,
  // two answers.
  if (wireSetbacks && cardSetbackState !== "present") {
    contradictions.push("setbacks-present-card-absent-brief");
  }

  // ---------------------------------------------------------------- envelope
  const envArea =
    typeof env?.buildableAreaSqFt === "number" ? env.buildableAreaSqFt : null;
  const envPct =
    typeof env?.buildableAreaPct === "number" ? env.buildableAreaPct : null;
  const envGeoFeatures = (() => {
    const g = rec(env?.geojson);
    const f = g?.features;
    return Array.isArray(f) ? f.length : g ? 1 : 0;
  })();
  let envelope: FieldObservation;
  if (card.buildablePct.state === "present") {
    envelope = { state: "present", reason: "served" };
  } else if (card.buildablePct.state === "pending") {
    envelope = { state: "unresolved", reason: "atom-path-pending" };
  } else {
    envelope = {
      state: "absentUncovered",
      reason: declineReason ?? "no-envelope",
    };
  }
  // CONTRADICTION: an area or a polygon is on the wire while the envelope facet
  // is not presented as derived. This is the X-ray PDF defect — "buildable
  // envelope not derived here" on sheet 1 beside a drawn envelope on sheet 3
  // and 6,325 sq ft on sheet 4.
  if (
    card.buildablePct.state !== "present" &&
    (envArea !== null || envPct !== null || envGeoFeatures > 0)
  ) {
    contradictions.push("envelope-not-derived-but-area-shown");
  }

  // ------------------------------------------------------------------- flood
  // The served body carries flood ONLY as the `tier2` sibling. On the
  // production atom-chain read path there IS no `tier2` sibling, because
  // `mergeBakedBaseFacts` composes its result from the atom response and never
  // copies it across. So this is measured, not assumed: read what is on the
  // wire, and compare it to what the store holds.
  const servedFlood = rec(servedTier2?.flood);
  const servedFloodStatus = str(servedFlood?.status);
  const storeFlood = input.storeTier2Flood;
  const storeFloodStatus = storeFlood ? str(storeFlood.status) : null;
  const storeFloodZone = storeFlood ? str(storeFlood.floodZone) : null;
  const factFloodZone = input.floodHazardFact
    ? str(input.floodHazardFact.floodZone)
    : null;

  let flood: FieldObservation;
  if (servedFloodStatus && servedFloodStatus !== "unavailable") {
    flood = { state: "present", reason: "served-tier2" };
  } else if (servedTier2) {
    flood = { state: "absentCovered", reason: "tier2-served-status-unavailable" };
  } else if (storeFloodStatus || factFloodZone) {
    // The store has a determination and the wire does not carry it.
    flood = { state: "absentUncovered", reason: "tier2-dropped-by-bff-merge" };
    contradictions.push("field-unavailable-but-present-upstream");
  } else {
    flood = { state: "absentUncovered", reason: "no-flood-determination-anywhere" };
  }

  // CONTRADICTION: two code paths, two zones. The tier-2 bake
  // (adapterKey `fema:nfhl-flood-zone`) and the `flood-hazard-fact` atom
  // (sourceAdapter `fema-nfhl-bulk-v1`) both claim FEMA NFHL and are compared
  // here only when BOTH name a zone — an absent second opinion is not a
  // disagreement (DEV_PROCESS 4.3).
  if (
    storeFloodZone &&
    factFloodZone &&
    storeFloodZone.toUpperCase() !== factFloodZone.toUpperCase()
  ) {
    contradictions.push("flood-zone-disagreement");
  }

  const floodZoneCount = (() => {
    const zones = new Set<string>();
    if (storeFloodZone) zones.add(storeFloodZone.toUpperCase());
    if (factFloodZone) zones.add(factFloodZone.toUpperCase());
    return zones.size;
  })();

  // ---------------------------------------------------------------- geometry
  // The fact-sheet read serves NO parcel ring. The map draws parcels from a
  // PMTiles archive and the address lookup gets a centroid from a separate
  // buildable-envelope resolve; neither is on this endpoint. The only geometry
  // on the wire is the buildable envelope polygon. Contract invariant I5 makes
  // geometry required and its centroid the sole navigation authority, so this
  // tally is the measure of the distance to that invariant.
  const geometry: FieldObservation =
    envGeoFeatures > 0
      ? { state: "present", reason: "envelope-geojson-on-wire" }
      : {
          state: "absentUncovered",
          reason: "no-geometry-on-fact-sheet-response",
        };

  // ---------------------------------------------------------------- frontage
  // `attachingRoads` rides the retrieval atom-chain wire and the PE adapter
  // never reads it, so no frontage reaches any surface through this endpoint.
  const frontage: FieldObservation = {
    state: "absentUncovered",
    reason: "attaching-roads-not-adapted-to-facets",
  };

  // ------------------------------------------------- county-name contradiction
  // "County name is not on file for this parcel" for a parcel whose id begins
  // with the county FIPS.
  if (!str(facets.countyName) && /^\d{5}:/.test(input.parcelNodeId)) {
    contradictions.push("field-unavailable-but-present-upstream");
  }

  return {
    parcelNodeId: input.parcelNodeId,
    singleFamily: isSingleFamilyCode(landUseCode),
    fields: {
      geometry,
      situsAddress: situs,
      apn,
      landUse,
      zoning,
      setbacks,
      envelope,
      flood,
      frontage,
    },
    contradictions,
    servedCardCallsSitusPresent,
    floodZoneCount,
    centroid: input.centroid,
  };
}
