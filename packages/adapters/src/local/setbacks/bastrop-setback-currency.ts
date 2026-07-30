/**
 * R13 — Bastrop city setback currency (AMENDMENT 8).
 * Per-parcel layer 23 is the ONLY authoritative scalar source for city parcels.
 * Repealed B3 / descriptor-fixture / breadth-bake paths must fail-closed.
 */

/** Layer-23 per-parcel record is the sole current scalar author for Bastrop city. */
export const BASTROP_AUTHORITATIVE_SETBACK_ADAPTER =
  "bastrop-per-parcel-record-layer-23";

const REPEALED_ATOM_DID_MARKERS = [
  "b3-code-april-2025",
  "bastrop-b3-code-april-2025",
] as const;

const STALE_SETBACK_ADAPTERS = new Set([
  "descriptor-fixture",
  "cortex-tier1-snapshot-breadth-bake",
]);

export function isBastropCountyParcelNodeId(parcelNodeId: string): boolean {
  return /^48021:[^/\s]+$/.test(parcelNodeId.trim());
}

/**
 * Jurisdiction keys whose setbacks are AUTHORED ONLY from a per-parcel record
 * (layer 23) — a breadth-bake / tier1-snapshot must NOT synthesize a setback
 * scalar for these (R13). Kept in the adapters package so reasoning modules stay
 * jurisdiction-literal-free (WDLL 3.8 grep gate).
 */
const PER_PARCEL_RECORD_ONLY_SETBACK_KEYS = new Set([
  "bastrop-city-tx",
  "bastrop-tx",
  "bastrop-development-code",
  "bastrop-per-parcel-record",
]);

/** True when the jurisdiction's setbacks come only from its per-parcel record. */
export function requiresPerParcelSetbackRecord(
  jurisdictionKey: string | null | undefined,
): boolean {
  if (!jurisdictionKey) return false;
  const norm = jurisdictionKey.toLowerCase().replace(/_/g, "-");
  return PER_PARCEL_RECORD_ONLY_SETBACK_KEYS.has(norm);
}

export function isAuthoritativeBastropCitySetbackSource(
  sourceAdapter: string | null | undefined,
): boolean {
  return sourceAdapter === BASTROP_AUTHORITATIVE_SETBACK_ADAPTER;
}

/** True when a persisted setback-rule must NOT be served for a Bastrop city parcel. */
export function isStaleBastropCitySetbackRule(input: {
  parcelNodeId: string;
  sourceAdapter?: string | null;
  sourceCodeAtomDid?: string | null;
}): boolean {
  if (!isBastropCountyParcelNodeId(input.parcelNodeId)) return false;
  if (isAuthoritativeBastropCitySetbackSource(input.sourceAdapter)) return false;

  const did = (input.sourceCodeAtomDid ?? "").toLowerCase();
  if (REPEALED_ATOM_DID_MARKERS.some((m) => did.includes(m))) return true;

  const adapter = (input.sourceAdapter ?? "").trim();
  if (STALE_SETBACK_ADAPTERS.has(adapter)) return true;

  // Fail-closed: any non-layer-23 Bastrop city setback is stale until re-warmed.
  return adapter !== "" && !isAuthoritativeBastropCitySetbackSource(adapter);
}

export function bastropSetbackPendingRewarmReason(): string {
  return (
    "Setbacks pending re-warm from city per-parcel record — verify with city. " +
    "Repealed or pre-layer-23 sources are not served."
  );
}
