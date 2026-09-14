/**
 * P-154 (OPS-23 wave 6, R-1 CONFLICT ROW; AMENDED 2026-09-14 by A-148) — the
 * structured half of a second-source disclosure: everything a surface needs to
 * print the one conflict sentence from `@empressaio/atom-contract`'s
 * `setbackConflictNote`. It is data, not a sentence, so the SAME formatter can
 * produce the string on the panel, in `get_smart_site` and in the PDF (R-6:
 * one vocabulary module; the sentence is never retyped at a call site).
 *
 * The two arms mirror `SetbackConflictSecondSourceInput` in
 * `@empressaio/atom-contract/display` FIELD FOR FIELD, on purpose: a consumer
 * hands this payload straight to `setbackConflictNote` with no mapping step,
 * so there is no second implementation of the sentence to drift. A consumer
 * test asserts the exact string for the Bastrop case (see the lane close).
 *
 *  - `"second-source"` — TWO dated instruments disagree. The second source's
 *    own scalars in its own reading order (corner included where it publishes
 *    one), the ordinance its own row cites verbatim, and the effective date of
 *    the instrument we follow ONLY when that instrument is the repeal-and-adopt
 *    ordinance that superseded the cited one.
 *  - `"stale-numeric-columns"` — A-148, the Bastrop case. ONE layer: its
 *    numeric shortcut columns were never refreshed while its TEXT fields and
 *    the current ordinance say something else. The second source is that
 *    layer's numeric column, so it carries front/side/rear and NO corner
 *    (there is no numeric corner column), and the ordinance is REQUIRED.
 *
 * `null` means "read at source and not there", never a placeholder.
 */
export type SetbackSecondSourceConflict =
  | {
      shape: "second-source";
      /** How a customer would recognize the other source's own card, e.g. "One Click card". */
      secondSourceLabel: string;
      /** The second source's own scalars, front/side/rear[/corner]. */
      front: number;
      side: number;
      rear: number;
      /** Corner-side distance where the second source publishes one; null when it does not. */
      corner?: number | null;
      /** The ordinance the second source's own row cites, verbatim (e.g. "2019-51"); null when it cites none. */
      citation: string | null;
      /** The effective date of the instrument WE follow, when it superseded the cited ordinance. */
      repealedByEffectiveDate: string | null;
      /** The second source's own date, read at source; null when unreadable. Not part of the sentence. */
      source_date: string | null;
      /** How `source_date` was read (see SetbackDateBasis). Not part of the sentence. */
      date_basis: string;
    }
  | {
      shape: "stale-numeric-columns";
      /** How a customer would recognize the layer's own card, e.g. "One Click card". */
      secondSourceLabel: string;
      /** The numeric shortcut column values the layer's join reads. Front/side/rear only. */
      numeric: { front: number; side: number; rear: number };
      /** The same layer's TEXT-field values — the ones this operation follows. */
      text: { front: number; side: number; rear: number; corner?: number | null };
      /** The current ordinance the TEXT fields reflect. Required: this arm never states a value without a citation. */
      ordinance: string;
      /** Who the stale columns were confirmed with, verbatim. Absent when not confirmed. */
      confirmedWith?: string | null;
      /** The date of that confirmation. Absent when not confirmed. */
      confirmedOn?: string | null;
      /** The second source's own date, read at source; null when unreadable. Not part of the sentence. */
      source_date: string | null;
      /** How `source_date` was read (see SetbackDateBasis). Not part of the sentence. */
      date_basis: string;
    };

/** R25 — a jurisdiction's conflicting SECOND source, cited + called out honestly. */
export interface SetbackSecondSourceDisclosure {
  /** Name of the conflicting source (e.g. "layer 83 Zoned_Parcels Revisions"). */
  source: string;
  /** Plain-language conflict callout for the property details / card. */
  note: string;
  /** Optional citation link to the second source. */
  citation_url?: string;
  /**
   * P-154 wave 6 — the same disagreement as structured data, for the one
   * conflict sentence every surface prints. Present only when the resolver
   * found two sources that disagree on a value (never when they agree).
   */
  conflict?: SetbackSecondSourceConflict;
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
   * `@empressaio/setback-corpus/resolve`, wave 4; formerly this package's
   * own now-retired `most-current-setback-resolver.ts`). `null`/absent
   * means unreadable — never a placeholder date such as "1970-01-01" or an
   * emit timestamp.
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
