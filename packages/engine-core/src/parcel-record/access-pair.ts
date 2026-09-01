/**
 * Access pair for parcel-record rails.
 *
 * Matches 19_the_instrument_contract.md (discoverability × entitlement).
 * Local type: engine-core is pinned @empressaio/atom-contract ^1.22.0 and this
 * card does not bump it to the 1.30.0 /access subpath.
 */

export type RailDiscoverability = "catalog-listed" | "unlisted" | "hidden";

export type RailEntitlement =
  | "anyone-free"
  | "anyone-paid"
  | "named-parties"
  | "owner-only"
  | "platform-only";

export interface RailAccessPair {
  readonly discoverability: RailDiscoverability;
  readonly entitlement: RailEntitlement;
}

/** Default public-record pair. Written onto every rail that is not paid-tier. */
export const PUBLIC_RAIL_ACCESS = {
  discoverability: "catalog-listed",
  entitlement: "anyone-free",
} as const satisfies RailAccessPair;

/**
 * Paid-tier pair. Owner carries this EXPLICITLY — never as a fallback from
 * PUBLIC_RAIL_ACCESS. The 2026-08-28 restamp of 6.3M atoms is why inheritance
 * is not trusted here.
 */
export const OWNER_RAIL_ACCESS = {
  discoverability: "catalog-listed",
  entitlement: "anyone-paid",
} as const satisfies RailAccessPair;

/** User-acquired public-record rows (Smart Files / tenant-private posture). */
export const TENANT_PRIVATE_ACCESS = {
  discoverability: "hidden",
  entitlement: "named-parties",
} as const satisfies RailAccessPair;

export type PublicRecordAcquiredBy = "public-ingest" | "user-request";

/**
 * Per-row access for publicRecordRefs. Derived from acquiredBy, never inherited
 * from the rail default.
 */
export function accessForPublicRecordRef(
  acquiredBy: PublicRecordAcquiredBy,
): RailAccessPair {
  if (acquiredBy === "user-request") return TENANT_PRIVATE_ACCESS;
  return PUBLIC_RAIL_ACCESS;
}
