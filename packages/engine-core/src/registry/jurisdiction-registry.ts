/**
 * Jurisdiction source registry — the frozen, engine-read source-of-truth for a
 * jurisdiction's data sources (OPS-1, R-FND-2). The engine READS a frozen
 * registry row (authored in prep, adversarially reviewed, frozen) instead of
 * hardcoding per-county adapters. A rewarm replays the frozen row; no agent
 * re-authors at warm time.
 *
 * This is the A4 loader: types + a loader + a Bastrop (48021) fixture row. It
 * does NOT yet replace the hardcoded Bastrop adapter (that is a later
 * migration) — it establishes the registry-as-engine-input path.
 */

/** How a jurisdiction's parcel GEOMETRY (Rail C) is sourced. */
export type GeometrySource =
  | "stratmap_bulk_zip" // TxGIO StratMap staged per-county zip (the default spine)
  | "cad_direct_arcgis_rest" // a county ArcGIS service, where fresher than StratMap
  | "cad_direct"; // a county CAD bulk, where no StratMap zip exists (e.g. Donley)

/** The join key used to attach Rail B (CAD attributes) to Rail C geometry. */
export type JoinKey =
  | "prop_id" // default; safe when prop_id bad-rate is low
  | "geo_id_or_address_crosswalk"; // for high-prop_id-bad-rate counties (e.g. Travis)

/** A frozen source-adapter row for one jurisdiction (FIPS-keyed). */
export interface JurisdictionRegistryRow {
  /** County FIPS (e.g. "48021" for Bastrop). */
  readonly fips: string;
  readonly countyName: string;
  /** Rail C geometry source + how to reach it. */
  readonly railC: {
    readonly geometrySource: GeometrySource;
    readonly downloadUrl: string | null;
    /** Source vintage (YYYYMM from the StratMap zip basename). */
    readonly vintageYyyymm: string | null;
    readonly featureCount: number | null;
    /** Fraction of parcels with an unusable prop_id (empty/zero). */
    readonly propIdBadRate: number | null;
  };
  /** How CAD attributes join to geometry, and the fabrication firewall. */
  readonly join: {
    readonly joinKey: JoinKey;
    /** Owner-match gate is ALWAYS required before a CAD value is promoted. */
    readonly ownerMatchRequired: true;
  };
  /** Freshness/coverage flags surfaced by the registry (e.g. STALE, NOT_COVERED). */
  readonly flags: readonly string[];
  /** Provenance: where this row's data came from + when it was frozen. */
  readonly provenance: {
    readonly sourcePage: string;
    readonly frozenAt: string; // ISO date the row was frozen (prep-time)
    readonly registryVersion: string;
  };
}

/**
 * Bastrop (48021) frozen Rail C row — derived from the live-probed TxGIO
 * StratMap matrix (2026-08-02). prop_id bad-rate 0.0022 = clean; prop_id join
 * is safe. STALE (202503) — a fresher county ArcGIS override may apply, but the
 * StratMap zip is the geometry spine.
 */
export const BASTROP_REGISTRY_ROW: JurisdictionRegistryRow = {
  fips: "48021",
  countyName: "Bastrop",
  railC: {
    geometrySource: "stratmap_bulk_zip",
    downloadUrl:
      "https://data.geographic.texas.gov/0fa04328-872e-481c-b453-126a74777593/resources/stratmap25-landparcels_48021_lp.zip",
    vintageYyyymm: "202503",
    featureCount: 63357,
    propIdBadRate: 0.0022,
  },
  join: {
    joinKey: "prop_id",
    ownerMatchRequired: true,
  },
  flags: ["STALE"],
  provenance: {
    sourcePage: "https://tnris.org/stratmap/land-parcels.html",
    frozenAt: "2026-08-02",
    registryVersion: "1.0.0",
  },
};

/** The frozen registry, keyed by FIPS. Seeded with Bastrop; grows per onboarding. */
const REGISTRY: ReadonlyMap<string, JurisdictionRegistryRow> = new Map([
  [BASTROP_REGISTRY_ROW.fips, BASTROP_REGISTRY_ROW],
]);

/**
 * Load a jurisdiction's frozen registry row by FIPS. Returns null when the
 * jurisdiction has not been onboarded (honest-absence — the caller declines,
 * never fabricates a source). The engine reads THIS, not a hardcoded adapter.
 */
export function loadJurisdictionRegistryRow(
  fips: string,
): JurisdictionRegistryRow | null {
  return REGISTRY.get(fips) ?? null;
}

/** Whether a jurisdiction has a frozen registry row (is onboarded at Rail C). */
export function isJurisdictionOnboarded(fips: string): boolean {
  return REGISTRY.has(fips);
}
