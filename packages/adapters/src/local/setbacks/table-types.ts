/** R25 — a jurisdiction's conflicting SECOND source, cited + called out honestly. */
export interface SetbackSecondSourceDisclosure {
  /** Name of the conflicting source (e.g. "layer 83 Zoned_Parcels Revisions"). */
  source: string;
  /** Plain-language conflict callout for the property details / card. */
  note: string;
  /** Optional citation link to the second source. */
  citation_url?: string;
}

/** R26 — a minor (non-dominant) zone present on a split-zoned parcel, for disclosure. */
export interface SetbackSplitZoneMinorZone {
  district_code: string | null;
  shape_area?: number;
}

/**
 * R22/R24/R25/R26 — full-field + disclosure metadata carried alongside the
 * scalar setback row so the PE card can surface every OnClick field honestly.
 */
export interface SetbackDisplayMeta {
  /** Minimum lot size verbatim (e.g. "1/4 ac"). */
  min_lot_size?: string;
  /** R22 — side yard resolved from a building/fire-code deferral (5ft), not a printed scalar. */
  side_fire_code_deferral?: boolean;
  /** City's verbatim side-yard language when deferred to building/fire code. */
  side_city_language?: string;
  /** R26 — dominant district when a split-zone parcel's stamp differed. */
  resolved_district_code?: string | null;
  /** R26/R25 — minor zones present on a split-zoned parcel. */
  split_zone_minor_zones?: SetbackSplitZoneMinorZone[];
  /** R25 — conflicting second source (e.g. Bastrop layer-83 Revisions). */
  second_source?: SetbackSecondSourceDisclosure;
  /**
   * P-154 (R-1, most-current-source-wins) — this row's date, read AT
   * SOURCE, and how (see `SetbackDateBasis` in
   * `most-current-setback-resolver.ts`). `null`/absent means unreadable —
   * never a placeholder date such as "1970-01-01" or an emit timestamp.
   */
  source_date?: string | null;
  date_basis?: string;
  date_precision?: "day" | "year";
}

/** Per locked decision #9 — one row per zoning district per jurisdiction. */
export interface SetbackDistrict {
  district_name: string;
  front_ft: number;
  rear_ft: number;
  side_ft: number;
  side_corner_ft: number;
  max_height_ft: number;
  max_lot_coverage_pct: number;
  max_impervious_pct: number;
  citation_url: string;
  /** Fan-gift per-field provenance (optional on legacy tables). */
  provenance?: Record<string, unknown>;
  /** R22/R24/R25/R26 — full-field + disclosure metadata (optional; per-parcel tables). */
  display_meta?: SetbackDisplayMeta;
}

export interface SetbackTable {
  jurisdictionKey: string;
  jurisdictionDisplayName: string;
  /** Optional context note for fallback / statewide-default tables. */
  note?: string;
  /**
   * P-154 (R-1) — the ordinance/corpus edition's own effective date
   * (ISO yyyy-mm-dd), read at source. Was previously read only via an
   * ad hoc `(table as { effectiveDate?: string })` cast (see
   * legacy-design-tools `authoritativeSetbackSource.ts`
   * `effectiveDateForTable`); typed here so this repo's own callers don't
   * need the same cast. The `@empressaio/setback-corpus` package DOES
   * carry this field on `bastrop-development-code` ("2026-04-14") even
   * though the frozen local vendored JSON in this repo's own
   * `bastrop-development-code.json` does not (verified 2026-09-12) — that
   * file is documented as a retiring comparison baseline, not the served
   * table (`index.ts`'s own header comment); this field describes the
   * SERVED shape.
   */
  effectiveDate?: string;
  districts: SetbackDistrict[];
}
