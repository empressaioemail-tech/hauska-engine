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
}

export interface SetbackTable {
  jurisdictionKey: string;
  jurisdictionDisplayName: string;
  /** Optional context note for fallback / statewide-default tables. */
  note?: string;
  districts: SetbackDistrict[];
}
