/**
 * Shared identity helpers for the three 1.14.0 property-fact writers
 * (`cad-parcel-roll`, `land-use-fact`, `flood-hazard-fact`).
 *
 * Contract atomDid shapes are prefixed FNV-1a 64-bit hex tokens
 * (`cadroll_<16>`, `lufact_<16>`, `fhfact_<16>`). StoragePort still
 * upserts under `did:hauska:<entityType>:<entityId>`; body.atomDid stays
 * the contract form and is what write-then-verify reads back.
 *
 * The HOLD sets below are join-policy metadata for known-bad prop_id
 * crosswalks — not county allowlists for who may run. Store roster still
 * comes from `cad_property` / `txgio_parcel` / NFHL at execution time.
 */

/** OPS-1 geo_id/address-crosswalk HOLD cohort (prop_id join unsafe). */
export const CROSSWALK_HOLD_FIPS: ReadonlySet<string> = new Set([
  "48453", // Travis
  "48395", // Robertson
  "48359", // Oldham
  "48393", // Roberts
  "48345", // Motley
  "48153", // Floyd
  "48127", // Dimmit
  "48295", // Lipscomb
]);

/** Hays + Williamson — TxGIO prop_id does not correspond to CAD roll. */
export const LANDUSE_JOIN_HOLD_FIPS: ReadonlySet<string> = new Set([
  "48209", // Hays
  "48491", // Williamson
]);

/** FNV-1a 64-bit → lowercase 16-hex (no `0x` prefix). */
export function fnv1a64Hex(canonical: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= BigInt(canonical.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Deterministic content-hash for a claim (not provenance timestamps).
 * Same convention as `parcelNodeContentHash`.
 */
export function factClaimContentHash(parts: unknown): string {
  return `fnv1a64:${fnv1a64Hex(JSON.stringify(parts))}`;
}

export function cadParcelRollAtomDid(identity: {
  parcelNodeId: string;
  taxYear: number;
}): string {
  return `cadroll_${fnv1a64Hex(
    JSON.stringify(["cad-parcel-roll", identity.parcelNodeId, identity.taxYear]),
  )}`;
}

export function landUseFactAtomDid(identity: {
  parcelNodeId: string;
  taxYear: number;
}): string {
  return `lufact_${fnv1a64Hex(
    JSON.stringify(["land-use-fact", identity.parcelNodeId, identity.taxYear]),
  )}`;
}

export function ownerFactAtomDid(identity: {
  parcelNodeId: string;
  taxYear: number;
}): string {
  return `ownfact_${fnv1a64Hex(
    JSON.stringify(["owner-fact", identity.parcelNodeId, identity.taxYear]),
  )}`;
}

export function wellFactAtomDid(identity: {
  parcelNodeId: string;
  wellKey: string;
}): string {
  return `wlfact_${fnv1a64Hex(
    JSON.stringify(["well-fact", identity.parcelNodeId, identity.wellKey]),
  )}`;
}

export function floodHazardFactAtomDid(identity: {
  parcelNodeId: string;
}): string {
  return `fhfact_${fnv1a64Hex(
    JSON.stringify(["flood-hazard-fact", identity.parcelNodeId]),
  )}`;
}

/**
 * Join-key normalization: strip leading zeros on all-digit ids so a
 * zero-padded CAD token and a TxGIO prop_id address the same account.
 * Non-numeric tokens are trimmed only.
 */
export function normalizeForJoin(value: string): string {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return trimmed;
  return trimmed.replace(/^0+(?=\d)/, "");
}

/**
 * A prop_id that is present but carries no identity (null / blank / all-zero
 * StratMap placeholders). Same unusable-token rule as the parcel-node planner.
 */
export function isUsablePropId(value: string | null | undefined): value is string {
  if (value === null || value === undefined) return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (/^0+$/.test(trimmed)) return false;
  return true;
}

export function isCrosswalkHoldCounty(countyFips: string): boolean {
  return CROSSWALK_HOLD_FIPS.has(countyFips);
}

export function isLandUseJoinHoldCounty(countyFips: string): boolean {
  return LANDUSE_JOIN_HOLD_FIPS.has(countyFips);
}
