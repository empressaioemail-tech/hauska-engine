/**
 * Plain-English summary chips for state-tier adapter payloads.
 *
 * Mirrors the pattern in `../federal/summaries.ts`: each adapter that
 * persists a structured payload exposes a small formatter that turns
 * the payload into a one-line chip suitable for inline rendering on
 * the Site Context tab. The shared {@link summarizeStatePayload}
 * dispatcher routes by `layerKind`.
 *
 * State-tier coverage (current pilot set):
 *   - UGRC (Utah):              dem, parcels, address-points
 *   - INSIDE Idaho:             dem, parcels
 *   - TCEQ (Texas):             edwards-aquifer (recharge + contributing)
 *
 * As with the federal formatters:
 *   - every formatter accepts `unknown` and degrades to a "no data"
 *     chip when fields are missing or malformed;
 *   - the dispatcher returns `null` for any layer kind that is not a
 *     state-tier layer (so callers can fall through to the next tier).
 */

import {
  ADDRESS_FULL_KEYS,
  ADDRESS_NUMBER_KEYS,
  ADDRESS_STREET_KEYS,
  diffPayloadByFields,
  evaluateSnapshotFreshness,
  formatAcres,
  isRecord,
  PARCEL_ACRES_KEYS,
  PARCEL_ID_KEYS,
  PAYLOAD_DIFF_NONE,
  pickFirstNumber,
  pickFirstString,
  pickNumber,
  type PayloadDiffField,
  type PayloadFieldChange,
  type SnapshotFreshness,
} from "../_payloadSummaryHelpers";
import {
  INSIDE_IDAHO_DEM_FRESHNESS_THRESHOLD_MONTHS,
  INSIDE_IDAHO_PARCELS_FRESHNESS_THRESHOLD_MONTHS,
} from "./idaho";
import { TCEQ_EDWARDS_AQUIFER_FRESHNESS_THRESHOLD_MONTHS } from "./texas";
import {
  UGRC_ADDRESS_POINTS_FRESHNESS_THRESHOLD_MONTHS,
  UGRC_DEM_FRESHNESS_THRESHOLD_MONTHS,
  UGRC_PARCELS_FRESHNESS_THRESHOLD_MONTHS,
} from "./utah";

/** Layer kinds emitted by the state-tier adapters. */
export type StateLayerKind =
  | "ugrc-dem"
  | "ugrc-parcels"
  | "ugrc-address-points"
  | "inside-idaho-dem"
  | "inside-idaho-parcels"
  | "tceq-edwards-aquifer";

/**
 * Per-dataset "snapshot is still trustworthy" windows for the
 * state-tier adapters, in whole months. Mirrors the federal-tier
 * registry pattern (see `../federal/summaries.ts`): the actual
 * numbers live with the adapters they belong to so a future tweak
 * to e.g. UGRC's parcel-refresh cadence travels with the UGRC
 * adapter, but the `layerKind → threshold` lookup is centralized
 * here so the FE doesn't have to import every state adapter file
 * just to render the stale badge on the provenance footer.
 */
const STATE_FRESHNESS_THRESHOLD_MONTHS: Record<StateLayerKind, number> = {
  "ugrc-dem": UGRC_DEM_FRESHNESS_THRESHOLD_MONTHS,
  "ugrc-parcels": UGRC_PARCELS_FRESHNESS_THRESHOLD_MONTHS,
  "ugrc-address-points": UGRC_ADDRESS_POINTS_FRESHNESS_THRESHOLD_MONTHS,
  "inside-idaho-dem": INSIDE_IDAHO_DEM_FRESHNESS_THRESHOLD_MONTHS,
  "inside-idaho-parcels": INSIDE_IDAHO_PARCELS_FRESHNESS_THRESHOLD_MONTHS,
  "tceq-edwards-aquifer": TCEQ_EDWARDS_AQUIFER_FRESHNESS_THRESHOLD_MONTHS,
};

function isStateLayerKindStr(kind: string): kind is StateLayerKind {
  return Object.prototype.hasOwnProperty.call(
    STATE_FRESHNESS_THRESHOLD_MONTHS,
    kind,
  );
}

/**
 * Evaluate a state-tier briefing source's snapshot date against its
 * adapter-declared freshness window. Parallel to
 * `evaluateFederalSnapshotFreshness` — same {@link SnapshotFreshness}
 * shape so the FE renders a single badge component regardless of
 * which tier produced the row. Returns `null` when:
 *
 *   - `layerKind` is not a state-tier layer (callers should fall
 *     through to `evaluateLocalSnapshotFreshness`);
 *   - `snapshotDate` is missing, malformed, or parses to `NaN`;
 *   - the snapshot date is in the *future* relative to `now`.
 *
 * `now` is injectable so unit tests can pin a stable "today" without
 * faking the system clock.
 */
export function evaluateStateSnapshotFreshness(
  layerKind: string,
  snapshotDate: string | Date | null | undefined,
  now: Date = new Date(),
): SnapshotFreshness | null {
  if (!isStateLayerKindStr(layerKind)) return null;
  return evaluateSnapshotFreshness(
    STATE_FRESHNESS_THRESHOLD_MONTHS[layerKind],
    snapshotDate,
    now,
  );
}

/**
 * UGRC / INSIDE Idaho elevation-contour layer summary.
 *
 * Payload shape: `{ kind: "elevation-contours", featureCount, features }`.
 * The DEM layer returns zero contours when the lat/lng falls between
 * mapped intervals; we still emit a row in that case (it's not a "no
 * coverage" verdict — the parcel is still in-state), so the chip needs
 * a sensible empty state.
 *
 * Examples:
 *   - one contour:                     "1 elevation contour nearby"
 *   - many contours:                   "8 elevation contours nearby"
 *   - empty (between mapped contours): "No elevation contours nearby"
 */
export function summarizeElevationContoursPayload(
  payload: unknown,
): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "elevation-contours") return null;
  // Prefer the explicit count field; fall back to the array length so
  // the chip still works if the count gets dropped in transit.
  const count =
    pickNumber(payload["featureCount"]) ??
    (Array.isArray(payload["features"]) ? payload["features"].length : 0);
  if (count <= 0) return "No elevation contours nearby";
  const noun = count === 1 ? "contour" : "contours";
  return `${count} elevation ${noun} nearby`;
}

/**
 * Parcel summary used by both UGRC and INSIDE Idaho parcel adapters.
 *
 * Payload shape: `{ kind: "parcel", parcel: {attributes, geometry} | null, note? }`.
 * The UGRC parcels adapter persists `parcel: null` for points that fall
 * on public land (no parcel polygon). We mirror its `note` semantics
 * so the chip reads consistently with the row's existing note.
 *
 * Examples:
 *   - id + acres:                      "Parcel 01-12345 · 0.42 ac"
 *   - id only:                         "Parcel 01-12345"
 *   - acres only:                      "Parcel · 12.34 ac"
 *   - null (public land):              "No parcel at this point (public land)"
 *   - attributes empty:                "Parcel polygon present"
 */
export function summarizeParcelPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "parcel") return null;
  const parcel = payload["parcel"];
  if (parcel === null || parcel === undefined) {
    return "No parcel at this point (public land)";
  }
  if (!isRecord(parcel)) return "Parcel polygon present";
  const attrs = isRecord(parcel["attributes"]) ? parcel["attributes"] : {};
  const id = pickFirstString(attrs, PARCEL_ID_KEYS);
  const acres = pickFirstNumber(attrs, PARCEL_ACRES_KEYS);
  if (id && acres !== null) return `Parcel ${id} · ${formatAcres(acres)}`;
  if (id) return `Parcel ${id}`;
  if (acres !== null) return `Parcel · ${formatAcres(acres)}`;
  return "Parcel polygon present";
}

/**
 * UGRC address-point summary.
 *
 * Payload shape: `{ kind: "address-point", feature: {attributes, ...} }`.
 * UGRC address points expose the full address under `FullAdd` (their
 * canonical column) but other variants exist; we look at a small
 * ranked list and fall back to a (number + street) reconstruction.
 *
 * Examples:
 *   - full address present:            "Address: 100 Main St"
 *   - only number+street:              "Address: 100 Main St" (reconstructed)
 *   - neither:                         "Address point present"
 */
/**
 * Pull the best-available address string out of an address-point
 * feature's attributes, applying the same ranked-key fallbacks used
 * by the inline summary chip. Returns `null` when none of the
 * candidate columns produce a usable string.
 */
function extractAddressString(
  feature: Record<string, unknown>,
): string | null {
  const attrs = isRecord(feature["attributes"]) ? feature["attributes"] : {};
  const fullAddress = pickFirstString(attrs, ADDRESS_FULL_KEYS);
  if (fullAddress) return fullAddress;
  const number = pickFirstString(attrs, ADDRESS_NUMBER_KEYS);
  const street = pickFirstString(attrs, ADDRESS_STREET_KEYS);
  if (number && street) return `${number} ${street}`;
  if (street) return street;
  return null;
}

export function summarizeAddressPointPayload(
  payload: unknown,
): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "address-point") return null;
  const feature = payload["feature"];
  if (!isRecord(feature)) return "Address point present";
  const address = extractAddressString(feature);
  if (address) return `Address: ${address}`;
  return "Address point present";
}

/**
 * TCEQ Edwards Aquifer recharge + contributing zone summary.
 *
 * Payload shape: `{ kind: "edwards-aquifer", inRecharge, inContributing,
 * rechargeZone, contributingZone }`. The two zones overlap in places so
 * a parcel can be in both — we list them in regulatory severity order
 * (recharge first; recharge has the stricter water-quality rules).
 *
 * Examples:
 *   - recharge only:                   "In Edwards Aquifer recharge zone"
 *   - contributing only:               "In Edwards Aquifer contributing zone"
 *   - both:                            "In Edwards Aquifer recharge & contributing zones"
 *   - neither:                         "Outside Edwards Aquifer zones"
 */
export function summarizeEdwardsAquiferPayload(
  payload: unknown,
): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "edwards-aquifer") return null;
  const inRecharge = payload["inRecharge"] === true;
  const inContributing = payload["inContributing"] === true;
  if (inRecharge && inContributing) {
    return "In Edwards Aquifer recharge & contributing zones";
  }
  if (inRecharge) return "In Edwards Aquifer recharge zone";
  if (inContributing) return "In Edwards Aquifer contributing zone";
  return "Outside Edwards Aquifer zones";
}

/**
 * Single-entry-point dispatcher used by the Site Context tab. Routes
 * by `layerKind`; returns `null` for any layer kind that is not a
 * state-tier adapter (callers should fall back to the next tier or
 * to their existing rendering for those rows).
 */
export function summarizeStatePayload(
  layerKind: string,
  payload: unknown,
): string | null {
  switch (layerKind) {
    case "ugrc-dem":
    case "inside-idaho-dem":
      return summarizeElevationContoursPayload(payload);
    case "ugrc-parcels":
    case "inside-idaho-parcels":
      return summarizeParcelPayload(payload);
    case "ugrc-address-points":
      return summarizeAddressPointPayload(payload);
    case "tceq-edwards-aquifer":
      return summarizeEdwardsAquiferPayload(payload);
    default:
      return null;
  }
}

/**
 * Field config for the shared parcel payload (UGRC, INSIDE Idaho, and
 * every county parcel adapter all emit `{ kind: "parcel", parcel }`).
 *
 * Exported so the local-tier diff can reuse exactly the same field
 * order/labels — duplicating the config here would risk drift between
 * the state row reveal and the local row reveal for what is, from the
 * payload's perspective, the same shape.
 */
export const PARCEL_PAYLOAD_FIELDS: ReadonlyArray<PayloadDiffField> = [
  {
    key: "parcelPresent",
    label: "Parcel polygon",
    format: (p) => {
      const parcel = p["parcel"];
      // The producers explicitly persist `null` for points that fall
      // on public land (no parcel polygon). Treat `undefined` the same
      // way so a malformed payload doesn't show a confusing "Yes" row.
      if (parcel === null || parcel === undefined) return "None (public land)";
      if (!isRecord(parcel)) return PAYLOAD_DIFF_NONE;
      return "Present";
    },
  },
  {
    key: "parcelId",
    label: "Parcel ID",
    format: (p) => {
      const parcel = p["parcel"];
      if (!isRecord(parcel)) return PAYLOAD_DIFF_NONE;
      const attrs = isRecord(parcel["attributes"]) ? parcel["attributes"] : {};
      return pickFirstString(attrs, PARCEL_ID_KEYS) ?? PAYLOAD_DIFF_NONE;
    },
  },
  {
    key: "parcelAcres",
    label: "Acres",
    format: (p) => {
      const parcel = p["parcel"];
      if (!isRecord(parcel)) return PAYLOAD_DIFF_NONE;
      const attrs = isRecord(parcel["attributes"]) ? parcel["attributes"] : {};
      const acres = pickFirstNumber(attrs, PARCEL_ACRES_KEYS);
      return acres === null ? PAYLOAD_DIFF_NONE : formatAcres(acres);
    },
  },
];

/**
 * Per-layer field readers keyed by `StateLayerKind`. The list defines
 * the order of rows in the "Payload changes" reveal and each formatter
 * mirrors the corresponding inline summary chip's wording / units so
 * the rerun delta reads consistently with the row's existing chip.
 */
const ELEVATION_CONTOURS_FIELDS: ReadonlyArray<PayloadDiffField> = [
  {
    key: "featureCount",
    label: "Contours nearby",
    format: (p) => {
      // Same fallback chain as the chip — prefer the explicit count,
      // fall back to the array length so a payload missing the
      // count still produces a useful diff value.
      const count =
        pickNumber(p["featureCount"]) ??
        (Array.isArray(p["features"]) ? p["features"].length : null);
      return count === null ? PAYLOAD_DIFF_NONE : String(Math.round(count));
    },
  },
];

const STATE_PAYLOAD_FIELDS: Record<
  StateLayerKind,
  ReadonlyArray<PayloadDiffField>
> = {
  "ugrc-dem": ELEVATION_CONTOURS_FIELDS,
  "inside-idaho-dem": ELEVATION_CONTOURS_FIELDS,
  "ugrc-parcels": PARCEL_PAYLOAD_FIELDS,
  "inside-idaho-parcels": PARCEL_PAYLOAD_FIELDS,
  "ugrc-address-points": [
    {
      key: "address",
      label: "Address",
      format: (p) => {
        const feature = p["feature"];
        if (!isRecord(feature)) return PAYLOAD_DIFF_NONE;
        return extractAddressString(feature) ?? PAYLOAD_DIFF_NONE;
      },
    },
  ],
  "tceq-edwards-aquifer": [
    {
      key: "inRecharge",
      label: "Recharge zone",
      format: (p) => {
        const v = p["inRecharge"];
        if (v === true) return "Yes";
        if (v === false) return "No";
        return PAYLOAD_DIFF_NONE;
      },
    },
    {
      key: "inContributing",
      label: "Contributing zone",
      format: (p) => {
        const v = p["inContributing"];
        if (v === true) return "Yes";
        if (v === false) return "No";
        return PAYLOAD_DIFF_NONE;
      },
    },
  ],
};

function isStateLayerKind(kind: string): kind is StateLayerKind {
  return Object.prototype.hasOwnProperty.call(STATE_PAYLOAD_FIELDS, kind);
}

/**
 * Diff a prior state-adapter payload against the current row's
 * payload, returning one {@link PayloadFieldChange} per payload key
 * whose formatted value moved between the two reruns.
 *
 * Mirrors `diffFederalPayload`'s contract:
 *
 *   - returns `null` when `layerKind` is not a state-tier adapter
 *     (callers should fall through to `diffLocalPayload`);
 *   - returns `null` when either side's payload is not an object;
 *   - returns `null` when the two payload `kind` discriminants
 *     differ (a `parcel` ↔ `elevation-contours` comparison would
 *     just emit a wall of garbage rows; the architect should look
 *     at "View layer details" on both sides instead);
 *   - returns an empty array when the kinds match and every key
 *     formats to the same string — the caller suppresses the
 *     subsection so we don't show an empty "Payload changes" heading
 *     on a true byte-identical rerun.
 */
export function diffStatePayload(
  layerKind: string,
  priorPayload: unknown,
  currentPayload: unknown,
): PayloadFieldChange[] | null {
  if (!isStateLayerKind(layerKind)) return null;
  if (!isRecord(priorPayload) || !isRecord(currentPayload)) return null;
  const priorKind = priorPayload["kind"];
  const currentKind = currentPayload["kind"];
  if (typeof priorKind !== "string" || typeof currentKind !== "string") {
    return null;
  }
  if (priorKind !== currentKind) return null;
  return diffPayloadByFields(
    STATE_PAYLOAD_FIELDS[layerKind],
    priorPayload,
    currentPayload,
  );
}

