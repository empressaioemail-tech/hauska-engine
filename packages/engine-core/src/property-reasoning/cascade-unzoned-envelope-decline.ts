/**
 * Unzoned-county cascade — honest-decline envelope for absence-zoning
 * parcels (56,488-parcel 48021 breadth-bake gap; WDLL doctrine: named
 * decline beats silent absence).
 *
 * Contract-shape ruling (planner, 2026-08-03): setback-rule atoms require
 * real numeric front/side/rear dimensions at the published atom-contract
 * schema level (@empressaio/atom-contract), with no "no district at all"
 * absence variant — SETBACK_ABSENCE_KIND is the single literal
 * "setback-fallback", which still requires populated dimensions from a
 * fallback table row. Minting a setback-rule atom for a parcel with NO
 * district would require fabricating those numbers, which is exactly the
 * silent-fabrication failure mode this codebase's honest-absence doctrine
 * exists to prevent (see bake-from-tier1-snapshot.ts doc comment). A
 * first-class contract-level absence variant for setback-rule /
 * buildable-envelope is deferred to a future @empressaio/atom-contract ADR
 * (planner-queued). This module does NOT mint setback-rule atoms.
 *
 * Instead the named decline lives on the envelope only, reusing the
 * EXISTING R27 persisted-decline shape (depth-warm/honest-decline-promote.ts
 * buildHonestVerifyDeclineAtom) — engine-extension fields
 * warmVerifyDecline / warmVerifyDeclineCode on a buildable-envelope
 * instance, already read by cert-grade-core.ts's warm-decline short-circuit
 * and bastrop-dominant-district-roster.mjs. Using the same shape means
 * every downstream reader that already understands an R27 decline
 * understands this one too, with no new read-path branching.
 *
 * CITY-AWARE REASON WORDING (2026-08-04, REASON-OVERSTATES fix / county-fan
 * prerequisite): the cascade targets every absence-zoning parcel county-wide,
 * including parcels inside an incorporated city that IS zoned but simply has
 * not been stamped yet (e.g. Smithville, pre-eCode360-adapter). For those
 * parcels the original single-variant wording ("unzoned jurisdiction — no
 * district basis") is FALSE — the jurisdiction is zoned, only unonboarded.
 * This module now selects between two honest variants keyed on whether the
 * parcel carries an in-city signal at cascade time.
 *
 * City-membership field decision: the cascade reads directly from substrate
 * (`atoms` table) in --cascade-absence-only mode and deliberately does not
 * open a CORTEX_DATABASE_URL connection (see bake-property-atom-county.mjs
 * doc comment) — so it cannot re-query the Tier-1 snapshot's
 * `baseFacts.situsCity` field live. The signal used instead is the persisted
 * `jurisdiction_tenant` column already written onto every zoning-fact atom
 * at ORIGINAL bake time: descriptorForCounty() (bake-from-tier1-snapshot.ts)
 * builds `jurisdictionTenant = breadth_${fips}_${city}` where, on the
 * absence branch specifically, `city` collapses to the raw
 * `baseFacts.situsCity` string (lowercased, spaces->underscore) because
 * `cityKey` (from the PIP zoning-stamp fields) is null whenever there is no
 * district — the exact absence cohort this cascade targets. A city segment
 * of "unknown" means situsCity was null/empty at bake time (no signal;
 * treated as unincorporated). Any OTHER city segment means the CAD situs
 * address carried a town name.
 *
 * RELIABILITY CAVEAT (load-bearing, do not drop; jurisdiction-agnostic per
 * WDLL 3.8 — this module must never hardcode a state/county literal): situsCity
 * is a CAD mailing address's postal city, not a city-limits polygon join.
 * Rural situs addresses commonly carry a nearby incorporated town's name for
 * postal ZIP-routing purposes even when the parcel sits OUTSIDE that town's
 * actual corporate limits — a well-known artifact of US address data, not
 * specific to any one state. This means a non-"unknown" city segment is evidence of
 * likely in-city membership, not proof — there is no city-limits boundary
 * dataset wired into the engine at cascade time to do a real polygon join
 * (verified: no city_limits / incorporated_place / TIGER source anywhere in
 * packages/). The in-city reason wording below is phrased to reflect that:
 * it states the honest fact (not yet onboarded) without asserting the
 * parcel IS definitively inside city limits. This is judged an acceptable,
 * clearly-hedged improvement over the prior wording, which asserted the
 * opposite (unzoned) with equal or worse certainty. A future fix can replace
 * the situsCity proxy with a real TxGIO/Census place-boundary join without
 * changing this module's two-code contract.
 */
import type { JurisdictionDescriptor } from "./types.js";
import { descriptorForCounty } from "./bake-from-tier1-snapshot.js";
import {
  buildHonestVerifyDeclineAtom,
  type HonestVerifyDeclineAtom,
} from "../depth-warm/honest-decline-promote.js";

/** Decline code for the unincorporated-county cascade cohort (unchanged; distinct from depth-warm's verify-fail codes). */
export const UNZONED_NO_DISTRICT_BASIS_CODE = "unzoned-no-district-basis";

export const UNZONED_NO_DISTRICT_BASIS_REASON =
  "unzoned jurisdiction — no district basis for setbacks or envelope";

/**
 * Decline code for the in-city-but-unonboarded cascade cohort (new,
 * 2026-08-04). A parcel whose situs address carries a town name is likely
 * inside that town's zoned jurisdiction — the jurisdiction has districts, the
 * engine just has not been onboarded/stamped to know which one applies here
 * yet. Distinct code from UNZONED_NO_DISTRICT_BASIS_CODE so every downstream
 * reader that means "genuinely unzoned/unincorporated" (e.g.
 * cert-grade-core.ts's gradeUnzonedParcel) keeps matching ONLY the
 * unincorporated code, by construction.
 */
export const NO_DISTRICT_ON_RECORD_CODE = "no-district-on-record";

export const NO_DISTRICT_ON_RECORD_REASON =
  "no district on record — jurisdiction not yet onboarded";

/** Union of both cascade decline codes this module can mint. */
export const CASCADE_DECLINE_CODES = [
  UNZONED_NO_DISTRICT_BASIS_CODE,
  NO_DISTRICT_ON_RECORD_CODE,
] as const;
export type CascadeDeclineCode = (typeof CASCADE_DECLINE_CODES)[number];

/**
 * City segment of a breadth-bake `jurisdictionTenant`
 * (`breadth_${fips}_${city}`) that means "no situs-city signal at bake
 * time" — the sentinel descriptorForCounty() writes when cityHint is
 * null/empty. Any other segment is a CAD situs-address town name (see the
 * module-level reliability caveat above).
 */
export const NO_CITY_SIGNAL_SEGMENT = "unknown";

/**
 * True when a persisted `jurisdictionTenant` (breadth_${fips}_${city} shape)
 * carries a non-sentinel city segment — i.e. the situs address named a town
 * at original bake time. Pure string parsing so it can be reused identically
 * by the cascade builder (fresh mint) and the reword backfill (existing
 * rows) without re-deriving the format in two places.
 */
export function jurisdictionTenantHasCitySignal(
  jurisdictionTenant: string | null | undefined,
): boolean {
  return jurisdictionTenantCitySegment(jurisdictionTenant) !== null;
}

/**
 * Extract the city segment from a persisted breadth-bake `jurisdictionTenant`
 * (`breadth_${fips}_${city}` shape), or null when there is no usable signal
 * (malformed, not a breadth tenant, or the "unknown" sentinel). Returns the
 * RAW normalized segment (already lowercased/underscored by the original
 * descriptorForCounty() call) so a reword/re-mint round-trips to the same
 * jurisdictionTenant rather than re-deriving a fresh "unknown".
 */
export function jurisdictionTenantCitySegment(
  jurisdictionTenant: string | null | undefined,
): string | null {
  if (!jurisdictionTenant) return null;
  const parts = jurisdictionTenant.split("_");
  // breadth_${fips}_${city...} — city segment is everything after the first
  // two underscore-joined parts (fips itself never contains an underscore,
  // but a multi-word city does, e.g. "breadth_48021_del_valle").
  if (parts[0] !== "breadth" || parts.length < 3) return null;
  const citySegment = parts.slice(2).join("_");
  return citySegment.length > 0 && citySegment !== NO_CITY_SIGNAL_SEGMENT
    ? citySegment
    : null;
}

/**
 * Determine which cascade decline variant applies from a situsCity hint (the
 * same hint descriptorForCounty() would fold into jurisdictionTenant). Kept
 * as a small pure function so the fresh-mint path (buildCascadeEnvelopeDecline)
 * and any future caller agree on the classification without re-deriving it.
 */
export function classifyCascadeCohort(
  situsCity: string | null | undefined,
): { code: CascadeDeclineCode; reason: string } {
  const hasCitySignal = Boolean(situsCity && situsCity.trim().length > 0);
  return hasCitySignal
    ? { code: NO_DISTRICT_ON_RECORD_CODE, reason: NO_DISTRICT_ON_RECORD_REASON }
    : { code: UNZONED_NO_DISTRICT_BASIS_CODE, reason: UNZONED_NO_DISTRICT_BASIS_REASON };
}

/** Minimal shape the cascade needs to read off a persisted absence zoning-fact row. */
export interface AbsenceZoningFactRef {
  parcelNodeId: string;
  atomDid: string;
  /** Situs city, if known, for descriptor jurisdictionTenant construction AND cohort classification. */
  situsCity?: string | null;
}

/**
 * Build (without writing) the cascade envelope decline for one absence
 * parcel. Reuses descriptorForCounty for the same breadth-bake jurisdiction
 * shape the original Tier-1 bake used, and buildHonestVerifyDeclineAtom for
 * the persisted R27 decline shape. Selects the in-city vs unincorporated
 * decline variant from situsCity (see module doc comment for the field
 * decision + reliability caveat). Caller batches the write.
 */
export function buildCascadeEnvelopeDecline(
  ref: AbsenceZoningFactRef,
  countyFips: string,
  extractedAt: string,
): HonestVerifyDeclineAtom {
  const descriptor: JurisdictionDescriptor = descriptorForCounty(
    ref.parcelNodeId,
    ref.situsCity ?? null,
    countyFips,
  );
  const { code, reason } = classifyCascadeCohort(ref.situsCity);
  return buildHonestVerifyDeclineAtom({
    parcelNodeId: ref.parcelNodeId,
    zoningFactAtomDid: ref.atomDid,
    descriptor,
    verifyReasons: [reason],
    declineCode: code,
    extractedAt,
  });
}
