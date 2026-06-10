/**
 * Tiny payload-shape helpers shared by the federal-tier, state-tier,
 * and local-tier summary chip formatters. Keeping a single copy here
 * means a future tweak (e.g. "accept BigInt" in `pickNumber`) lands
 * for every tier at once instead of drifting between three near-identical
 * inlined definitions.
 *
 * Every helper accepts `unknown` and returns either a typed value or
 * `null` so the callers can stay defensive: the chip should degrade to
 * "no data" when fields are missing or malformed, never throw.
 */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function pickString(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return null;
}

export function pickNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Walk a list of candidate keys on a record and return the first one
 * that resolves to a non-empty string. ArcGIS layers expose the same
 * conceptual field under wildly inconsistent column names across
 * jurisdictions (e.g. `PARCEL_ID` vs `PARCELID` vs `PIN` vs `APN`),
 * so each summarizer passes its own ranked list.
 */
export function pickFirstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const k of keys) {
    const v = pickString(record[k]);
    if (v !== null) return v;
  }
  return null;
}

/**
 * Same shape as {@link pickFirstString} but for numeric fields (acres,
 * area, count). Strings that parse cleanly to a finite number are
 * accepted — ArcGIS sometimes wraps numerics as strings in the JSON
 * envelope.
 */
export function pickFirstNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const k of keys) {
    const v = pickNumber(record[k]);
    if (v !== null) return v;
  }
  return null;
}

/**
 * Round acres to two decimals for display in a chip. Sub-acre lots
 * read more naturally with two decimals (0.42 ac), while large parcels
 * still group cleanly (12.34 ac → "12.34 ac"). We avoid `toFixed` for
 * whole acres so a round 5.0 ac reads as "5 ac" not "5.00 ac".
 */
export function formatAcres(acres: number): string {
  if (acres >= 100) {
    // For very large parcels (>= 100 ac), one decimal is plenty and
    // keeps the chip readable.
    const rounded = Math.round(acres * 10) / 10;
    return Number.isInteger(rounded) ? `${rounded} ac` : `${rounded.toFixed(1)} ac`;
  }
  const rounded = Math.round(acres * 100) / 100;
  if (Number.isInteger(rounded)) return `${rounded} ac`;
  // Trim a trailing zero on values like 0.40 → "0.4 ac" so the chip
  // reads naturally.
  const fixed = rounded.toFixed(2);
  return `${fixed.replace(/0$/, "").replace(/\.$/, "")} ac`;
}

/** Common parcel-id column names across the pilot adapters. */
export const PARCEL_ID_KEYS = [
  "PARCEL_ID",
  "PARCELID",
  "PARCEL_NO",
  "PARCEL_NUMBER",
  "PIN",
  "APN",
  "PROP_ID",
] as const;

/** Common acres column names across the pilot adapters. */
export const PARCEL_ACRES_KEYS = [
  "ACRES",
  "Acres",
  "GIS_ACRES",
  "ACREAGE",
  "LotAcres",
  "LOT_ACRES",
] as const;

/** Common zoning-code column names. */
export const ZONING_CODE_KEYS = [
  "ZONE_CODE",
  "ZONING",
  "ZONE",
  "ZONING_CODE",
  "ZONE_TYPE",
  "DISTRICT",
  "ZONE_CLASS",
] as const;

/** Common zoning long-description column names. */
export const ZONING_DESC_KEYS = [
  "ZONE_DESC",
  "ZONING_DESC",
  "DESCRIPTION",
  "ZONE_NAME",
  "ZONE_LABEL",
] as const;

/** Common full-street-address column names used by address-point layers. */
export const ADDRESS_FULL_KEYS = [
  "FullAdd",
  "FullAddress",
  "FULL_ADDR",
  "FULLADDR",
  "ADDRESS",
  "Address",
  "SiteAddress",
  "SITEADDR",
] as const;

/** Common house-number column names used when reconstructing an address. */
export const ADDRESS_NUMBER_KEYS = [
  "AddNum",
  "ADD_NUM",
  "STREET_NUMBER",
  "HouseNumber",
  "HOUSE_NO",
] as const;

/** Common street-name column names used when reconstructing an address. */
export const ADDRESS_STREET_KEYS = [
  "StreetName",
  "STREET",
  "STR_NAME",
  "STNAME",
] as const;

/** Common FEMA-derived flood-zone column names on county floodplain layers. */
export const FLOOD_ZONE_KEYS = [
  "FLD_ZONE",
  "ZONE",
  "FloodZone",
  "FLOOD_ZONE",
] as const;

/**
 * "(none)" mirrors the wording the engagement-detail metadata diff
 * already uses for missing fields, so a per-key payload reveal reads
 * consistently with the metadata table directly above it. State and
 * local payload diffs share this constant with the federal diff.
 */
export const PAYLOAD_DIFF_NONE = "(none)";

/**
 * One per-key payload delta surfaced by a tier-specific `diff*Payload`
 * helper. `key` is the underlying payload property name (stable, used
 * as a test-id and React key); `label` is the reader-friendly heading
 * the UI shows next to the before/after pair.
 *
 * The federal diff exposes its own structurally-identical
 * `FederalPayloadFieldChange` for backwards compatibility — both
 * shapes are intentionally interchangeable from the UI's perspective.
 */
export interface PayloadFieldChange {
  key: string;
  label: string;
  before: string;
  after: string;
}

/**
 * One field config consumed by {@link diffPayloadByFields}. `key` is
 * the property name on the payload (stable, used as a test-id);
 * `label` is the heading shown in the reveal; `format` reads the
 * (validated-as-record) payload and returns a string identical in
 * shape/units to the inline summary chip.
 */
export interface PayloadDiffField {
  key: string;
  label: string;
  format: (payload: Record<string, unknown>) => string;
}

/**
 * Diff a prior-payload against the current-payload by walking a
 * declared field list. Returns one {@link PayloadFieldChange} per
 * field whose formatted value moved. The caller is responsible for:
 *
 *   - validating that both payloads are records (state/local payload
 *     `kind`s vary; the per-tier dispatcher handles `kind`-mismatch
 *     and non-record short-circuits before delegating here);
 *   - deciding what to do with an empty array (the engagement-detail
 *     UI suppresses the "Payload changes" subsection when nothing
 *     moved so an architect isn't shown an empty heading).
 *
 * Iteration order is the field list's order — this is what the UI
 * uses to lay out rows top-down, so list fields in the same order
 * the inline summary chip composes its parts.
 */
export function diffPayloadByFields(
  fields: ReadonlyArray<PayloadDiffField>,
  priorPayload: Record<string, unknown>,
  currentPayload: Record<string, unknown>,
): PayloadFieldChange[] {
  const changes: PayloadFieldChange[] = [];
  for (const f of fields) {
    const before = f.format(priorPayload);
    const after = f.format(currentPayload);
    if (before !== after) {
      changes.push({ key: f.key, label: f.label, before, after });
    }
  }
  return changes;
}

/**
 * Verdict for a single briefing source's snapshot date relative to
 * its adapter-declared freshness window. Tier-specific evaluators
 * (federal / state / local) all return this shape so the FE renders
 * a single badge component regardless of which adapter produced the
 * row.
 *
 *   - `ageMonths` is the integer number of whole months between the
 *     snapshot date and `now` (a snapshot 11 months and 29 days old
 *     reads as `11`, not `12`); rounding *down* keeps the "snapshot
 *     is N months old" label honest.
 *   - `thresholdMonths` is the per-dataset window pulled from the
 *     adapter file — surfaced so a tooltip / aria-label can include
 *     it without the caller re-doing the lookup.
 *   - `isStale` is true iff `ageMonths >= thresholdMonths`. Equality
 *     counts as stale so a snapshot taken exactly N months ago tags
 *     on its anniversary (matches what a reviewer intuitively expects
 *     when the threshold reads "12 months").
 */
export interface SnapshotFreshness {
  ageMonths: number;
  thresholdMonths: number;
  isStale: boolean;
}

/**
 * Whole-months difference between two `Date`s, rounded *down*. We
 * compute on the calendar (year * 12 + month) and then back off by
 * one if the snapshot's day-of-month + time-of-day haven't yet been
 * reached in the current month — that way "Jan 1 → Dec 31 same year"
 * reads as 11 months, not 12, and stays under a 12-month threshold
 * until the literal anniversary.
 */
export function wholeMonthsBetween(snapshot: Date, now: Date): number {
  let months =
    (now.getUTCFullYear() - snapshot.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - snapshot.getUTCMonth());
  if (now.getUTCDate() < snapshot.getUTCDate()) {
    months -= 1;
  }
  return months;
}

/**
 * Generic snapshot-freshness evaluator shared by the federal-, state-,
 * and local-tier evaluators. Caller is responsible for the
 * `layerKind → thresholdMonths` lookup; this helper just does the
 * calendar math and the null-guarding shared by every tier.
 *
 * Returns `null` when:
 *   - `thresholdMonths` is `undefined` (caller's `layerKind` was not
 *     in the registry — caller short-circuits and lets another tier
 *     try);
 *   - `snapshotDate` is missing, malformed, or parses to `NaN` (the
 *     row simply has no provenance to evaluate, so the FE should
 *     suppress the badge entirely rather than guessing);
 *   - the snapshot date is in the *future* relative to `now` (a
 *     producer clock skew or a fixture typo — we don't want to claim
 *     "-3 months old" or to flip the badge into a meaningless state).
 *
 * `now` is injectable so unit tests can pin a stable "today" without
 * faking the system clock.
 */
export function evaluateSnapshotFreshness(
  thresholdMonths: number | undefined,
  snapshotDate: string | Date | null | undefined,
  now: Date,
): SnapshotFreshness | null {
  if (thresholdMonths === undefined) return null;
  if (snapshotDate === null || snapshotDate === undefined) return null;
  const snap =
    snapshotDate instanceof Date ? snapshotDate : new Date(snapshotDate);
  if (Number.isNaN(snap.getTime())) return null;
  if (snap.getTime() > now.getTime()) return null;
  const ageMonths = Math.max(0, wholeMonthsBetween(snap, now));
  return {
    ageMonths,
    thresholdMonths,
    isStale: ageMonths >= thresholdMonths,
  };
}
