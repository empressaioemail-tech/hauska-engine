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
 *
 * onboard-fips foundation: a fips can carry more than one row (a city and its
 * unincorporated county share a fips) and a row can be "pre-flight-pending"
 * (staged, not yet warm-eligible) — see onboard-preflight.ts for the gate
 * that promotes a row toward "active".
 */
import { BASTROP_BCAD_PARCELS_URL } from "../boundary-primitive/lot-line-scrub.js";

/** How a jurisdiction's parcel GEOMETRY (Rail C) is sourced. */
export type GeometrySource =
  | "stratmap_bulk_zip" // TxGIO StratMap staged per-county zip (the default spine)
  | "cad_direct_arcgis_rest" // a county ArcGIS service, where fresher than StratMap
  | "cad_direct"; // a county CAD bulk, where no StratMap zip exists (e.g. Donley)

/** The join key used to attach Rail B (CAD attributes) to Rail C geometry. */
export type JoinKey =
  | "prop_id" // default; safe when prop_id bad-rate is low
  | "geo_id_or_address_crosswalk"; // for high-prop_id-bad-rate counties (e.g. Travis)

/**
 * Zoning regime for a jurisdiction (registry row-level, Q OPS-8 pre-flight
 * input). "unzoned" jurisdictions (e.g. unincorporated county) are EXPECTED
 * to honest-decline zoning/setback rails — that is the doctrine PASS state,
 * never a defect to chase (see 90_runbooks / doc_repo
 * zoning-coverage-is-wired-city-not-data).
 */
export type ZoningRegime = "euclidean-zoned" | "unzoned";

/**
 * The parcel filter shape for a Rail A per-parcel cohort — discriminated on
 * `kind` so the loader can branch without a non-null assertion. A
 * jurisdiction is either scoped to a city boundary (`cityFilter`, the
 * Bastrop shape, unchanged) or has no city filter at all (`noFilter`) — a
 * whole-county cohort within the row's fips (e.g. unincorporated county).
 */
export type ParcelCohortFilter =
  | {
      readonly kind: "cityFilter";
      /** City boundary filter (e.g. CITY = 'BASTROP'). */
      readonly field: string;
      readonly value: string;
    }
  | {
      readonly kind: "noFilter";
      /** Whole-county cohort within the row's fips — no city/boundary predicate. */
    };

/**
 * Rail A per-parcel authoritative record layer — the warm COHORT source for
 * onboard(fips). The engine reads THIS from the frozen registry row instead of
 * hardcoding Bastrop AGOL constants at warm time.
 *
 * TODO(onboard-fips): per-state provider resolves districtField + value mapping
 * from the registry's Rail-A metadata when a second jurisdiction lands.
 */
export interface PerParcelCohortRail {
  /** ArcGIS FeatureServer layer URL (Rail A / per-parcel setback record). */
  readonly featureServerLayerUrl: string;
  /** Parcel filter — city-scoped (today's Bastrop shape) or whole-county (no filter). */
  readonly parcelFilter: ParcelCohortFilter;
  /** Layer field holding the district code (e.g. ZoneTypeClass). */
  readonly districtField: string;
  /** Map district prefix → layer field value (Bastrop: ZoneTypeClass int). */
  readonly districtValueByPrefix: Readonly<Record<string, number | string>>;
  readonly propIdField: string;
}

/**
 * Onboarding status of a registry row. "active" rows are frozen and warm-
 * eligible (Bastrop today). "pre-flight-pending" rows are staged for a
 * jurisdiction that has not yet cleared onboard-preflight — they exist in
 * the registry so pre-flight can read + grade them, but are not warm-eligible
 * until pre-flight clears and the row is promoted to "active".
 */
export type RegistryRowStatus = "active" | "pre-flight-pending";

/**
 * FLIP-BLOCKED (S4, 2026-08-04): BASTROP_COUNTY_UNINCORPORATED_REGISTRY_ROW
 * and ELGIN_REGISTRY_ROW cannot yet be promoted from "pre-flight-pending" to
 * "active", even after clearing onboard-preflight, without first migrating
 * every fips-keyed caller off the ambiguous `loadJurisdictionRegistryRow(fips)`
 * / `loadRegistryDistrictCohort(fips, ...)` path. Both fips 48021 rows share
 * their fips with BASTROP_REGISTRY_ROW; `loadJurisdictionRegistryRow` returns
 * only the first "active" row for a fips (`rows.find(r => r.status ===
 * "active") ?? rows[0]`), so a second "active" row on 48021 would silently
 * resolve to the wrong row for any caller still keyed by fips alone.
 *
 * Audited callers (S4, engine main as of cbf1741) that would break on flip:
 *   - onboard-preflight.mjs's `loadDeterministicSample(row, ...)` calls
 *     `loadRegistryDistrictCohort(row.fips, null)` — discards the specific
 *     `row` (Bastrop / county-unincorporated / Elgin) it was given and
 *     re-resolves by fips only. Feeds checks 5 and 7 (geometry parity, cost
 *     sample) for EVERY row on a multi-row fips.
 *   - warden-sweep.mjs's `loadDeterministicSample(fips, ...)` (called with
 *     `row.fips` after resolving `row` via `loadJurisdictionRegistryRowById`)
 *     has the same defect.
 * Both are fixable by switching to `loadRegistryDistrictCohortByRow(row.rowId,
 * ...)` (added S4, parcel-cohort-loader.ts) — not yet done, since flipping
 * the status is what would make the bug live (today only one row per fips is
 * "active", so the ambiguity is dormant).
 *
 * Callers already rowId-keyed and unaffected: block13-cert-grade.mjs,
 * cert-grade-and-report.mjs, warden-sweep.mjs's own row resolution (all use
 * `loadJurisdictionRegistryRowById`, not the fips-keyed loader).
 *
 * Unblock path: migrate the two call sites above to
 * `loadRegistryDistrictCohortByRow`, then flip these two rows' `status`.
 */

/** A frozen source-adapter row for one jurisdiction (FIPS-keyed; multiple rows can share a fips — e.g. a city and its county). */
export interface JurisdictionRegistryRow {
  /**
   * Stable row identifier, unique across the registry. Distinct from `fips`
   * because more than one row can share a fips (e.g. Bastrop city and
   * Bastrop County unincorporated both key off 48021). Defaults to
   * `countyName` for the original single-row-per-fips rows (Bastrop) to
   * keep those byte-identical in spirit; new rows set it explicitly.
   */
  readonly rowId: string;
  /** County FIPS (e.g. "48021" for Bastrop). */
  readonly fips: string;
  readonly countyName: string;
  /** Onboarding status; defaults to "active" for the original frozen rows. */
  readonly status: RegistryRowStatus;
  /** Zoning regime — "unzoned" jurisdictions honest-decline zoning/setback rails by design. */
  readonly zoningRegime: ZoningRegime;
  /** Rail A per-parcel record layer — cohort source for factory warm (Phase D). */
  readonly railPerParcel?: PerParcelCohortRail;
  /** Rail C geometry source + how to reach it. */
  readonly railC: {
    readonly geometrySource: GeometrySource;
    readonly downloadUrl: string | null;
    /** Source vintage (YYYYMM from the StratMap zip basename). */
    readonly vintageYyyymm: string | null;
    readonly featureCount: number | null;
    /** Fraction of parcels with an unusable prop_id (empty/zero). */
    readonly propIdBadRate: number | null;
    /**
     * Live cadastral-ring query endpoint (ArcGIS FeatureServer query URL,
     * see BASTROP_BCAD_PARCELS_URL) for this row's county — the per-parcel
     * grade path (cert-grade-core.ts) queries THIS row's cadastral service
     * for BCAD-style ring fetches, never a hardcoded county default. Optional
     * and additive: absent on a non-48021 row means the grader must fail
     * loud rather than silently defaulting to Bastrop's endpoint (see
     * gradeUnzonedParcel / gradeOneParcelInQueryMode / gradeBlock13Parcel in
     * cert-grade-core.ts). 48021 rows populate this with the current
     * BASTROP_BCAD_PARCELS_URL value so their behavior stays explicit and
     * byte-equivalent to the prior hardcoded-default behavior.
     */
    readonly cadastralQueryUrl?: string | null;
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
/** Bastrop Parcels_One_Click layer 23 — authoritative per-parcel setback record. */
const BASTROP_PARCELS_ONE_CLICK_LAYER_23 =
  "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Parcels_One_Click/FeatureServer/23";

export const BASTROP_REGISTRY_ROW: JurisdictionRegistryRow = {
  rowId: "Bastrop",
  fips: "48021",
  countyName: "Bastrop",
  status: "active",
  zoningRegime: "euclidean-zoned",
  railPerParcel: {
    featureServerLayerUrl: BASTROP_PARCELS_ONE_CLICK_LAYER_23,
    parcelFilter: { kind: "cityFilter", field: "CITY", value: "BASTROP" },
    districtField: "ZoneTypeClass",
    districtValueByPrefix: {
      "P/OS": 1,
      RR: 2,
      "SF-1": 3,
      "SF-2": 4,
      "SF-3": 5,
      MU: 6,
      GC: 7,
      PI: 8,
      IND: 9,
      PDD: 10,
    },
    propIdField: "prop_id",
  },
  railC: {
    geometrySource: "stratmap_bulk_zip",
    downloadUrl:
      "https://data.geographic.texas.gov/0fa04328-872e-481c-b453-126a74777593/resources/stratmap25-landparcels_48021_lp.zip",
    vintageYyyymm: "202503",
    featureCount: 63357,
    propIdBadRate: 0.0022,
    cadastralQueryUrl: BASTROP_BCAD_PARCELS_URL,
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

/**
 * Bastrop County unincorporated (48021) — no-city-filter (whole-county)
 * variant, "pre-flight-pending" (not yet cleared onboard-preflight). Unzoned
 * regime: zoning/setback honest-decline is the EXPECTED pass state for this
 * row, not a defect. Parcel layer reuses the same county cadastral source
 * (Parcels_One_Click layer 23) the Bastrop city row names — the layer is
 * county-wide; this row simply does not filter it down to CITY='BASTROP'.
 */
export const BASTROP_COUNTY_UNINCORPORATED_REGISTRY_ROW: JurisdictionRegistryRow =
  {
    rowId: "Bastrop County (unincorporated)",
    fips: "48021",
    countyName: "Bastrop",
    status: "pre-flight-pending",
    zoningRegime: "unzoned",
    railPerParcel: {
      featureServerLayerUrl: BASTROP_PARCELS_ONE_CLICK_LAYER_23,
      parcelFilter: { kind: "noFilter" },
      districtField: "ZoneTypeClass",
      districtValueByPrefix: BASTROP_REGISTRY_ROW.railPerParcel!.districtValueByPrefix,
      propIdField: "prop_id",
    },
    railC: {
      geometrySource: "stratmap_bulk_zip",
      downloadUrl:
        "https://data.geographic.texas.gov/0fa04328-872e-481c-b453-126a74777593/resources/stratmap25-landparcels_48021_lp.zip",
      vintageYyyymm: "202503",
      featureCount: 63357,
      propIdBadRate: 0.0022,
      cadastralQueryUrl: BASTROP_BCAD_PARCELS_URL,
    },
    join: {
      joinKey: "prop_id",
      ownerMatchRequired: true,
    },
    flags: ["STALE", "PRE_FLIGHT_PENDING"],
    provenance: {
      sourcePage: "https://tnris.org/stratmap/land-parcels.html",
      frozenAt: "2026-08-03",
      registryVersion: "1.1.0",
    },
  };

/**
 * Elgin (48021-area city, Bastrop-county side only) — city-filter variant,
 * "pre-flight-pending". Euclidean-zoned. Rail A per-parcel zoning source is
 * the Elgin_Zoning FeatureServer layer 0 (3,220-parcel Bastrop-county-side
 * cohort, CITY_LIMIT = 'ELGIN'). SCOPE NOTE (2026-08-03 onboarding pass):
 * Elgin also has a ~500-parcel Travis-county-side sliver (the SAME
 * FeatureServer's layer 1, fips 48453) that is OUT of this pass — it is a
 * named follow-on, not wired here. This row covers the Bastrop-county side
 * only (fips 48021).
 *
 * District naming: the ordinance's own numbering (Chapter 46, Sec. 46-203)
 * names the multifamily district "R-4 Multiple-Family Residential District"
 * (canonical). The GIS layer's Zone_Code domain instead stamps that same
 * district "A" (a legacy/historical code letter — confirmed by Sec. 46-391 /
 * 46-417, which both read "the same as the requirements of the
 * A-Multiple-Family Residential District" when describing the C-2/C-3
 * dwelling-use carve-out). districtValueByPrefix below maps the canonical
 * "R-4" prefix to the GIS layer's "A" domain value so cohort queries can key
 * on the canonical name while the WHERE clause still targets the layer's
 * actual stored value.
 */
const ELGIN_ZONING_LAYER_0 =
  "https://services3.arcgis.com/wdTkTU0MdZbNBEZy/arcgis/rest/services/Elgin_Zoning/FeatureServer/0";

export const ELGIN_REGISTRY_ROW: JurisdictionRegistryRow = {
  rowId: "Elgin",
  fips: "48021",
  countyName: "Bastrop",
  status: "pre-flight-pending",
  zoningRegime: "euclidean-zoned",
  railPerParcel: {
    featureServerLayerUrl: ELGIN_ZONING_LAYER_0,
    parcelFilter: { kind: "cityFilter", field: "CITY_LIMIT", value: "ELGIN" },
    districtField: "Zone_Code",
    // Canonical district name -> GIS layer Zone_Code domain value. Every
    // other district's canonical name IS its Zone_Code value (identity); "A"
    // is the sole GIS/ordinance-naming divergence (Sec. 46-203 vs. Sec.
    // 46-391/46-417 "A-Multiple-Family Residential District").
    districtValueByPrefix: {
      "R-1": "R-1",
      "R-2": "R-2",
      "R-3": "R-3",
      "R-4": "A",
      "C-1": "C-1",
      "C-2": "C-2",
      "C-3": "C-3",
      I: "I",
    },
    propIdField: "PROP_ID",
  },
  railC: {
    geometrySource: "stratmap_bulk_zip",
    downloadUrl:
      "https://data.geographic.texas.gov/0fa04328-872e-481c-b453-126a74777593/resources/stratmap25-landparcels_48021_lp.zip",
    vintageYyyymm: "202503",
    featureCount: 63357,
    propIdBadRate: 0.0022,
    cadastralQueryUrl: BASTROP_BCAD_PARCELS_URL,
    // NOTE: railC (Rail C geometry) is the Bastrop-side StratMap county zip,
    // which covers Elgin's Bastrop-county-side parcels (fips 48021). This
    // does NOT cover the ~500-parcel Travis-county-side sliver (fips 48453,
    // FeatureServer layer 1) — that sliver is out of this onboarding pass
    // and needs its own registry row against Travis County's StratMap zip
    // when picked up.
  },
  join: {
    joinKey: "prop_id",
    ownerMatchRequired: true,
  },
  // ZONING_SOURCE_TODO removed 2026-08-03: checkZoningSourceReachableOrUnzoned
  // (onboard-preflight.ts check 2) reads this flag literally — its presence
  // forces an unconditional ADAPTER-NEEDED decline regardless of whether a
  // zoning source is wired. Elgin's Rail A per-parcel zoning source (layer 0
  // above) is now wired in this row, so the flag would be dishonest (it would
  // claim "not yet wired" about a source that IS wired). Check 2 now runs the
  // normal probeZoningSource path like Bastrop, and check 3
  // (parcelLayerWired) mechanically confirms the row's filter shape compiles.
  flags: ["STALE", "PRE_FLIGHT_PENDING"],
  provenance: {
    sourcePage: "https://tnris.org/stratmap/land-parcels.html",
    frozenAt: "2026-08-03",
    registryVersion: "1.1.0",
  },
};

/**
 * Central TX county fan (2026-08-04) — EIGHT unincorporated-county registry
 * rows, pattern-matched to BASTROP_COUNTY_UNINCORPORATED_REGISTRY_ROW: whole-
 * county noFilter cohort, unzoned regime (honest zoning/setback decline is
 * the doctrine PASS state, not a defect), status "pre-flight-pending".
 *
 * railC values (downloadUrl, vintageYyyymm, featureCount, propIdBadRate) are
 * sourced verbatim from the live-probed TxGIO StratMap matrix
 * (doc_repo `_land_records/txgio_stratmap_county_matrix_2026-08-02.json`,
 * generated 2026-08-02). cadastralQueryUrl values are sourced from the
 * planner cadastral recon (doc_repo `_inbox/2026-08-04_county_fan_cadastral_recon.md`)
 * — read-only ArcGIS REST probes against each county's live CAD/GIS service,
 * confirming service reachability, layer id, and prop-id field name.
 *
 * railPerParcel mirrors BASTROP_COUNTY_UNINCORPORATED_REGISTRY_ROW's
 * no-district shape for an unzoned regime: `parcelFilter: {kind: "noFilter"}`,
 * and districtField/districtValueByPrefix are carried as empty placeholders
 * (there is no district vocabulary to resolve for an unzoned county — the
 * fields exist on the PerParcelCohortRail interface but are inert here,
 * exactly as Bastrop County's row leaves districtField wired-but-unused for
 * its noFilter cohort). featureServerLayerUrl reuses the row's own
 * cadastralQueryUrl (the same live CAD parcel-attribute layer the grader
 * queries at railC) — there is no separate zoning/setback record layer for
 * an unzoned county, unlike Bastrop City's Parcels_One_Click zoning layer.
 * Where cadastralQueryUrl is absent (Hays), railPerParcel is omitted entirely
 * — the cert path must honest-fail-loud rather than default to a fabricated
 * or borrowed source (see #242 cadastralQueryUrl fix; gradeUnzonedParcel /
 * gradeOneParcelInQueryMode in cert-grade-core.ts already fail loud on a
 * missing cadastralQueryUrl).
 *
 * EXCLUDED: Travis County (48453) is deliberately NOT added in this pass.
 * Held per planner ruling 2026-08-04: Travis's prop_id bad-rate is 0.5147
 * (>> the 0.25 HIGH_PROP_ID_BAD_RATE threshold; StratMap flags it
 * HIGH_PROP_ID_BAD_RATE) — the default `joinKey: "prop_id"` is unsafe for
 * Travis and it needs the `geo_id_or_address_crosswalk` JoinKey variant
 * (already modeled on the JoinKey type specifically citing Travis) wired
 * through the cohort loader before a Travis row can be authored safely.
 * The cadastral recon separately flags an unresolved 2.16x count divergence
 * between the county-run TCAD MapServer (386,682 live) and StratMap's
 * 202508 vintage (834,936) for Travis — a second, independent reason not to
 * freeze a Travis row from this recon alone. DO NOT add a Travis row here
 * without first closing both the join-key gap and the count-divergence
 * question; the next author should re-run recon rather than reuse these
 * numbers as-is once the crosswalk is built.
 */

/** Bell County (48027) — BIS Consultants CAD-GIS vendor template; live count 169,398 vs StratMap 167,441 (ratio 1.012), CONFIRMED. */
const BELL_COUNTY_CADASTRAL_LAYER_0 =
  "https://services7.arcgis.com/EHW2HuuyZNO7DZct/arcgis/rest/services/BellCADWebService/FeatureServer/0";

export const BELL_COUNTY_UNINCORPORATED_REGISTRY_ROW: JurisdictionRegistryRow =
  {
    rowId: "Bell County (unincorporated)",
    fips: "48027",
    countyName: "Bell",
    status: "pre-flight-pending",
    zoningRegime: "unzoned",
    railPerParcel: {
      featureServerLayerUrl: BELL_COUNTY_CADASTRAL_LAYER_0,
      parcelFilter: { kind: "noFilter" },
      districtField: "",
      districtValueByPrefix: {},
      propIdField: "prop_id",
    },
    railC: {
      geometrySource: "stratmap_bulk_zip",
      downloadUrl:
        "https://data.geographic.texas.gov/0fa04328-872e-481c-b453-126a74777593/resources/stratmap25-landparcels_48027_lp.zip",
      vintageYyyymm: "202503",
      featureCount: 167441,
      propIdBadRate: 0.0105,
      cadastralQueryUrl: BELL_COUNTY_CADASTRAL_LAYER_0,
    },
    join: {
      joinKey: "prop_id",
      ownerMatchRequired: true,
    },
    flags: ["STALE", "PRE_FLIGHT_PENDING"],
    provenance: {
      sourcePage: "https://tnris.org/stratmap/land-parcels.html",
      frozenAt: "2026-08-04",
      registryVersion: "1.2.0",
    },
  };

/** Bexar County (48029) — county-run maps.bexar.org (BCAD); live count 710,772 vs StratMap 709,541 (ratio 1.002), CONFIRMED. */
const BEXAR_COUNTY_CADASTRAL_LAYER_0 =
  "https://maps.bexar.org/arcgis/rest/services/Parcels/MapServer/0";

export const BEXAR_COUNTY_UNINCORPORATED_REGISTRY_ROW: JurisdictionRegistryRow =
  {
    rowId: "Bexar County (unincorporated)",
    fips: "48029",
    countyName: "Bexar",
    status: "pre-flight-pending",
    zoningRegime: "unzoned",
    railPerParcel: {
      featureServerLayerUrl: BEXAR_COUNTY_CADASTRAL_LAYER_0,
      parcelFilter: { kind: "noFilter" },
      districtField: "",
      districtValueByPrefix: {},
      propIdField: "PropID",
    },
    railC: {
      geometrySource: "stratmap_bulk_zip",
      downloadUrl:
        "https://data.geographic.texas.gov/0fa04328-872e-481c-b453-126a74777593/resources/stratmap25-landparcels_48029_lp.zip",
      vintageYyyymm: "202507",
      featureCount: 709541,
      propIdBadRate: 0.0001,
      cadastralQueryUrl: BEXAR_COUNTY_CADASTRAL_LAYER_0,
    },
    join: {
      joinKey: "prop_id",
      ownerMatchRequired: true,
    },
    flags: ["STALE", "PRE_FLIGHT_PENDING"],
    provenance: {
      sourcePage: "https://tnris.org/stratmap/land-parcels.html",
      frozenAt: "2026-08-04",
      registryVersion: "1.2.0",
    },
  };

/**
 * Caldwell County (48055) — Caldwell_CAD_Parcel_Map FeatureServer, the same
 * hub already precedented by the 2026-07-27 RECIPE_PROOF county-lane pass
 * (`_dispatches/2026-07-27_RECIPE_PROOF_caldwell_48055.md`,
 * `_inbox/2026-07-27_RECIPE_PROOF_caldwell_road_recon_seed.json`). That pass
 * named Road_Centerlines (layer 6), Lockhart/Luling/Martindale zoning layers
 * (49/50/51), City_Limits (17), City_ETJ (18), and Road_Plan_2024 (45) — it
 * did NOT name a parcels-layer id. Layer 0 is used here per this
 * FeatureServer's standard ArcGIS convention (every other CONFIRMED county
 * in the 2026-08-04 recon that follows the "layer 0 = Parcels" convention
 * confirms it explicitly; Caldwell's own service was not re-probed for its
 * parcels layer id in this pass — verify layer 0 resolves to the parcel
 * attribute layer, not a different layer, before promoting this row out of
 * pre-flight-pending).
 */
const CALDWELL_COUNTY_CADASTRAL_LAYER_0 =
  "https://services.arcgis.com/rVxY74DxxIDrDbc0/arcgis/rest/services/Caldwell_CAD_Parcel_Map/FeatureServer/0";

export const CALDWELL_COUNTY_UNINCORPORATED_REGISTRY_ROW: JurisdictionRegistryRow =
  {
    rowId: "Caldwell County (unincorporated)",
    fips: "48055",
    countyName: "Caldwell",
    status: "pre-flight-pending",
    zoningRegime: "unzoned",
    railPerParcel: {
      featureServerLayerUrl: CALDWELL_COUNTY_CADASTRAL_LAYER_0,
      parcelFilter: { kind: "noFilter" },
      districtField: "",
      districtValueByPrefix: {},
      propIdField: "prop_id",
    },
    railC: {
      geometrySource: "stratmap_bulk_zip",
      downloadUrl:
        "https://data.geographic.texas.gov/0fa04328-872e-481c-b453-126a74777593/resources/stratmap25-landparcels_48055_lp.zip",
      vintageYyyymm: "202503",
      featureCount: 26155,
      propIdBadRate: 0.0074,
      cadastralQueryUrl: CALDWELL_COUNTY_CADASTRAL_LAYER_0,
    },
    join: {
      joinKey: "prop_id",
      ownerMatchRequired: true,
    },
    flags: ["STALE", "PRE_FLIGHT_PENDING"],
    provenance: {
      sourcePage: "https://tnris.org/stratmap/land-parcels.html",
      frozenAt: "2026-08-04",
      registryVersion: "1.2.0",
    },
  };

/**
 * Comal County (48091) — CONFIRMED WITH CAVEAT: the only discoverable layer
 * (Comal_County_Parcels, id 40) is an explicit TNRIS/Harris Govern repackage
 * acquired January 2021 — a stale snapshot, not a county-CAD-operated live
 * service. Live count 92,549 is 11% BELOW StratMap's 103,537 (ratio 0.894),
 * consistent with staleness rather than a fresher source. Recorded here
 * per the recon's CONFIRMED-with-caveat verdict; the next author should
 * weigh whether to hold Comal for a direct county GIS contact instead of
 * treating this layer as authoritative-fresh.
 */
const COMAL_COUNTY_CADASTRAL_LAYER_40 =
  "https://services6.arcgis.com/eNPJk90aMrXNOKF8/arcgis/rest/services/Comal_County_Parcels/FeatureServer/40";

export const COMAL_COUNTY_UNINCORPORATED_REGISTRY_ROW: JurisdictionRegistryRow =
  {
    rowId: "Comal County (unincorporated)",
    fips: "48091",
    countyName: "Comal",
    status: "pre-flight-pending",
    zoningRegime: "unzoned",
    railPerParcel: {
      featureServerLayerUrl: COMAL_COUNTY_CADASTRAL_LAYER_40,
      parcelFilter: { kind: "noFilter" },
      districtField: "",
      districtValueByPrefix: {},
      propIdField: "PROP_ID",
    },
    railC: {
      geometrySource: "stratmap_bulk_zip",
      downloadUrl:
        "https://data.geographic.texas.gov/0fa04328-872e-481c-b453-126a74777593/resources/stratmap25-landparcels_48091_lp.zip",
      vintageYyyymm: "202503",
      featureCount: 103537,
      propIdBadRate: 0.0016,
      // PROVENANCE CAVEAT (2026-08-04 recon): this layer is a stale 2021
      // TNRIS/Harris Govern snapshot acquisition, NOT a county-CAD-live feed
      // — live count (92,549) is 11% below the StratMap vintage above.
      // Treat as CONFIRMED-schema / STALE-data, not authoritative-fresh.
      cadastralQueryUrl: COMAL_COUNTY_CADASTRAL_LAYER_40,
    },
    join: {
      joinKey: "prop_id",
      ownerMatchRequired: true,
    },
    flags: ["STALE", "PRE_FLIGHT_PENDING", "CADASTRAL_LAYER_STALE_2021_SNAPSHOT"],
    provenance: {
      sourcePage: "https://tnris.org/stratmap/land-parcels.html",
      frozenAt: "2026-08-04",
      registryVersion: "1.2.0",
    },
  };

/** Guadalupe County (48187) — BIS Consultants CAD-GIS vendor template; live count 98,925 vs StratMap 95,571 (ratio 1.035), CONFIRMED. */
const GUADALUPE_COUNTY_CADASTRAL_LAYER_0 =
  "https://services9.arcgis.com/1l4hbpt78hjlsIcl/arcgis/rest/services/GuadalupeCADWebService/FeatureServer/0";

export const GUADALUPE_COUNTY_UNINCORPORATED_REGISTRY_ROW: JurisdictionRegistryRow =
  {
    rowId: "Guadalupe County (unincorporated)",
    fips: "48187",
    countyName: "Guadalupe",
    status: "pre-flight-pending",
    zoningRegime: "unzoned",
    railPerParcel: {
      featureServerLayerUrl: GUADALUPE_COUNTY_CADASTRAL_LAYER_0,
      parcelFilter: { kind: "noFilter" },
      districtField: "",
      districtValueByPrefix: {},
      propIdField: "prop_id",
    },
    railC: {
      geometrySource: "stratmap_bulk_zip",
      downloadUrl:
        "https://data.geographic.texas.gov/0fa04328-872e-481c-b453-126a74777593/resources/stratmap25-landparcels_48187_lp.zip",
      vintageYyyymm: "202503",
      featureCount: 95571,
      propIdBadRate: 0.0042,
      cadastralQueryUrl: GUADALUPE_COUNTY_CADASTRAL_LAYER_0,
    },
    join: {
      joinKey: "prop_id",
      ownerMatchRequired: true,
    },
    flags: ["STALE", "PRE_FLIGHT_PENDING"],
    provenance: {
      sourcePage: "https://tnris.org/stratmap/land-parcels.html",
      frozenAt: "2026-08-04",
      registryVersion: "1.2.0",
    },
  };

/**
 * Hays County (48209) — cadastralQueryUrl deliberately OMITTED. The
 * 2026-08-04 recon found no live CAD-native ArcGIS REST service for Hays
 * (searched hayscad.com, the Hays open-data hub, and the BIS Consultants
 * vendor org — 0 results for `owner:bis_hayscad`). One weak candidate
 * (a private engineering firm's static 2020 parcel snapshot,
 * gis.urbaneng.com/.../HaysCountyParcels) was found and explicitly NOT
 * recommended (thin/joined schema, not the CAD's authoritative roll).
 * Per the #242 cadastralQueryUrl fix, an absent cadastralQueryUrl makes the
 * per-parcel cert path fail LOUD rather than silently default to another
 * county's endpoint — that loud-fail is the correct behavior for Hays until
 * a live service is found. railPerParcel is omitted entirely for the same
 * reason: there is no live layer to point it at.
 * FOLLOW-UP: browse hayscad.com/data-downloads/ (bulk shapefile download,
 * not a REST service, out of this recon's ArcGIS-REST-only remit) and the
 * Hays open-data hub's full dataset catalog (title may not match the search
 * terms tried) before concluding no live service exists at all.
 */
export const HAYS_COUNTY_UNINCORPORATED_REGISTRY_ROW: JurisdictionRegistryRow =
  {
    rowId: "Hays County (unincorporated)",
    fips: "48209",
    countyName: "Hays",
    status: "pre-flight-pending",
    zoningRegime: "unzoned",
    // railPerParcel intentionally omitted — no live cadastral layer found
    // (see class comment above); do not default to a borrowed layer.
    railC: {
      geometrySource: "stratmap_bulk_zip",
      downloadUrl:
        "https://data.geographic.texas.gov/0fa04328-872e-481c-b453-126a74777593/resources/stratmap25-landparcels_48209_lp.zip",
      vintageYyyymm: "202503",
      featureCount: 117427,
      propIdBadRate: 0.0036,
      // cadastralQueryUrl OMITTED — no live CAD-native ArcGIS REST service
      // found (2026-08-04 recon). Absence forces the cert grader to
      // fail loud (see #242) rather than silently default elsewhere.
    },
    join: {
      joinKey: "prop_id",
      ownerMatchRequired: true,
    },
    flags: ["STALE", "PRE_FLIGHT_PENDING", "CADASTRAL_QUERY_URL_NOT_FOUND"],
    provenance: {
      sourcePage: "https://tnris.org/stratmap/land-parcels.html",
      frozenAt: "2026-08-04",
      registryVersion: "1.2.0",
    },
  };

/** McLennan County (48309) — BIS Consultants CAD-GIS vendor template; live count 116,146 vs StratMap 115,362 (ratio 1.007), CONFIRMED. */
const MCLENNAN_COUNTY_CADASTRAL_LAYER_0 =
  "https://services8.arcgis.com/5e4b1SY8bogTc3pH/arcgis/rest/services/McLennanCADWebService/FeatureServer/0";

export const MCLENNAN_COUNTY_UNINCORPORATED_REGISTRY_ROW: JurisdictionRegistryRow =
  {
    rowId: "McLennan County (unincorporated)",
    fips: "48309",
    countyName: "McLennan",
    status: "pre-flight-pending",
    zoningRegime: "unzoned",
    railPerParcel: {
      featureServerLayerUrl: MCLENNAN_COUNTY_CADASTRAL_LAYER_0,
      parcelFilter: { kind: "noFilter" },
      districtField: "",
      districtValueByPrefix: {},
      propIdField: "prop_id",
    },
    railC: {
      geometrySource: "stratmap_bulk_zip",
      downloadUrl:
        "https://data.geographic.texas.gov/0fa04328-872e-481c-b453-126a74777593/resources/stratmap25-landparcels_48309_lp.zip",
      vintageYyyymm: "202503",
      featureCount: 115362,
      propIdBadRate: 0.001,
      cadastralQueryUrl: MCLENNAN_COUNTY_CADASTRAL_LAYER_0,
    },
    join: {
      joinKey: "prop_id",
      ownerMatchRequired: true,
    },
    flags: ["STALE", "PRE_FLIGHT_PENDING"],
    provenance: {
      sourcePage: "https://tnris.org/stratmap/land-parcels.html",
      frozenAt: "2026-08-04",
      registryVersion: "1.2.0",
    },
  };

/** Williamson County (48491) — county-run gis.wilco.org (WCAD), updated daily; live count 289,494 vs StratMap 282,983 (ratio 1.023), CONFIRMED. */
const WILLIAMSON_COUNTY_CADASTRAL_LAYER_0 =
  "https://gis.wilco.org/arcgis/rest/services/public/county_wcad_parcels/MapServer/0";

export const WILLIAMSON_COUNTY_UNINCORPORATED_REGISTRY_ROW: JurisdictionRegistryRow =
  {
    rowId: "Williamson County (unincorporated)",
    fips: "48491",
    countyName: "Williamson",
    status: "pre-flight-pending",
    zoningRegime: "unzoned",
    railPerParcel: {
      featureServerLayerUrl: WILLIAMSON_COUNTY_CADASTRAL_LAYER_0,
      parcelFilter: { kind: "noFilter" },
      districtField: "",
      districtValueByPrefix: {},
      propIdField: "PropertyID",
    },
    railC: {
      geometrySource: "stratmap_bulk_zip",
      downloadUrl:
        "https://data.geographic.texas.gov/0fa04328-872e-481c-b453-126a74777593/resources/stratmap25-landparcels_48491_lp.zip",
      vintageYyyymm: "202507",
      featureCount: 282983,
      propIdBadRate: 0.0004,
      cadastralQueryUrl: WILLIAMSON_COUNTY_CADASTRAL_LAYER_0,
    },
    join: {
      joinKey: "prop_id",
      ownerMatchRequired: true,
    },
    flags: ["STALE", "PRE_FLIGHT_PENDING"],
    provenance: {
      sourcePage: "https://tnris.org/stratmap/land-parcels.html",
      frozenAt: "2026-08-04",
      registryVersion: "1.2.0",
    },
  };

/** The frozen registry, keyed by rowId. Seeded with Bastrop; grows per onboarding. */
const REGISTRY_BY_ROW_ID: ReadonlyMap<string, JurisdictionRegistryRow> = new Map(
  [
    BASTROP_REGISTRY_ROW,
    BASTROP_COUNTY_UNINCORPORATED_REGISTRY_ROW,
    ELGIN_REGISTRY_ROW,
    BELL_COUNTY_UNINCORPORATED_REGISTRY_ROW,
    BEXAR_COUNTY_UNINCORPORATED_REGISTRY_ROW,
    CALDWELL_COUNTY_UNINCORPORATED_REGISTRY_ROW,
    COMAL_COUNTY_UNINCORPORATED_REGISTRY_ROW,
    GUADALUPE_COUNTY_UNINCORPORATED_REGISTRY_ROW,
    HAYS_COUNTY_UNINCORPORATED_REGISTRY_ROW,
    MCLENNAN_COUNTY_UNINCORPORATED_REGISTRY_ROW,
    WILLIAMSON_COUNTY_UNINCORPORATED_REGISTRY_ROW,
  ].map(
    (row) => [row.rowId, row],
  ),
);

/**
 * Load a jurisdiction's frozen registry row by FIPS. Where more than one row
 * shares a fips, returns the first "active" row for backward compatibility
 * with the original single-row-per-fips callers (the Phase D cohort loader).
 * Returns null when the jurisdiction has not been onboarded (honest-absence —
 * the caller declines, never fabricates a source). The engine reads THIS, not
 * a hardcoded adapter. Use `loadJurisdictionRegistryRowsForFips` to read every
 * row for a fips (e.g. pre-flight, which grades all rows for a fips).
 */
export function loadJurisdictionRegistryRow(
  fips: string,
): JurisdictionRegistryRow | null {
  const rows = loadJurisdictionRegistryRowsForFips(fips);
  return rows.find((r) => r.status === "active") ?? rows[0] ?? null;
}

/** Load every registry row for a fips (a fips can carry multiple rows — e.g. a city and its county). */
export function loadJurisdictionRegistryRowsForFips(
  fips: string,
): JurisdictionRegistryRow[] {
  return [...REGISTRY_BY_ROW_ID.values()].filter((r) => r.fips === fips);
}

/** Load a single registry row by its stable rowId. */
export function loadJurisdictionRegistryRowById(
  rowId: string,
): JurisdictionRegistryRow | null {
  return REGISTRY_BY_ROW_ID.get(rowId) ?? null;
}

/** Whether a jurisdiction has a frozen, active registry row (is onboarded at Rail C). */
export function isJurisdictionOnboarded(fips: string): boolean {
  return loadJurisdictionRegistryRowsForFips(fips).some((r) => r.status === "active");
}
