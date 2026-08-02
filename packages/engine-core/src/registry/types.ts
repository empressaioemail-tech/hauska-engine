/**
 * Registry-as-engine-input types (Phase A / A4).
 *
 * A jurisdiction registry row is a FROZEN, deterministic description of where
 * a county's parcel-geometry source lives and how to join it. This is the
 * engine-input shape the loader reads — it is additive alongside the existing
 * hardcoded per-county adapters (e.g. bastrop-per-parcel-record.ts); it does
 * NOT replace them yet.
 *
 * Fields are drawn from the TxGIO StratMap Rail C registry
 * (doc_repo `_land_records/txgio_stratmap_county_matrix_2026-08-02.json` +
 * `txgio_stratmap_rail_c_adapter_registry.yaml`), narrowed to what the engine
 * needs to resolve a county's geometry source deterministically.
 */

/** How the engine should acquire this county's parcel geometry. */
export type RegistryGeometrySourceMode =
  | "stratmap_bulk_zip"
  | "cad_direct_arcgis_rest"
  | "cad_direct_arcgis_rest_or_cad_bulk";

/** Join key used to match this county's geometry rows to engine parcel ids. */
export type RegistryJoinKey = "prop_id" | "geo_id_or_address_crosswalk";

export interface JurisdictionRegistryRow {
  /** Census county FIPS code, e.g. "48021" for Bastrop, TX. */
  fips: string;
  countyName: string;
  /** True when this county has a StratMap Land Parcels bulk zip available. */
  inStratmap: boolean;
  /** Deterministic source-of-geometry mode (adapter_routing_rules path). */
  geometrySource: RegistryGeometrySourceMode;
  /** Field used to join geometry rows to engine parcel identity. */
  joinKey: RegistryJoinKey;
  /**
   * True when a HIGH_PROP_ID_BAD_RATE (>= 0.25) gate requires an owner-name
   * match before trusting a prop_id join on this county (adapter_routing_rules
   * rule 3: owner_name_match_before_cad_join).
   */
  ownerMatchRequired: boolean;
  /** Bulk zip / REST download URL for this county's geometry, when known. */
  downloadUrl?: string;
  /** Source vintage, YYYYMM (e.g. "202503"). Null when not in StratMap. */
  vintageYyyymm: string | null;
  /** Source vintage as a date (first-of-month), ISO 8601. Null when not in StratMap. */
  vintageDate: string | null;
  /** Registry staleness flags carried through from the matrix (e.g. "STALE"). */
  flags: readonly string[];
  /** Row count in the source feature set, when known. */
  featureCount?: number;
  /** Fraction of rows with a bad prop_id (null/empty/0/zero-padded-0). */
  propIdBadRate?: number;
}
