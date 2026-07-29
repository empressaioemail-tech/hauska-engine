/**
 * SHEET STANDARD v1.0 formatting + prose-hygiene utilities (§11, §12, §13).
 * See SHEET_STANDARD_v1.html (this directory) — the binding renderer standard.
 *
 * §12 · NUMBER AND UNIT FORM: thousands separator on every quantity ≥ 1,000;
 * feet take a prime (15'); areas read "sq ft" (never "sqft" / "ft²"); scale
 * reads 1" = 29'; ranges take a spaced en dash; acreage to two decimals in
 * parentheses after square feet.
 *
 * §11 · PROSE HYGIENE: nothing on the sheet may contain a machine identifier,
 * a colon-delimited code, a nested parenthesis, or a clause repeating a source
 * name. Every reason is one sentence, sentence case, ends in a period,
 * ≤12 words. Machine codes appear only in the provenance source column.
 */

/** Thousands separator on every quantity ≥ 1,000 (§12). */
export function formatThousands(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Feet with a prime mark: 15' / 98.3' (§12). */
export function formatFeetPrime(feet: number, decimals: number = 0): string {
  const v = decimals > 0 ? feet.toFixed(decimals) : String(Math.round(feet));
  const withSep =
    Math.abs(feet) >= 1000
      ? Number(v).toLocaleString("en-US", {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        })
      : v;
  return `${withSep}'`;
}

/** Area in "sq ft" form with thousands separator: "16,111 sq ft" (§12). */
export function formatSqFt(n: number): string {
  return `${formatThousands(n)} sq ft`;
}

/** Header-stat SF form: "16,111 SF" (§2). */
export function formatSf(n: number): string {
  return `${formatThousands(n)} SF`;
}

/** Acreage qualifier: "(0.37 acres)" — two decimals, after square feet (§12). */
export function formatAcresQualifier(sqFt: number): string {
  return `(${(sqFt / 43560).toFixed(2)} acres)`;
}

/** Scale ratio with a prime mark: 1" = 29' (§12). */
export function formatScaleRatio(feetPerInch: number): string {
  return `1" = ${formatFeetPrime(feetPerInch)}`;
}

/** Metres take a space and "m": "141.2 m" (§12). */
export function formatMeters(m: number, decimals: number = 1): string {
  return `${m.toFixed(decimals)} m`;
}

/** Range with a spaced en dash: "141.2 – 144.3 m" (§12). */
export function formatMetersRange(min: number, max: number): string {
  return `${min.toFixed(1)} – ${formatMeters(max)}`;
}

/** Setbacks F / S / R value line with primes: "15' / 5' / 15'" (§12). */
export function formatSetbacksFSR(front: number, side: number, rear: number): string {
  return `${formatFeetPrime(front)} / ${formatFeetPrime(side)} / ${formatFeetPrime(rear)}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Chips (§6) — identical wording every time, no second spelling of a state.
// ─────────────────────────────────────────────────────────────────────────
export const CHIP_UNAVAILABLE = "UNAVAILABLE";
export const CHIP_FIXTURE_LABEL = "FIXTURE LABEL";
export const CHIP_NO_ADDRESS = "NO ADDRESS";

// ─────────────────────────────────────────────────────────────────────────
// Confidence enum (§13): asserted · rule · sample · centerline accurate ·
// honest absence · honest unavailable, plus at most one qualifier.
// ─────────────────────────────────────────────────────────────────────────
export const CONFIDENCE = {
  asserted: "asserted",
  rule: "rule",
  sample: "sample",
  centerlineAccurate: "centerline accurate",
  honestAbsence: "honest absence",
  honestUnavailable: "honest unavailable",
} as const;

export type ConfidenceEnum = (typeof CONFIDENCE)[keyof typeof CONFIDENCE];

/** Confidence cell: enum plus at most one qualifier (§13). */
export function confidenceCell(base: ConfidenceEnum, qualifier?: string): string {
  return qualifier ? `${base} · ${qualifier}` : base;
}

// ─────────────────────────────────────────────────────────────────────────
// Reason sentences (§6 + §11): one plain sentence, sentence case, ≤12 words,
// ends in a period, no machine identifiers, no nested parentheses. Upstream
// reasons are accepted only when they already satisfy the rule; otherwise the
// fixed fallback for the context is used — machine detail stays in the
// provenance source column and the model, never on the sheet.
// ─────────────────────────────────────────────────────────────────────────

/** Fixed §6 reason sentences per honest-absence context. */
export const REASON = {
  noAddress: "No addressed record on file for this parcel.",
  noCountyName: "County name is not on file for this parcel.",
  noZoning: "No zoning record on file for this parcel.",
  noSetbackRule: "No setback rule on file; setbacks not specified or verified.",
  setbacksConsumeLot: "Setbacks exceed the lot; no buildable margin remains.",
  noStreet: "No road node attaches to this parcel.",
  floodNotQueried: "Flood data was not queried on this run.",
  noCaptureDate: "Provider basemap does not publish a capture date.",
  imageryFetchFailed: "Imagery fetch failed on this run.",
  registrationNotComputable: "Registration tolerance could not be computed.",
} as const;

const MACHINE_CODE_RE = /(?:[A-Za-z0-9]+[:_/][A-Za-z0-9_./-]+)|(?:\b[a-z]+(?:-[a-z]+){2,}\b)/;
const NESTED_PAREN_RE = /\([^()]*\(/;

/** True when a string satisfies §11 (usable verbatim as a sheet reason). */
export function isCleanReasonSentence(raw: string): boolean {
  const s = raw.trim();
  if (s.length === 0) return false;
  if (!/[.]$/.test(s)) return false;
  if (s.split(/\s+/).length > 12) return false;
  // A colon anywhere marks a machine-composed string ("lookup failed: ..."),
  // not a plain sentence — the 2026-07-28 live sheet leaked exactly this
  // shape past the tighter code-pattern regex below. §11: no colon-delimited
  // strings on the sheet, ever.
  if (s.includes(":")) return false;
  if (MACHINE_CODE_RE.test(s)) return false;
  if (NESTED_PAREN_RE.test(s)) return false;
  return true;
}

/**
 * Returns the upstream reason when it already satisfies §11, else the fixed
 * fallback sentence for the context. Never fabricates, never leaks codes.
 */
export function sheetReason(raw: string | undefined | null, fallback: string): string {
  if (raw && isCleanReasonSentence(raw)) return raw.trim();
  return fallback;
}

// ─────────────────────────────────────────────────────────────────────────
// §11 street + county display guards (Standard v1.2). Machine road-node ids
// ("48021:ROAD:323692301") and raw county FIPS codes never reach the sheet.
// ─────────────────────────────────────────────────────────────────────────

/**
 * §11 (v1.2): a road labels/reads by its DISPLAY NAME only. Returns the
 * trimmed name, or null when the road has no display name — an empty string
 * or any colon-delimited machine identifier (road-node ids are
 * `{fips}:ROAD:{wayId}`). Unnamed roads still draw; they carry no name text.
 */
export function streetDisplayName(name: string | undefined | null): string | null {
  const s = (name ?? "").trim();
  if (s.length === 0) return null;
  if (s.includes(":")) return null; // machine-shaped (§11: no colon-delimited codes)
  return s;
}

const ROAD_NODE_ID_RE = /\d{4,6}:ROAD:\S*/gi;

/**
 * §11 (v1.2): machine road-node IDs never appear ANYWHERE on any sheet —
 * including the provenance SOURCE column (which may carry other machine
 * refs). A road-id-shaped ref reads as "road-node ledger" instead.
 */
export function sheetSafeStreetSource(ref: string | undefined | null): string {
  const s = (ref ?? "").trim();
  if (s.length === 0) return "road-node ledger";
  if (ROAD_NODE_ID_RE.test(s)) {
    ROAD_NODE_ID_RE.lastIndex = 0;
    return "road-node ledger";
  }
  ROAD_NODE_ID_RE.lastIndex = 0;
  return s;
}

/**
 * §11 (v1.2): the county reads by NAME when known ("Bastrop County"); when
 * only a FIPS-shaped code is available the county is OMITTED — a raw code
 * ("48021") never prints in the header meta line or the summary County row.
 */
export function countyDisplayName(name: string | undefined | null): string | undefined {
  const s = (name ?? "").trim();
  if (s.length === 0) return undefined;
  if (/^\d{3,6}$/.test(s)) return undefined; // raw county FIPS, not a name
  return s;
}

/** Plain-language mapping of the front-edge basis (machine codes stay off the sheet, §11). */
export function describeSetbackBasis(basis: string): string {
  if (basis === "front-edge-hint") return "basis: resolved road anchor";
  if (basis.startsWith("geometric-heuristic")) return "basis: front edge estimated by geometry";
  if (basis === "unresolved-uniform-min") return "basis: uniform minimum on every edge";
  return "basis: rule on file";
}
