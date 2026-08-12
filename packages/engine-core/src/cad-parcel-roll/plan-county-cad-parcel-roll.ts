/**
 * `cad-parcel-roll` COUNTY PLANNER — pure, no database access.
 *
 * HOLD counties (CROSSWALK_HOLD_FIPS ∪ LANDUSE_JOIN_HOLD_FIPS) → join-hold
 * absences for every usable CAD row. Else → present atoms from cad_property
 * claim fields. Both hold sets share the same root cause: the prop_id join
 * to TxGIO / parcel-node is unsafe, so promoting CAD attributes onto a
 * parcelNodeId would assert continuity the key cannot support.
 */

import {
  isCrosswalkHoldCounty,
  isLandUseJoinHoldCounty,
  isUsablePropId,
  normalizeForJoin,
  type ParcelKeyKind,
} from "@hauska-engine/atoms";
// ParcelKeyKind is re-exported from property-instances via the atoms package barrel.

export interface CadPropertyRowInput {
  countyFips: string;
  propId: string | null;
  taxYear: number;
  sourceFile: string;
  sourceVintage: string;
  ownerName?: string | null;
  ownerMailingAddress?: string | null;
  situsAddress?: string | null;
  situsCity?: string | null;
  situsZip?: string | null;
  legalDescription?: string | null;
  exemptionCodes?: ReadonlyArray<string> | null;
  landValue?: number | null;
  improvementValue?: number | null;
  marketValue?: number | null;
  assessedValue?: number | null;
  yearBuilt?: number | null;
  livingAreaSqft?: number | null;
  landAcres?: string | number | null;
  propertyUseCode?: string | null;
}

export interface PlannedPresentCadParcelRoll {
  outcome: "present";
  parcelKey: string;
  taxYear: number;
  keyKind: ParcelKeyKind;
  joinPassedOwnerMatchGate: true;
  sourceFile: string;
  sourceVintage: string;
  ownerName?: string;
  ownerMailingAddress?: string;
  situsAddress?: string;
  situsCity?: string;
  situsZip?: string;
  legalDescription?: string;
  exemptionCodes?: ReadonlyArray<string>;
  landValue?: number;
  improvementValue?: number;
  marketValue?: number;
  assessedValue?: number;
  yearBuilt?: number;
  livingAreaSqft?: number;
  landAcres?: string | number;
  propertyUseCode?: string;
}

export interface PlannedAbsentCadParcelRoll {
  outcome: "absent";
  parcelKey: string;
  taxYear: number;
  keyKind: ParcelKeyKind;
  absenceKind: "no-cad-row" | "join-hold";
  reason: string;
  sourceFile?: string;
  sourceVintage?: string;
}

export type PlannedCadParcelRoll =
  | PlannedPresentCadParcelRoll
  | PlannedAbsentCadParcelRoll;

export interface CountyCadParcelRollPlan {
  countyFips: string;
  rowsRead: number;
  hold: boolean;
  planned: ReadonlyArray<PlannedCadParcelRoll>;
  counts: {
    present: number;
    absent: number;
    skippedUnusableKey: number;
    absentByKind: Record<"no-cad-row" | "join-hold", number>;
  };
}

function optStr(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

function optNum(value: number | null | undefined): number | undefined {
  return value === null || value === undefined ? undefined : value;
}

function hasAnyPresentClaim(row: CadPropertyRowInput): boolean {
  return (
    optStr(row.situsAddress) !== undefined ||
    optStr(row.situsCity) !== undefined ||
    optStr(row.situsZip) !== undefined ||
    optStr(row.legalDescription) !== undefined ||
    (row.exemptionCodes !== null &&
      row.exemptionCodes !== undefined &&
      row.exemptionCodes.length > 0) ||
    optNum(row.landValue) !== undefined ||
    optNum(row.improvementValue) !== undefined ||
    optNum(row.marketValue) !== undefined ||
    optNum(row.assessedValue) !== undefined ||
    optNum(row.yearBuilt) !== undefined ||
    optNum(row.livingAreaSqft) !== undefined ||
    (row.landAcres !== null && row.landAcres !== undefined) ||
    optStr(row.propertyUseCode) !== undefined ||
    optStr(row.ownerName) !== undefined ||
    optStr(row.ownerMailingAddress) !== undefined
  );
}

/**
 * Plan CAD parcel-roll atoms for one county from already-loaded cad_property
 * rows. Store-truth sizing is the caller's job; this module does not probe.
 */
export function planCountyCadParcelRoll(
  rows: ReadonlyArray<CadPropertyRowInput>,
  opts: { countyFips: string; keyKind?: ParcelKeyKind },
): CountyCadParcelRollPlan {
  const hold =
    isCrosswalkHoldCounty(opts.countyFips) ||
    isLandUseJoinHoldCounty(opts.countyFips);
  const holdReason = isCrosswalkHoldCounty(opts.countyFips)
    ? `CROSSWALK_HOLD county ${opts.countyFips} — prop_id join unsafe; CAD attributes withheld`
    : `LANDUSE_JOIN_HOLD county ${opts.countyFips} — TxGIO prop_id does not join CAD roll; CAD attributes withheld`;
  const keyKind = opts.keyKind ?? "prop_id";
  const planned: PlannedCadParcelRoll[] = [];
  let skippedUnusableKey = 0;
  const absentByKind: Record<"no-cad-row" | "join-hold", number> = {
    "no-cad-row": 0,
    "join-hold": 0,
  };

  for (const row of rows) {
    if (row.countyFips !== opts.countyFips) continue;
    if (!isUsablePropId(row.propId)) {
      skippedUnusableKey += 1;
      continue;
    }
    const parcelKey = normalizeForJoin(row.propId);

    if (hold) {
      planned.push({
        outcome: "absent",
        parcelKey,
        taxYear: row.taxYear,
        keyKind,
        absenceKind: "join-hold",
        reason: holdReason,
        sourceFile: row.sourceFile,
        sourceVintage: row.sourceVintage,
      });
      absentByKind["join-hold"] += 1;
      continue;
    }

    if (!hasAnyPresentClaim(row)) {
      planned.push({
        outcome: "absent",
        parcelKey,
        taxYear: row.taxYear,
        keyKind,
        absenceKind: "no-cad-row",
        reason: `cad_property row for ${opts.countyFips}:${parcelKey} taxYear=${row.taxYear} carries no usable claim fields`,
        sourceFile: row.sourceFile,
        sourceVintage: row.sourceVintage,
      });
      absentByKind["no-cad-row"] += 1;
      continue;
    }

    planned.push({
      outcome: "present",
      parcelKey,
      taxYear: row.taxYear,
      keyKind,
      joinPassedOwnerMatchGate: true,
      sourceFile: row.sourceFile,
      sourceVintage: row.sourceVintage,
      ...(optStr(row.ownerName) ? { ownerName: optStr(row.ownerName) } : {}),
      ...(optStr(row.ownerMailingAddress)
        ? { ownerMailingAddress: optStr(row.ownerMailingAddress) }
        : {}),
      ...(optStr(row.situsAddress)
        ? { situsAddress: optStr(row.situsAddress) }
        : {}),
      ...(optStr(row.situsCity) ? { situsCity: optStr(row.situsCity) } : {}),
      ...(optStr(row.situsZip) ? { situsZip: optStr(row.situsZip) } : {}),
      ...(optStr(row.legalDescription)
        ? { legalDescription: optStr(row.legalDescription) }
        : {}),
      ...(row.exemptionCodes && row.exemptionCodes.length > 0
        ? { exemptionCodes: row.exemptionCodes }
        : {}),
      ...(optNum(row.landValue) !== undefined
        ? { landValue: optNum(row.landValue) }
        : {}),
      ...(optNum(row.improvementValue) !== undefined
        ? { improvementValue: optNum(row.improvementValue) }
        : {}),
      ...(optNum(row.marketValue) !== undefined
        ? { marketValue: optNum(row.marketValue) }
        : {}),
      ...(optNum(row.assessedValue) !== undefined
        ? { assessedValue: optNum(row.assessedValue) }
        : {}),
      ...(optNum(row.yearBuilt) !== undefined
        ? { yearBuilt: optNum(row.yearBuilt) }
        : {}),
      ...(optNum(row.livingAreaSqft) !== undefined
        ? { livingAreaSqft: optNum(row.livingAreaSqft) }
        : {}),
      ...(row.landAcres !== null && row.landAcres !== undefined
        ? { landAcres: row.landAcres }
        : {}),
      ...(optStr(row.propertyUseCode)
        ? { propertyUseCode: optStr(row.propertyUseCode) }
        : {}),
    });
  }

  return {
    countyFips: opts.countyFips,
    rowsRead: rows.length,
    hold,
    planned,
    counts: {
      present: planned.filter((p) => p.outcome === "present").length,
      absent: planned.filter((p) => p.outcome === "absent").length,
      skippedUnusableKey,
      absentByKind,
    },
  };
}
