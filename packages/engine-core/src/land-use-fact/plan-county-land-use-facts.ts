/**
 * `land-use-fact` COUNTY PLANNER — pure join of parcels → cad_property.
 *
 * HOLD (Hays/Williamson) → join-hold. No CAD row → no-cad-row. Blank
 * property_use_code → no-land-use-code. Else present.
 */

import {
  isLandUseJoinHoldCounty,
  isUsablePropId,
  normalizeForJoin,
} from "@hauska-engine/atoms";

export interface LandUseParcelInput {
  parcelKey: string;
}

export interface LandUseCadRowInput {
  propId: string | null;
  taxYear: number;
  propertyUseCode: string | null;
  sourceVintage?: string | null;
}

export interface PlannedPresentLandUseFact {
  outcome: "present";
  parcelKey: string;
  taxYear: number;
  landUseCode: string;
  sourceVintage?: string;
}

export interface PlannedAbsentLandUseFact {
  outcome: "absent";
  parcelKey: string;
  taxYear: number;
  absenceKind: "no-land-use-code" | "no-cad-row" | "join-hold";
  reason: string;
  sourceVintage?: string;
}

export type PlannedLandUseFact =
  | PlannedPresentLandUseFact
  | PlannedAbsentLandUseFact;

export interface CountyLandUseFactPlan {
  countyFips: string;
  taxYear: number;
  hold: boolean;
  parcelsRead: number;
  cadRowsRead: number;
  planned: ReadonlyArray<PlannedLandUseFact>;
  counts: {
    present: number;
    absent: number;
    skippedUnusableKey: number;
    absentByKind: Record<
      "no-land-use-code" | "no-cad-row" | "join-hold",
      number
    >;
  };
}

/**
 * Build a normalized prop_id → CAD row map. Latest taxYear wins when
 * multiple years are supplied; caller usually pre-filters to one year.
 */
export function indexCadRowsByJoinKey(
  rows: ReadonlyArray<LandUseCadRowInput>,
): Map<string, LandUseCadRowInput> {
  const out = new Map<string, LandUseCadRowInput>();
  for (const row of rows) {
    if (!isUsablePropId(row.propId)) continue;
    const key = normalizeForJoin(row.propId);
    const prev = out.get(key);
    if (!prev || row.taxYear >= prev.taxYear) out.set(key, row);
  }
  return out;
}

export function planCountyLandUseFacts(
  parcels: ReadonlyArray<LandUseParcelInput>,
  cadRows: ReadonlyArray<LandUseCadRowInput>,
  opts: { countyFips: string; taxYear: number },
): CountyLandUseFactPlan {
  const hold = isLandUseJoinHoldCounty(opts.countyFips);
  const cadByKey = indexCadRowsByJoinKey(cadRows);
  const planned: PlannedLandUseFact[] = [];
  let skippedUnusableKey = 0;
  const absentByKind: Record<
    "no-land-use-code" | "no-cad-row" | "join-hold",
    number
  > = {
    "no-land-use-code": 0,
    "no-cad-row": 0,
    "join-hold": 0,
  };

  // Deduplicate parcels by normalized join key (one atom per account).
  const seen = new Set<string>();
  for (const parcel of parcels) {
    if (!isUsablePropId(parcel.parcelKey)) {
      skippedUnusableKey += 1;
      continue;
    }
    const parcelKey = normalizeForJoin(parcel.parcelKey);
    if (seen.has(parcelKey)) continue;
    seen.add(parcelKey);

    if (hold) {
      planned.push({
        outcome: "absent",
        parcelKey,
        taxYear: opts.taxYear,
        absenceKind: "join-hold",
        reason: `LANDUSE_JOIN_HOLD county ${opts.countyFips} — TxGIO prop_id does not join CAD property_use_code`,
      });
      absentByKind["join-hold"] += 1;
      continue;
    }

    const cad = cadByKey.get(parcelKey);
    if (!cad) {
      planned.push({
        outcome: "absent",
        parcelKey,
        taxYear: opts.taxYear,
        absenceKind: "no-cad-row",
        reason: `no cad_property row for ${opts.countyFips}:${parcelKey} at taxYear=${opts.taxYear}`,
      });
      absentByKind["no-cad-row"] += 1;
      continue;
    }

    const code =
      typeof cad.propertyUseCode === "string"
        ? cad.propertyUseCode.trim()
        : "";
    if (!code) {
      planned.push({
        outcome: "absent",
        parcelKey,
        taxYear: cad.taxYear || opts.taxYear,
        absenceKind: "no-land-use-code",
        reason: `cad_property row present for ${opts.countyFips}:${parcelKey} but property_use_code is blank`,
        ...(cad.sourceVintage ? { sourceVintage: cad.sourceVintage } : {}),
      });
      absentByKind["no-land-use-code"] += 1;
      continue;
    }

    planned.push({
      outcome: "present",
      parcelKey,
      taxYear: cad.taxYear || opts.taxYear,
      landUseCode: code,
      ...(cad.sourceVintage ? { sourceVintage: cad.sourceVintage } : {}),
    });
  }

  return {
    countyFips: opts.countyFips,
    taxYear: opts.taxYear,
    hold,
    parcelsRead: parcels.length,
    cadRowsRead: cadRows.length,
    planned,
    counts: {
      present: planned.filter((p) => p.outcome === "present").length,
      absent: planned.filter((p) => p.outcome === "absent").length,
      skippedUnusableKey,
      absentByKind,
    },
  };
}
