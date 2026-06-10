/**
 * Plain-English summary chips for local-tier adapter payloads.
 *
 * Mirrors the pattern in `../federal/summaries.ts` and `../state/summaries.ts`.
 * Local-tier coverage (current pilot set):
 *   - Grand County, UT (Moab):     parcels, zoning, roads
 *   - Lemhi County, ID (Salmon):   parcels, zoning, roads
 *   - Bastrop County, TX:          parcels, zoning, floodplain
 *
 * The parcel formatter is shared with the state tier (UGRC / INSIDE
 * Idaho parcels emit the same `{ kind: "parcel", parcel: {...} }`
 * shape as the county adapters), so we import it here rather than
 * duplicating it.
 *
 * As with the federal/state formatters:
 *   - every formatter accepts `unknown` and degrades to a "no data"
 *     chip when fields are missing or malformed;
 *   - the dispatcher returns `null` for any layer kind that is not a
 *     local-tier layer.
 */

import {
  diffPayloadByFields,
  evaluateSnapshotFreshness,
  FLOOD_ZONE_KEYS,
  isRecord,
  PAYLOAD_DIFF_NONE,
  pickFirstString,
  pickNumber,
  pickString,
  ZONING_CODE_KEYS,
  ZONING_DESC_KEYS,
  type PayloadDiffField,
  type PayloadFieldChange,
  type SnapshotFreshness,
} from "../_payloadSummaryHelpers";
import {
  BASTROP_FLOODPLAIN_FRESHNESS_THRESHOLD_MONTHS,
  BASTROP_PARCELS_FRESHNESS_THRESHOLD_MONTHS,
  BASTROP_ZONING_FRESHNESS_THRESHOLD_MONTHS,
} from "./bastrop-tx";
import {
  GRAND_COUNTY_PARCELS_FRESHNESS_THRESHOLD_MONTHS,
  GRAND_COUNTY_ROADS_FRESHNESS_THRESHOLD_MONTHS,
  GRAND_COUNTY_ZONING_FRESHNESS_THRESHOLD_MONTHS,
} from "./grand-county-ut";
import {
  LEMHI_COUNTY_PARCELS_FRESHNESS_THRESHOLD_MONTHS,
  LEMHI_COUNTY_ROADS_FRESHNESS_THRESHOLD_MONTHS,
  LEMHI_COUNTY_ZONING_FRESHNESS_THRESHOLD_MONTHS,
} from "./lemhi-county-id";
import {
  PARCEL_PAYLOAD_FIELDS,
  summarizeParcelPayload,
} from "../state/summaries";

/** Layer kinds emitted by the local-tier adapters. */
export type LocalLayerKind =
  | "grand-county-ut-parcels"
  | "grand-county-ut-zoning"
  | "grand-county-ut-roads"
  | "lemhi-county-id-parcels"
  | "lemhi-county-id-zoning"
  | "lemhi-county-id-roads"
  | "bastrop-tx-parcels"
  | "bastrop-tx-zoning"
  | "bastrop-tx-floodplain";

/**
 * Per-dataset "snapshot is still trustworthy" windows for the
 * local-tier adapters, in whole months. Mirrors the federal- and
 * state-tier registry pattern: numbers live with the adapters they
 * belong to, and the `layerKind → threshold` lookup is centralized
 * here so the FE doesn't import every county adapter file just to
 * render the stale badge on the provenance footer.
 */
const LOCAL_FRESHNESS_THRESHOLD_MONTHS: Record<LocalLayerKind, number> = {
  "grand-county-ut-parcels": GRAND_COUNTY_PARCELS_FRESHNESS_THRESHOLD_MONTHS,
  "grand-county-ut-zoning": GRAND_COUNTY_ZONING_FRESHNESS_THRESHOLD_MONTHS,
  "grand-county-ut-roads": GRAND_COUNTY_ROADS_FRESHNESS_THRESHOLD_MONTHS,
  "lemhi-county-id-parcels": LEMHI_COUNTY_PARCELS_FRESHNESS_THRESHOLD_MONTHS,
  "lemhi-county-id-zoning": LEMHI_COUNTY_ZONING_FRESHNESS_THRESHOLD_MONTHS,
  "lemhi-county-id-roads": LEMHI_COUNTY_ROADS_FRESHNESS_THRESHOLD_MONTHS,
  "bastrop-tx-parcels": BASTROP_PARCELS_FRESHNESS_THRESHOLD_MONTHS,
  "bastrop-tx-zoning": BASTROP_ZONING_FRESHNESS_THRESHOLD_MONTHS,
  "bastrop-tx-floodplain": BASTROP_FLOODPLAIN_FRESHNESS_THRESHOLD_MONTHS,
};

function isLocalLayerKindStr(kind: string): kind is LocalLayerKind {
  return Object.prototype.hasOwnProperty.call(
    LOCAL_FRESHNESS_THRESHOLD_MONTHS,
    kind,
  );
}

/**
 * Evaluate a local-tier briefing source's snapshot date against its
 * adapter-declared freshness window. Parallel to
 * `evaluateFederalSnapshotFreshness` and
 * `evaluateStateSnapshotFreshness` — same {@link SnapshotFreshness}
 * shape so the FE renders a single badge component regardless of
 * which tier produced the row. Returns `null` when:
 *
 *   - `layerKind` is not a local-tier layer;
 *   - `snapshotDate` is missing, malformed, or parses to `NaN`;
 *   - the snapshot date is in the *future* relative to `now`.
 *
 * `now` is injectable so unit tests can pin a stable "today" without
 * faking the system clock.
 */
export function evaluateLocalSnapshotFreshness(
  layerKind: string,
  snapshotDate: string | Date | null | undefined,
  now: Date = new Date(),
): SnapshotFreshness | null {
  if (!isLocalLayerKindStr(layerKind)) return null;
  return evaluateSnapshotFreshness(
    LOCAL_FRESHNESS_THRESHOLD_MONTHS[layerKind],
    snapshotDate,
    now,
  );
}

/**
 * Zoning summary used by every county zoning adapter.
 *
 * Payload shape: `{ kind: "zoning", zoning: {attributes, ...} }`.
 * We try a small ranked list of common zoning-code column names and,
 * when present, append the human-readable district name.
 *
 * Examples:
 *   - code + description:  "Zoning R-1 · Single-Family Residential"
 *   - code only:           "Zoning R-1"
 *   - description only:    "Zoning: Single-Family Residential"
 *   - neither:             "Zoning polygon present"
 */
export function summarizeZoningPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "zoning") return null;
  const zoning = payload["zoning"];
  if (!isRecord(zoning)) return "Zoning polygon present";
  const attrs = isRecord(zoning["attributes"]) ? zoning["attributes"] : {};
  const code = pickFirstString(attrs, ZONING_CODE_KEYS);
  const desc = pickFirstString(attrs, ZONING_DESC_KEYS);
  if (code && desc) return `Zoning ${code} · ${desc}`;
  if (code) return `Zoning ${code}`;
  if (desc) return `Zoning: ${desc}`;
  return "Zoning polygon present";
}

/**
 * Roads summary covering both the county-GIS path and the OSM Overpass
 * fallback. The two paths emit different shapes:
 *
 *   - county-gis: `{ kind: "roads", source: "county-gis", features: [...] }`
 *   - osm:        `{ kind: "roads", source: "osm", radiusMeters, elements: [...] }`
 *
 * The chip surfaces the count and (for the OSM fallback) the search
 * radius so the source attribution stays glanceable.
 *
 * Examples:
 *   - county-gis, 3 features:   "3 road segments (county GIS)"
 *   - county-gis, 1 feature:    "1 road segment (county GIS)"
 *   - osm fallback, 2 + 100m:   "2 road segments within 100m (OSM)"
 *   - empty:                    "No roads recorded near this point"
 *   - missing source tag:       "<n> road segments"
 */
export function summarizeRoadsPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "roads") return null;
  const source = pickString(payload["source"]);
  const features = payload["features"];
  const elements = payload["elements"];
  // Count whichever array the producer wrote — the two adapter paths
  // each pick exactly one — falling back to 0 when neither is present.
  let count = 0;
  if (Array.isArray(features)) count = features.length;
  else if (Array.isArray(elements)) count = elements.length;
  if (count <= 0) return "No roads recorded near this point";
  const noun = count === 1 ? "segment" : "segments";
  if (source === "osm") {
    const radius = pickNumber(payload["radiusMeters"]);
    if (radius !== null) {
      return `${count} road ${noun} within ${radius}m (OSM)`;
    }
    return `${count} road ${noun} (OSM)`;
  }
  if (source === "county-gis") {
    return `${count} road ${noun} (county GIS)`;
  }
  return `${count} road ${noun}`;
}

/**
 * Bastrop County floodplain summary.
 *
 * Payload shape: `{ kind: "floodplain", inMappedFloodplain: bool, features: [...] }`.
 * The adapter always emits a row (even when the parcel is outside the
 * mapped floodplain) so the chip needs to express both verdicts. When
 * the parcel is inside the floodplain we surface the FEMA-derived
 * `FLD_ZONE` from the first feature when present.
 *
 * Examples:
 *   - in floodplain w/ zone:   "In mapped floodplain (Zone AE)"
 *   - in floodplain, no zone:  "In mapped floodplain"
 *   - outside floodplain:      "Outside mapped floodplain"
 */
export function summarizeFloodplainPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "floodplain") return null;
  const inFlood = payload["inMappedFloodplain"] === true;
  if (!inFlood) return "Outside mapped floodplain";
  const features = payload["features"];
  if (Array.isArray(features) && features.length > 0) {
    const first = features[0];
    if (isRecord(first)) {
      const attrs = isRecord(first["attributes"]) ? first["attributes"] : {};
      const zone = pickFirstString(attrs, [
        "FLD_ZONE",
        "ZONE",
        "FloodZone",
        "FLOOD_ZONE",
      ]);
      if (zone) return `In mapped floodplain (Zone ${zone})`;
    }
  }
  return "In mapped floodplain";
}

/**
 * Single-entry-point dispatcher used by the Site Context tab. Routes
 * by `layerKind`; returns `null` for any layer kind that is not a
 * local-tier adapter.
 */
export function summarizeLocalPayload(
  layerKind: string,
  payload: unknown,
): string | null {
  switch (layerKind) {
    case "grand-county-ut-parcels":
    case "lemhi-county-id-parcels":
    case "bastrop-tx-parcels":
      return summarizeParcelPayload(payload);
    case "grand-county-ut-zoning":
    case "lemhi-county-id-zoning":
    case "bastrop-tx-zoning":
      return summarizeZoningPayload(payload);
    case "grand-county-ut-roads":
    case "lemhi-county-id-roads":
      return summarizeRoadsPayload(payload);
    case "bastrop-tx-floodplain":
      return summarizeFloodplainPayload(payload);
    default:
      return null;
  }
}

/**
 * Per-layer payload-diff field configs for the local-tier adapters.
 * Each formatter mirrors the wording / units of the inline summary
 * chip so an architect comparing reruns sees the same vocabulary in
 * the reveal that they're already familiar with from the row chip.
 *
 * Parcel rows reuse {@link PARCEL_PAYLOAD_FIELDS} from the state-tier
 * config — UGRC, INSIDE Idaho, and the three county parcel adapters
 * all emit the same `{ kind: "parcel", parcel }` shape, so we point
 * at the same array rather than duplicating it.
 */
const ZONING_PAYLOAD_FIELDS: ReadonlyArray<PayloadDiffField> = [
  {
    key: "zoningCode",
    label: "Zoning code",
    format: (p) => {
      const zoning = p["zoning"];
      if (!isRecord(zoning)) return PAYLOAD_DIFF_NONE;
      const attrs = isRecord(zoning["attributes"]) ? zoning["attributes"] : {};
      return pickFirstString(attrs, ZONING_CODE_KEYS) ?? PAYLOAD_DIFF_NONE;
    },
  },
  {
    key: "zoningDescription",
    label: "District",
    format: (p) => {
      const zoning = p["zoning"];
      if (!isRecord(zoning)) return PAYLOAD_DIFF_NONE;
      const attrs = isRecord(zoning["attributes"]) ? zoning["attributes"] : {};
      return pickFirstString(attrs, ZONING_DESC_KEYS) ?? PAYLOAD_DIFF_NONE;
    },
  },
];

/**
 * Roads adapters emit one of two shapes depending on whether the
 * county GIS endpoint was reachable; the diff treats both alike,
 * counting whichever array is present and surfacing a normalized
 * source label so a fallback flip from "county-gis" → "osm" reads
 * as a real change rather than a no-op.
 */
function roadsCount(p: Record<string, unknown>): number | null {
  const features = p["features"];
  if (Array.isArray(features)) return features.length;
  const elements = p["elements"];
  if (Array.isArray(elements)) return elements.length;
  return null;
}

function roadsSourceLabel(p: Record<string, unknown>): string {
  const src = pickString(p["source"]);
  if (src === "osm") return "OpenStreetMap";
  if (src === "county-gis") return "County GIS";
  return src ?? PAYLOAD_DIFF_NONE;
}

const ROADS_PAYLOAD_FIELDS: ReadonlyArray<PayloadDiffField> = [
  {
    key: "roadCount",
    label: "Road segments",
    format: (p) => {
      const count = roadsCount(p);
      return count === null ? PAYLOAD_DIFF_NONE : String(count);
    },
  },
  {
    key: "source",
    label: "Source",
    format: roadsSourceLabel,
  },
];

const FLOODPLAIN_PAYLOAD_FIELDS: ReadonlyArray<PayloadDiffField> = [
  {
    key: "inMappedFloodplain",
    label: "In floodplain",
    format: (p) => {
      const v = p["inMappedFloodplain"];
      if (v === true) return "Yes";
      if (v === false) return "No";
      return PAYLOAD_DIFF_NONE;
    },
  },
  {
    key: "floodZone",
    label: "Flood zone",
    format: (p) => {
      const features = p["features"];
      if (!Array.isArray(features) || features.length === 0) {
        return PAYLOAD_DIFF_NONE;
      }
      const first = features[0];
      if (!isRecord(first)) return PAYLOAD_DIFF_NONE;
      const attrs = isRecord(first["attributes"]) ? first["attributes"] : {};
      return pickFirstString(attrs, FLOOD_ZONE_KEYS) ?? PAYLOAD_DIFF_NONE;
    },
  },
];

const LOCAL_PAYLOAD_FIELDS: Record<
  LocalLayerKind,
  ReadonlyArray<PayloadDiffField>
> = {
  "grand-county-ut-parcels": PARCEL_PAYLOAD_FIELDS,
  "lemhi-county-id-parcels": PARCEL_PAYLOAD_FIELDS,
  "bastrop-tx-parcels": PARCEL_PAYLOAD_FIELDS,
  "grand-county-ut-zoning": ZONING_PAYLOAD_FIELDS,
  "lemhi-county-id-zoning": ZONING_PAYLOAD_FIELDS,
  "bastrop-tx-zoning": ZONING_PAYLOAD_FIELDS,
  "grand-county-ut-roads": ROADS_PAYLOAD_FIELDS,
  "lemhi-county-id-roads": ROADS_PAYLOAD_FIELDS,
  "bastrop-tx-floodplain": FLOODPLAIN_PAYLOAD_FIELDS,
};

function isLocalLayerKind(kind: string): kind is LocalLayerKind {
  return Object.prototype.hasOwnProperty.call(LOCAL_PAYLOAD_FIELDS, kind);
}

/**
 * Diff a prior local-adapter payload against the current row's
 * payload. See `diffStatePayload` / `diffFederalPayload` for the
 * shared contract — same `null` semantics for non-local layer kinds,
 * non-record payloads, mismatched payload `kind`s; returns an empty
 * array when the kinds match and every key formats identically.
 */
export function diffLocalPayload(
  layerKind: string,
  priorPayload: unknown,
  currentPayload: unknown,
): PayloadFieldChange[] | null {
  if (!isLocalLayerKind(layerKind)) return null;
  if (!isRecord(priorPayload) || !isRecord(currentPayload)) return null;
  const priorKind = priorPayload["kind"];
  const currentKind = currentPayload["kind"];
  if (typeof priorKind !== "string" || typeof currentKind !== "string") {
    return null;
  }
  if (priorKind !== currentKind) return null;
  return diffPayloadByFields(
    LOCAL_PAYLOAD_FIELDS[layerKind],
    priorPayload,
    currentPayload,
  );
}
