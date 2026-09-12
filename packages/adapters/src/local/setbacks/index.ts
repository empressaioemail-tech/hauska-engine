/**
 * Per-jurisdiction setback table loader.
 *
 * 2026-09-07: repointed to the published `@empressaio/setback-corpus`
 * package (item 4, setback-corpus consumer repointing) — the raw tables
 * this file used to vendor locally now live there as the single source of
 * truth shared with legacy-design-tools, proven equivalent by
 * `__tests__/corpus-divergence.test.ts` before this swap landed. The local
 * `<jurisdiction>.json` files stay on disk, untouched, ONLY as that test's
 * comparison baseline until they're formally retired — do not import them
 * from anywhere else in this package.
 *
 * This file keeps every jurisdiction-specific ROUTING/business rule that
 * was always engine-local (Bastrop per-parcel-record precedence, repealed
 * B3 Place Type filtering, BDC district classification, the elgin-tx
 * alias) — the corpus package is deliberately pure data and was never the
 * place for any of that.
 *
 * The briefing engine (DA-PI-3) calls {@link getSetbackTable} keyed by the
 * resolved jurisdiction key when it builds dimensional-rule prose.
 *
 * Adding a new jurisdiction: add it to `@empressaio/setback-corpus`
 * (see that package's own README), bump the dependency version here, and
 * add its key to `VENDORED_JURISDICTION_KEYS` below.
 */
import { getSetbackTable as getCorpusSetbackTable } from "@empressaio/setback-corpus";

export type { SetbackDistrict, SetbackTable } from "./table-types.js";
import type { SetbackDistrict, SetbackTable } from "./table-types.js";

import {
  setbackTableFromBastropPerParcelRecord,
} from "./bastrop-per-parcel-record.js";
import {
  dateFromTableEffectiveDate,
  resolveMostCurrentSetback,
  type SetbackCandidate,
} from "./most-current-setback-resolver.js";

/**
 * The jurisdictions this package actually serves — a curated subset of the
 * published corpus, matching this repo's own onboarding history (item-6
 * setback transcription, OPS-19b: Waco/Round Rock/Kyle land as-is per
 * operator go-ahead; Elgin ratified 2026-08-04; Georgetown/San Marcos
 * deliberately withheld pending their own caveats — see doc_repo). Not
 * every corpus jurisdiction is meant to be reachable here.
 */
const VENDORED_JURISDICTION_KEYS = [
  "grand-county-ut",
  "lemhi-county-id",
  "bastrop-tx",
  "bastrop-city-tx",
  "bastrop-development-code",
  "elgin-development-code",
  "elgin-tx",
  "austin-tx",
  "pflugerville-tx",
  "san-antonio-tx",
  "utah-unincorporated",
  "idaho-unincorporated",
  "waco-tx",
  "round-rock-tx",
  "kyle-tx",
] as const;

const SETBACK_TABLES: Readonly<Record<string, SetbackTable>> = Object.fromEntries(
  VENDORED_JURISDICTION_KEYS.map((key) => {
    const table = getCorpusSetbackTable(key);
    if (!table) {
      throw new Error(
        `@empressaio/setback-corpus does not carry "${key}", which this package still vendors locally — repoint regressed.`,
      );
    }
    return [key, table as SetbackTable];
  }),
);

export const SETBACK_JURISDICTION_KEYS = Object.keys(SETBACK_TABLES);

function normalizeJurisdictionKey(key: string): string {
  return key.toLowerCase().replace(/_/g, "-");
}

function leadingDistrictToken(districtName: string): string {
  return (districtName.trim().split(/\s+/)[0] ?? "").toUpperCase();
}

/** Repealed B3 Place Types — must not be served as current setback law. */
function isRepealedB3PlaceType(code: string): boolean {
  return (
    /^P-[1-5](?:$|[-_\s])/.test(code) ||
    /^P-(?:CS|EC)(?:$|[-_\s])/.test(code)
  );
}

/** BDC districts whose scalars live on layer 23 only (not ordinance chart). */
export function isBdcPerParcelDistrictCode(code: string): boolean {
  return /^(MU|GC|PDD|PI|IND|OS)(?:$|[-_\s])/.test(code) ||
    /^P\/OS(?:$|[-_\s])/.test(code) ||
    /^P-OS(?:$|[-_\s])/.test(code);
}

/** BDC Euclidean districts with ordinance-text scalar rows in bastrop-development-code. */
function isBdcEuclideanCode(code: string): boolean {
  return /^(SF-[123]|RR)(?:$|[-_\s])/.test(code);
}

/**
 * Any known BDC Chapter 14 district stamp (Euclidean + conditional).
 * Conditional codes (MU/GC/…) still route to the BDC table so callers
 * honest-decline on the missing row (CORRECTION C) instead of falling
 * through to the legacy bastrop-tx county table.
 */
function isKnownBdcDistrictCode(code: string): boolean {
  return isBdcEuclideanCode(code) || isBdcPerParcelDistrictCode(code);
}

function isBastropCityJurisdiction(normalizedKey: string): boolean {
  return (
    normalizedKey === "bastrop-tx" ||
    normalizedKey === "bastrop-city-tx" ||
    normalizedKey === "bastrop-development-code" ||
    normalizedKey === "bastrop-per-parcel-record"
  );
}

export type SetbackTableResolveOptions = {
  /**
   * Pre-fetched Bastrop layer-23 record (AMENDMENT 2+3). When set for a
   * Bastrop city jurisdiction, NUMBERS come from here — not
   * bastrop-development-code.json chart rows.
   */
  bastropPerParcelRecord?: import("./bastrop-per-parcel-record.js").BastropPerParcelSetbackParsed;
  /** District code for per-parcel row labeling (defaults to zoningCode arg). */
  districtCode?: string;
};

function tableHasDistrict(table: SetbackTable, code: string): boolean {
  const wanted = leadingDistrictToken(code);
  if (!wanted) return false;
  return table.districts.some(
    (d) => leadingDistrictToken(d.district_name) === wanted,
  );
}

/**
 * Returns the setback table for a jurisdiction key, or null if no table
 * exists. The briefing engine should treat null as "no codified
 * dimensional rules available — fall back to base IBC/IRC".
 */
export function getSetbackTable(jurisdictionKey: string): SetbackTable | null {
  return SETBACK_TABLES[normalizeJurisdictionKey(jurisdictionKey)] ?? null;
}

/**
 * Resolve the table for a parcel's stamped zoning code.
 *
 * City of Bastrop (current law = per-parcel layer 23, AMENDMENT 2+3):
 *   - When `options.bastropPerParcelRecord` is supplied, NUMBERS come from
 *     that record (cited to Ordinance_Link). Chart table is verification only.
 *   - Without a per-parcel record, returns bastrop-development-code for
 *     edition/citation lookup only — callers MUST NOT use chart scalars as
 *     warm authors for Bastrop city (fetch layer 23 first).
 *   - Repealed B3 Place Types (P-1..P-5, P-CS, P-EC) → null
 *     (honest-decline). Do NOT silently serve bastrop-city-tx as current.
 *   - MU / GC / PDD (layer 23 only): without `bastropPerParcelRecord` → null
 *     so callers fetch layer 23 instead of honest-decline on missing chart rows.
 *
 * County / other jurisdictions: fall through to the keyed table
 * (e.g. bastrop-tx legacy R-MD rows for non-city codes).
 */
/**
 * P-154 (R-1, most-current-source-wins) — Bastrop's own two-candidate case:
 * a codified Euclidean chart row (SF-1/SF-2/SF-3/RR) versus the live
 * per-parcel layer-23 record for that same district. Returns null when
 * there is no codified chart row to compare against (MU/GC/PDD/PI/IND/OS —
 * per-parcel-record-only districts, R13) — the caller then falls through
 * to the per-parcel record as the sole candidate, unchanged from before
 * this wave, since there is nothing to resolve BETWEEN.
 *
 * On a genuine conflict (disagreement with an unreadable date on either
 * side, or the resolver's other conflict rule) this still returns the
 * per-parcel table, exactly as this function always did before P-154 —
 * but now with `display_meta.source_date`/`date_basis` on that table
 * honestly marked, plus a `second_source` disclosure carrying the OTHER
 * candidate's own value/date/citation, so a caller reading display_meta
 * sees the disagreement rather than a bare, unqualified number. A hard
 * refusal (no value at all on conflict) needs this function's return type
 * to grow a `conflict` variant, which ripples into every existing caller of
 * `getSetbackTableForZoning` across this repo; out of scope for this wave
 * (see close `leave_behind`) — reported, not silently worked around.
 */
function resolveBastropEuclideanCandidate(
  normalized: string,
  district: string,
  perParcelRecord: NonNullable<SetbackTableResolveOptions["bastropPerParcelRecord"]>,
): SetbackTable {
  const perParcelTable = setbackTableFromBastropPerParcelRecord(perParcelRecord, district);
  const perParcelDistrict = perParcelTable.districts[0]!;

  const chartTable =
    normalized === "bastrop-development-code" || normalized === "bastrop-tx" || normalized === "bastrop-city-tx"
      ? SETBACK_TABLES["bastrop-development-code"]
      : undefined;
  const wanted = leadingDistrictToken(district);
  const chartDistrict = chartTable?.districts.find(
    (d) => leadingDistrictToken(d.district_name) === wanted,
  );
  if (!chartTable || !chartDistrict) {
    // No codified row to resolve against (e.g. MU/GC/PDD/PI/IND/OS) —
    // per-parcel record is the only candidate; nothing to compare.
    return perParcelTable;
  }

  const chartCandidate: SetbackCandidate = {
    id: "bastrop-development-code",
    sourceKind: "codified-ordinance",
    sourceLabel: chartTable.jurisdictionDisplayName,
    scalars: {
      front_ft: chartDistrict.front_ft,
      side_ft: chartDistrict.side_ft,
      rear_ft: chartDistrict.rear_ft,
      side_corner_ft: chartDistrict.side_corner_ft,
    },
    citationUrl: chartDistrict.citation_url ?? null,
    ...dateFromTableEffectiveDate(chartTable.effectiveDate),
  };
  const perParcelCandidate: SetbackCandidate = {
    id: "bastrop-per-parcel-record",
    sourceKind: "gis-per-parcel",
    sourceLabel: perParcelTable.jurisdictionDisplayName,
    scalars: {
      front_ft: perParcelDistrict.front_ft,
      side_ft: perParcelDistrict.side_ft,
      rear_ft: perParcelDistrict.rear_ft,
      side_corner_ft: perParcelDistrict.side_corner_ft,
    },
    citationUrl: perParcelDistrict.citation_url ?? null,
    sourceDate: perParcelRecord.sourceDate,
    dateBasis: perParcelRecord.dateBasis,
    ...(perParcelRecord.datePrecision ? { datePrecision: perParcelRecord.datePrecision } : {}),
  };

  const resolution = resolveMostCurrentSetback([chartCandidate, perParcelCandidate]);

  if (resolution.status === "resolved" && resolution.winner.id === "bastrop-development-code") {
    return {
      ...chartTable,
      districts: chartTable.districts.map((d) =>
        d === chartDistrict
          ? {
              ...d,
              display_meta: {
                ...(d.display_meta ?? {}),
                source_date: chartCandidate.sourceDate,
                date_basis: chartCandidate.dateBasis,
                ...(chartCandidate.datePrecision ? { date_precision: chartCandidate.datePrecision } : {}),
                second_source: {
                  source: perParcelCandidate.sourceLabel,
                  note: `Superseded by the codified table under R-1 (most-current source wins): per-parcel record dated ${perParcelCandidate.sourceDate ?? "unreadable"} (${perParcelCandidate.dateBasis}) reads ${perParcelDistrict.front_ft}/${perParcelDistrict.side_ft}/${perParcelDistrict.rear_ft}/${perParcelDistrict.side_corner_ft ?? "?"} (front/side/rear/corner).`,
                  citation_url: perParcelCandidate.citationUrl ?? undefined,
                },
              },
            }
          : d,
      ),
    };
  }

  // Resolved in favor of the per-parcel record, OR a genuine conflict
  // (resolution.status === "conflict") — either way, return the per-parcel
  // table (this function's historical behavior on conflict; see docstring)
  // with an honest second-source disclosure naming the OTHER candidate.
  const conflictNote =
    resolution.status === "conflict"
      ? `CONFLICT under R-1 (most-current source wins): ${resolution.reason} Codified table reads ${chartDistrict.front_ft}/${chartDistrict.side_ft}/${chartDistrict.rear_ft}/${chartDistrict.side_corner_ft ?? "?"} (front/side/rear/corner), dated ${chartCandidate.sourceDate ?? "unreadable"} (${chartCandidate.dateBasis}).`
      : `Per-parcel record is more current under R-1: codified table dated ${chartCandidate.sourceDate ?? "unreadable"} (${chartCandidate.dateBasis}) reads ${chartDistrict.front_ft}/${chartDistrict.side_ft}/${chartDistrict.rear_ft}/${chartDistrict.side_corner_ft ?? "?"} (front/side/rear/corner).`;
  return {
    ...perParcelTable,
    districts: perParcelTable.districts.map((d) => ({
      ...d,
      display_meta: {
        ...(d.display_meta ?? {}),
        second_source: {
          source: chartCandidate.sourceLabel,
          note: conflictNote,
          citation_url: chartCandidate.citationUrl ?? undefined,
        },
      },
    })),
  };
}

export function getSetbackTableForZoning(
  jurisdictionKey: string,
  zoningCode: string | null | undefined,
  options?: SetbackTableResolveOptions,
): SetbackTable | null {
  const normalized = normalizeJurisdictionKey(jurisdictionKey);
  const code = (zoningCode ?? "").trim().toUpperCase();

  if (options?.bastropPerParcelRecord && isBastropCityJurisdiction(normalized)) {
    const district = (options.districtCode ?? code).trim();
    if (!district) return null;
    return resolveBastropEuclideanCandidate(normalized, district, options.bastropPerParcelRecord);
  }

  if (isBastropCityJurisdiction(normalized)) {
    if (code && isRepealedB3PlaceType(code)) {
      return null;
    }

    // County-only legacy codes (R-MD, etc.) on bastrop-tx key — not city BDC.
    if (
      normalized === "bastrop-tx" &&
      code &&
      !isKnownBdcDistrictCode(code)
    ) {
      return SETBACK_TABLES["bastrop-tx"] ?? null;
    }

    // R13 (AMENDMENT 8): city BDC districts require layer-23 per-parcel record.
    return null;
  }

  if (normalized === "elgin-tx" || normalized === "elgin-development-code") {
    return SETBACK_TABLES["elgin-development-code"] ?? null;
  }

  return SETBACK_TABLES[normalized] ?? null;
}

/**
 * Look up a single zoning district within a jurisdiction. Case-
 * insensitive on the district name to absorb the small spelling
 * differences between the GIS layer and the ordinance PDF.
 */
export function getSetbackDistrict(
  jurisdictionKey: string,
  districtName: string,
): SetbackDistrict | null {
  const table = getSetbackTable(jurisdictionKey);
  if (!table) return null;
  const wanted = districtName.trim().toLowerCase();
  return (
    table.districts.find(
      (d) => d.district_name.toLowerCase() === wanted,
    ) ?? null
  );
}

export function listSetbackTables(): SetbackTable[] {
  return Object.values(SETBACK_TABLES);
}

export {
  BASTROP_PARCELS_ONE_CLICK_LAYER_23,
  BASTROP_ZONE_TYPE_CLASS,
  fetchBastropPerParcelSetbackRecord,
  flagBastropChartDisagreement,
  parseBastropPerParcelAttributes,
  parseScalarSetbackFeet,
  parseSideSetbackText,
  resolveBastropLayer23DominantRow,
  selectBastropLayer23Attributes,
  setbackTableFromBastropPerParcelRecord,
  type BastropChartDisagreement,
  type BastropPerParcelHonestDecline,
  type BastropPerParcelSetbackParsed,
  type FetchBastropPerParcelOptions,
  type ParsedSideSetback,
} from "./bastrop-per-parcel-record.js";
export {
  BASTROP_AUTHORITATIVE_SETBACK_ADAPTER,
  bastropSetbackPendingRewarmReason,
  isAuthoritativeBastropCitySetbackSource,
  isBastropCountyParcelNodeId,
  isStaleBastropCitySetbackRule,
  requiresPerParcelSetbackRecord,
} from "./bastrop-setback-currency.js";
export {
  NO_SETBACK_RULE_ENVELOPE_BASIS,
  PLACEHOLDER_SETBACK_PROVENANCE,
  PLACEHOLDER_SETBACK_UNKNOWN_BASIS,
  RETIRED_ROAD_CLASS_SETBACK_BASIS,
  ROAD_CLASS_SETBACK_PROVENANCE,
  classifyBoundaryEdgeSetback,
  classifyEnvelopeServe,
  classifySetbackRuleAtom,
  type BoundarySetbackBody,
  type EnvelopeServeVerdict,
  type SetbackRuleProvenanceInput,
  type SetbackServeDisposition,
  type SetbackServeVerdict,
} from "./setback-provenance-disposition.js";
