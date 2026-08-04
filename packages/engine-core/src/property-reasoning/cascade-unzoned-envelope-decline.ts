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
 */
import type { JurisdictionDescriptor } from "./types.js";
import { descriptorForCounty } from "./bake-from-tier1-snapshot.js";
import {
  buildHonestVerifyDeclineAtom,
  type HonestVerifyDeclineAtom,
} from "../depth-warm/honest-decline-promote.js";

/** Decline code for the unzoned-county cascade (distinct from depth-warm's verify-fail codes). */
export const UNZONED_NO_DISTRICT_BASIS_CODE = "unzoned-no-district-basis";

export const UNZONED_NO_DISTRICT_BASIS_REASON =
  "unzoned jurisdiction — no district basis for setbacks or envelope";

/** Minimal shape the cascade needs to read off a persisted absence zoning-fact row. */
export interface AbsenceZoningFactRef {
  parcelNodeId: string;
  atomDid: string;
  /** Situs city, if known, for descriptor jurisdictionTenant construction only. */
  situsCity?: string | null;
}

/**
 * Build (without writing) the cascade envelope decline for one absence
 * parcel. Reuses descriptorForCounty for the same breadth-bake jurisdiction
 * shape the original Tier-1 bake used, and buildHonestVerifyDeclineAtom for
 * the persisted R27 decline shape. Caller batches the write.
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
  return buildHonestVerifyDeclineAtom({
    parcelNodeId: ref.parcelNodeId,
    zoningFactAtomDid: ref.atomDid,
    descriptor,
    verifyReasons: [UNZONED_NO_DISTRICT_BASIS_REASON],
    declineCode: UNZONED_NO_DISTRICT_BASIS_CODE,
    extractedAt,
  });
}
