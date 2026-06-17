/**
 * Plain-English summary chips for federal-tier adapter payloads.
 *
 * The Site Context tab renders one row per persisted `briefing_sources`
 * record. The federal adapters in this directory each persist a small
 * structured payload (FEMA flood-zone code, USGS elevation, EPA
 * EJScreen percentiles, FCC broadband tiers) but the row UI only
 * renders the layer kind + provider by default — reviewers had to
 * expand "View layer details" to see the actual reading.
 *
 * These formatters produce a single short string suitable for a chip
 * shown inline on the row (e.g. "Flood Zone: AE", "Elevation: 4,033 ft",
 * "EJ Index 65th pctile", "Up to 1 Gbps · 2 providers"). They:
 *
 *   - never throw — every formatter accepts `unknown` and degrades to
 *     a "no data" string when fields are missing or malformed;
 *   - return `null` when there is genuinely nothing to summarize so
 *     the caller can choose to omit the chip entirely;
 *   - mirror the adapter `note` semantics for the "no coverage" cases
 *     (e.g. FEMA's empty-features path → "No mapped flood risk").
 *
 * The shared {@link summarizeFederalPayload} entry point routes by
 * `layerKind` so callers don't have to import each formatter
 * individually. Unknown layer kinds return `null` (FE falls back to
 * its existing rendering).
 */

/**
 * Layer kinds emitted by the federal adapters in this directory. We
 * keep this aligned with the `layerKind` field on each adapter; if a
 * new federal adapter ships, add its kind here so the registry
 * picks it up.
 */
import {
  evaluateSnapshotFreshness,
  isRecord,
  pickNumber,
  pickString,
  type SnapshotFreshness,
} from "../_payloadSummaryHelpers";
import { FEMA_NFHL_FRESHNESS_THRESHOLD_MONTHS } from "./fema-nfhl";
import { USGS_NED_FRESHNESS_THRESHOLD_MONTHS } from "./usgs-ned";
import { EPA_EJSCREEN_FRESHNESS_THRESHOLD_MONTHS } from "./epa-ejscreen";
import { FCC_BROADBAND_FRESHNESS_THRESHOLD_MONTHS } from "./fcc-broadband";
import { USDA_SSURGO_FRESHNESS_THRESHOLD_MONTHS } from "./usda-ssurgo";
import { USGS_GEOLOGY_FRESHNESS_THRESHOLD_MONTHS } from "./usgs-geology";
import { USGS_GROUNDWATER_FRESHNESS_THRESHOLD_MONTHS } from "./usgs-groundwater";
import { USGS_SEISMIC_FRESHNESS_THRESHOLD_MONTHS } from "./usgs-seismic";

export type FederalLayerKind =
  | "fema-nfhl-flood-zone"
  | "usgs-ned-elevation"
  | "epa-ejscreen-blockgroup"
  | "fcc-broadband-availability"
  | "usda-ssurgo-soils"
  | "usgs-geology"
  | "usgs-groundwater"
  | "usgs-seismic";

/**
 * Per-dataset "snapshot is still trustworthy" windows, in whole months.
 * The actual numbers live with the adapters they belong to (so a future
 * tweak to e.g. the FCC BDC publishing cadence travels with the FCC
 * adapter), but we centralize the `layerKind → threshold` lookup here
 * so the FE doesn't have to import every adapter file just to render
 * the stale badge on the provenance footer.
 */
const FEDERAL_FRESHNESS_THRESHOLD_MONTHS: Record<FederalLayerKind, number> = {
  "fema-nfhl-flood-zone": FEMA_NFHL_FRESHNESS_THRESHOLD_MONTHS,
  "usgs-ned-elevation": USGS_NED_FRESHNESS_THRESHOLD_MONTHS,
  "epa-ejscreen-blockgroup": EPA_EJSCREEN_FRESHNESS_THRESHOLD_MONTHS,
  "fcc-broadband-availability": FCC_BROADBAND_FRESHNESS_THRESHOLD_MONTHS,
  "usda-ssurgo-soils": USDA_SSURGO_FRESHNESS_THRESHOLD_MONTHS,
  "usgs-geology": USGS_GEOLOGY_FRESHNESS_THRESHOLD_MONTHS,
  "usgs-groundwater": USGS_GROUNDWATER_FRESHNESS_THRESHOLD_MONTHS,
  "usgs-seismic": USGS_SEISMIC_FRESHNESS_THRESHOLD_MONTHS,
};

/**
 * Verdict for a single federal-tier briefing source's snapshot date.
 *
 * Re-exported as a tier-specific name for backwards compatibility —
 * federal/state/local all return the same {@link SnapshotFreshness}
 * shape so the FE can render a single badge regardless of tier.
 */
export type FederalSnapshotFreshness = SnapshotFreshness;

function isFederalLayerKindStr(kind: string): kind is FederalLayerKind {
  return Object.prototype.hasOwnProperty.call(
    FEDERAL_FRESHNESS_THRESHOLD_MONTHS,
    kind,
  );
}

/**
 * Evaluate a federal-tier briefing source's snapshot date against its
 * adapter-declared freshness window. Returns `null` when:
 *
 *   - `layerKind` is not a federal-tier layer (state/local rows have
 *     their own evaluators — see `evaluateStateSnapshotFreshness` and
 *     `evaluateLocalSnapshotFreshness`);
 *   - `snapshotDate` is missing, malformed, or parses to `NaN`;
 *   - the snapshot date is in the *future* relative to `now`.
 *
 * Otherwise returns a {@link SnapshotFreshness} verdict the FE can
 * render: `isStale` drives the badge, `ageMonths` / `thresholdMonths`
 * populate the visible label and the screen-reader announcement.
 *
 * `now` is injectable so unit tests can pin a stable "today" without
 * faking the system clock.
 */
export function evaluateFederalSnapshotFreshness(
  layerKind: string,
  snapshotDate: string | Date | null | undefined,
  now: Date = new Date(),
): SnapshotFreshness | null {
  if (!isFederalLayerKindStr(layerKind)) return null;
  return evaluateSnapshotFreshness(
    FEDERAL_FRESHNESS_THRESHOLD_MONTHS[layerKind],
    snapshotDate,
    now,
  );
}

/**
 * Format a number as an ordinal percentile (e.g. 1 → "1st", 22 → "22nd",
 * 87 → "87th"). The EJScreen percentiles are integers in 0-100 so we
 * round to the nearest integer before applying the suffix.
 */
function ordinal(n: number): string {
  const rounded = Math.round(n);
  const mod100 = rounded % 100;
  const mod10 = rounded % 10;
  let suffix = "th";
  if (mod100 < 11 || mod100 > 13) {
    if (mod10 === 1) suffix = "st";
    else if (mod10 === 2) suffix = "nd";
    else if (mod10 === 3) suffix = "rd";
  }
  return `${rounded}${suffix}`;
}

/**
 * Format an Mbps reading as either "N Mbps" or, for 1000+, "N Gbps"
 * (with one decimal when the value isn't a whole gigabit). Keeps the
 * chip readable for fiber tiers that report 1000/2000/5000 Mbps.
 */
function formatMbps(mbps: number): string {
  if (mbps >= 1000) {
    const gbps = mbps / 1000;
    const rounded = Number.isInteger(gbps) ? gbps : Number(gbps.toFixed(1));
    return `${rounded} Gbps`;
  }
  return `${Math.round(mbps)} Mbps`;
}

/**
 * Format an elevation reading. We round to the nearest foot/meter for
 * the chip (the architect can open "View layer details" for the
 * full-precision reading) and group thousands so a 4-digit elevation
 * stays glanceable.
 */
function formatElevation(value: number, units: string): string {
  const rounded = Math.round(value);
  const grouped = rounded.toLocaleString("en-US");
  // Normalize the most common unit strings EPQS ships ("Feet", "Meters")
  // to short forms; pass anything else through verbatim so an unfamiliar
  // unit string isn't silently dropped.
  const normalized =
    units.toLowerCase() === "feet"
      ? "ft"
      : units.toLowerCase() === "meters"
        ? "m"
        : units;
  return `Elevation: ${grouped} ${normalized}`;
}

/**
 * FEMA National Flood Hazard Layer summary.
 *
 * Examples:
 *   - in SFHA with BFE:  "Flood Zone AE · BFE 425.5 ft"
 *   - in SFHA, no BFE:   "Flood Zone AE (high-risk)"
 *   - mapped, not SFHA:  "Flood Zone X"
 *   - empty features:    "No mapped flood risk (Zone X)"
 */
export function summarizeFemaNfhlPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "flood-zone") return null;
  const zone = pickString(payload["floodZone"]);
  const inSfha = payload["inSpecialFloodHazardArea"] === true;
  const bfe = pickNumber(payload["baseFloodElevation"]);
  if (!zone) {
    // Adapter emits a row with `floodZone: null` for parcels that fall
    // outside any mapped flood polygon; mirror its `note` wording so
    // the row reads consistently.
    return "No mapped flood risk (Zone X)";
  }
  if (inSfha) {
    if (bfe !== null) {
      return `Flood Zone ${zone} · BFE ${bfe} ft`;
    }
    return `Flood Zone ${zone} (high-risk)`;
  }
  return `Flood Zone ${zone}`;
}

/**
 * USGS National Elevation Dataset summary.
 *
 * Examples:
 *   - normal reading:    "Elevation: 4,033 ft"
 *   - off-raster (null): "Elevation: not available (off-raster)"
 */
export function summarizeUsgsNedPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "elevation-point") return null;
  const elevation = pickNumber(payload["elevationFeet"]);
  if (elevation === null) {
    return "Elevation: not available (off-raster)";
  }
  const units = pickString(payload["units"]) ?? "Feet";
  return formatElevation(elevation, units);
}

/**
 * EPA EJScreen block-group summary.
 *
 * The full payload exposes several percentiles; the chip leads with
 * the demographic index (the most-cited single number in EJScreen
 * reporting) and tucks the headline pollution percentile (PM2.5)
 * after it when both are present.
 *
 * Percentile basis: as of the 2026-05-23 CalEPA-mirror opt-in (see
 * `federal/epa-ejscreen.ts` STATUS + DELTA #2), the percentiles are
 * STATE-distribution, not US-distribution. The chip surfaces this with
 * a "state-pctile" suffix wherever a percentile renders so the reader
 * cannot silently misread a state-relative value as a nationwide one.
 * If/when the adapter swaps back to a US-percentile source, the
 * adapter's `payload.percentileBasis` field flips to "us" and this
 * chip drops back to the bare "pctile" wording.
 *
 * Examples (state-basis, current default):
 *   - both present:              "EJ Index 65th state-pctile · PM2.5 72nd state-pctile"
 *   - only demographic index:    "EJ Index 65th state-pctile"
 *   - only pollution percentile: "PM2.5 72nd state-pctile"
 *   - neither:                   "EJScreen indicators unavailable"
 */
export function summarizeEpaEjscreenPayload(
  payload: unknown,
): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "ejscreen-blockgroup") return null;
  const demo = pickNumber(payload["demographicIndexPercentile"]);
  const pm25 = pickNumber(payload["pm25Percentile"]);
  const basis = payload["percentileBasis"] === "state" ? "state-pctile" : "pctile";
  const parts: string[] = [];
  if (demo !== null) parts.push(`EJ Index ${ordinal(demo)} ${basis}`);
  if (pm25 !== null) parts.push(`PM2.5 ${ordinal(pm25)} ${basis}`);
  if (parts.length === 0) return "EJScreen indicators unavailable";
  return parts.join(" · ");
}

/**
 * FCC National Broadband Map summary.
 *
 * Examples:
 *   - 2 providers, fastest 1 Gbps:    "Up to 1 Gbps · 2 providers"
 *   - 1 provider, fastest 100 Mbps:   "Up to 100 Mbps · 1 provider"
 *   - providers but no Mbps reading:  "1 provider reported"
 *   - no providers (`providerCount` 0): "No fixed broadband reported"
 */
export function summarizeFccBroadbandPayload(
  payload: unknown,
): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "broadband-availability") return null;
  const providerCount = pickNumber(payload["providerCount"]) ?? 0;
  const fastest = pickNumber(payload["fastestDownstreamMbps"]);
  if (providerCount <= 0) {
    return "No fixed broadband reported";
  }
  const providerLabel = providerCount === 1 ? "provider" : "providers";
  if (fastest !== null) {
    return `Up to ${formatMbps(fastest)} · ${providerCount} ${providerLabel}`;
  }
  return `${providerCount} ${providerLabel} reported`;
}

/**
 * USDA SSURGO soils summary.
 *
 * Examples:
 *   - mapped unit: "Soils: Pf — Well drained · HSG C"
 *   - no attrs:    "Soils: Pf (Pflugerville-Rock outcrop complex)"
 */
export function summarizeUsdaSsurgoSoilsPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "ssurgo-soils") return null;
  const musym = pickString(payload["musym"]);
  const muname = pickString(payload["muname"]);
  const drainage = pickString(payload["drainageClass"]);
  const hsg = pickString(payload["hydrologicSoilGroup"]);
  const parts: string[] = [];
  if (musym) parts.push(`Soils: ${musym}`);
  else if (muname) parts.push(`Soils: ${muname}`);
  else return "SSURGO soils data unavailable";
  const detail: string[] = [];
  if (drainage) detail.push(drainage);
  if (hsg) detail.push(`HSG ${hsg}`);
  if (detail.length > 0) parts[0] = `${parts[0]} — ${detail.join(" · ")}`;
  return parts[0];
}

/**
 * USGS SGMC geology summary.
 */
export function summarizeUsgsGeologyPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "geology-formation") return null;
  const unitName = pickString(payload["unitName"]);
  const major = pickString(payload["majorLithology1"]);
  if (unitName && major) return `Geology: ${unitName} (${major})`;
  if (unitName) return `Geology: ${unitName}`;
  return "Geology: unit unavailable";
}

/**
 * USGS NWIS groundwater summary.
 */
export function summarizeUsgsGroundwaterPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "groundwater-monitoring") return null;
  const wellCount = pickNumber(payload["wellCount"]) ?? 0;
  const depth = pickNumber(payload["depthToWaterFeet"]);
  if (wellCount <= 0) return "No USGS groundwater wells nearby";
  if (depth !== null) {
    return `GW depth ${Math.round(depth)} ft · ${wellCount} well${wellCount === 1 ? "" : "s"} nearby`;
  }
  return `${wellCount} USGS groundwater well${wellCount === 1 ? "" : "s"} nearby`;
}

/**
 * USGS seismic design summary.
 */
export function summarizeUsgsSeismicPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "seismic-design") return null;
  const sdc = pickString(payload["seismicDesignCategory"]);
  const sds = pickNumber(payload["sds"]);
  const parts: string[] = [];
  if (sdc) parts.push(`SDC ${sdc}`);
  if (sds !== null) parts.push(`SDS ${sds.toFixed(2)}g`);
  if (parts.length === 0) return "Seismic design parameters unavailable";
  return `Seismic: ${parts.join(" · ")}`;
}

/**
 * Single-entry-point dispatcher used by the Site Context tab. Routes
 * by `layerKind`; returns `null` for any layer kind that is not a
 * federal-tier adapter (callers should fall back to their existing
 * rendering for those rows).
 */
export function summarizeFederalPayload(
  layerKind: string,
  payload: unknown,
): string | null {
  switch (layerKind) {
    case "fema-nfhl-flood-zone":
      return summarizeFemaNfhlPayload(payload);
    case "usgs-ned-elevation":
      return summarizeUsgsNedPayload(payload);
    case "epa-ejscreen-blockgroup":
      return summarizeEpaEjscreenPayload(payload);
    case "fcc-broadband-availability":
      return summarizeFccBroadbandPayload(payload);
    case "usda-ssurgo-soils":
      return summarizeUsdaSsurgoSoilsPayload(payload);
    case "usgs-geology":
      return summarizeUsgsGeologyPayload(payload);
    case "usgs-groundwater":
      return summarizeUsgsGroundwaterPayload(payload);
    case "usgs-seismic":
      return summarizeUsgsSeismicPayload(payload);
    default:
      return null;
  }
}

/**
 * One per-key payload delta surfaced by {@link diffFederalPayload}.
 * `key` is the underlying payload property name (stable, used as a
 * test-id and React key); `label` is the reader-friendly heading the
 * UI shows next to the before/after pair (matches the wording of the
 * inline summary chip — "Flood Zone", "BFE", "Elevation", …).
 */
export interface FederalPayloadFieldChange {
  key: string;
  label: string;
  before: string;
  after: string;
}

interface FederalPayloadField {
  key: string;
  label: string;
  format: (payload: Record<string, unknown>) => string;
}

/**
 * "(none)" mirrors the wording {@link formatBriefingDiffValue} uses
 * for missing metadata fields so the per-key payload reveal reads
 * consistently with the metadata table directly above it.
 */
const NONE = "(none)";

/**
 * Per-layer field readers keyed by `FederalLayerKind`. Each reader
 * pulls one value out of the structured payload and formats it the
 * same way the inline summary chip does (so an architect comparing
 * the rerun delta sees the same units / ordinal suffix / Mbps→Gbps
 * normalization they're already familiar with from the row itself).
 *
 * The list defines the *order* of rows in the "Payload changes"
 * table. Boolean/numeric/string fields are handled inline rather
 * than via a generic `pick*` so a malformed payload (missing key,
 * wrong type) degrades to "(none)" instead of throwing.
 */
const FEDERAL_PAYLOAD_FIELDS: Record<
  FederalLayerKind,
  ReadonlyArray<FederalPayloadField>
> = {
  "fema-nfhl-flood-zone": [
    {
      key: "floodZone",
      label: "Flood Zone",
      format: (p) => pickString(p["floodZone"]) ?? NONE,
    },
    {
      key: "inSpecialFloodHazardArea",
      label: "In SFHA",
      format: (p) => {
        const v = p["inSpecialFloodHazardArea"];
        if (v === true) return "Yes";
        if (v === false) return "No";
        return NONE;
      },
    },
    {
      key: "baseFloodElevation",
      label: "BFE",
      format: (p) => {
        const bfe = pickNumber(p["baseFloodElevation"]);
        return bfe === null ? NONE : `${bfe} ft`;
      },
    },
  ],
  "usgs-ned-elevation": [
    {
      key: "elevationFeet",
      label: "Elevation",
      format: (p) => {
        const elev = pickNumber(p["elevationFeet"]);
        if (elev === null) return NONE;
        const units = pickString(p["units"]) ?? "Feet";
        return formatElevation(elev, units).replace(/^Elevation:\s*/, "");
      },
    },
  ],
  "epa-ejscreen-blockgroup": [
    // QA-22 SCOPE A CalEPA-mirror opt-in (2026-05-23) — labels include
    // "(state %ile)" so the rerun-delta table surfaces the percentile
    // basis the same way the inline summary chip does. Reader cannot
    // silently misread a state-relative value as a US-relative one.
    {
      key: "demographicIndexPercentile",
      label: "EJ Index (state %ile)",
      format: (p) => {
        const v = pickNumber(p["demographicIndexPercentile"]);
        return v === null ? NONE : `${ordinal(v)} pctile`;
      },
    },
    {
      key: "pm25Percentile",
      label: "PM2.5 (state %ile)",
      format: (p) => {
        const v = pickNumber(p["pm25Percentile"]);
        return v === null ? NONE : `${ordinal(v)} pctile`;
      },
    },
  ],
  "fcc-broadband-availability": [
    {
      key: "providerCount",
      label: "Providers",
      format: (p) => {
        const v = pickNumber(p["providerCount"]);
        return v === null ? NONE : String(Math.round(v));
      },
    },
    {
      key: "fastestDownstreamMbps",
      label: "Fastest",
      format: (p) => {
        const v = pickNumber(p["fastestDownstreamMbps"]);
        return v === null ? NONE : formatMbps(v);
      },
    },
  ],
  "usda-ssurgo-soils": [
    {
      key: "musym",
      label: "Map symbol",
      format: (p) => pickString(p["musym"]) ?? NONE,
    },
    {
      key: "drainageClass",
      label: "Drainage",
      format: (p) => pickString(p["drainageClass"]) ?? NONE,
    },
    {
      key: "hydrologicSoilGroup",
      label: "HSG",
      format: (p) => pickString(p["hydrologicSoilGroup"]) ?? NONE,
    },
  ],
  "usgs-geology": [
    {
      key: "unitName",
      label: "Formation",
      format: (p) => pickString(p["unitName"]) ?? NONE,
    },
    {
      key: "majorLithology1",
      label: "Lithology",
      format: (p) => pickString(p["majorLithology1"]) ?? NONE,
    },
  ],
  "usgs-groundwater": [
    {
      key: "wellCount",
      label: "Wells",
      format: (p) => {
        const v = pickNumber(p["wellCount"]);
        return v === null ? NONE : String(Math.round(v));
      },
    },
    {
      key: "depthToWaterFeet",
      label: "Depth to water",
      format: (p) => {
        const v = pickNumber(p["depthToWaterFeet"]);
        return v === null ? NONE : `${Math.round(v)} ft`;
      },
    },
  ],
  "usgs-seismic": [
    {
      key: "seismicDesignCategory",
      label: "SDC",
      format: (p) => pickString(p["seismicDesignCategory"]) ?? NONE,
    },
    {
      key: "sds",
      label: "SDS",
      format: (p) => {
        const v = pickNumber(p["sds"]);
        return v === null ? NONE : `${v.toFixed(2)}g`;
      },
    },
  ],
};

function isFederalLayerKind(kind: string): kind is FederalLayerKind {
  return Object.prototype.hasOwnProperty.call(
    FEDERAL_PAYLOAD_FIELDS,
    kind,
  );
}

/**
 * Diff a prior federal-adapter payload against the current row's
 * payload, returning one {@link FederalPayloadFieldChange} per
 * payload key whose formatted value moved between the two reruns.
 *
 * Returns `null` (caller skips the "Payload changes" subsection)
 * when:
 *
 *   - `layerKind` is not a federal-tier adapter (state/local rows
 *     have less standardized payloads — see the task #211 brief);
 *   - either side's payload is not an object (manual-upload rows
 *     default to `{}` and would still be objects, but this guards
 *     against a producer accidentally writing a scalar);
 *   - the two payload `kind` discriminants differ — comparing a
 *     `flood-zone` payload against an `elevation-point` payload
 *     would emit a wall of garbage rows. A producer that has
 *     legitimately changed the payload `kind` between reruns
 *     should be looked at via the existing "View layer details"
 *     expander, not the rerun-delta surface.
 *
 * Returns an empty array when the kinds match and every key
 * formats to the same string (a true byte-identical rerun) — the
 * caller should then suppress the subsection so an architect
 * isn't shown an empty "Payload changes" heading.
 *
 * Otherwise returns one entry per moved key, in the order the
 * field list above declares (matches the order the inline summary
 * chip composes its parts so the reveal reads top-down the same
 * way the chip reads left-to-right).
 */
export function diffFederalPayload(
  layerKind: string,
  priorPayload: unknown,
  currentPayload: unknown,
): FederalPayloadFieldChange[] | null {
  if (!isFederalLayerKind(layerKind)) return null;
  if (!isRecord(priorPayload) || !isRecord(currentPayload)) return null;
  const priorKind = priorPayload["kind"];
  const currentKind = currentPayload["kind"];
  if (typeof priorKind !== "string" || typeof currentKind !== "string") {
    return null;
  }
  if (priorKind !== currentKind) return null;
  const fields = FEDERAL_PAYLOAD_FIELDS[layerKind];
  const changes: FederalPayloadFieldChange[] = [];
  for (const f of fields) {
    const before = f.format(priorPayload);
    const after = f.format(currentPayload);
    if (before !== after) {
      changes.push({ key: f.key, label: f.label, before, after });
    }
  }
  return changes;
}
