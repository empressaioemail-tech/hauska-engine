/**
 * `owner-fact` COUNTY PLANNER — pure join of parcels → cad_property.
 *
 * Mirrors the land-use planner: no CAD row → no-cad-row; blank owner_name →
 * no-owner-name; else present. The join-hold counties are the same set for
 * the same reason (TxGIO prop_id does not address the CAD account there), so
 * the hold predicate is shared rather than re-derived.
 *
 * THE ONE SHAPE THAT DOES NOT EXIST FOR THE OTHER CAD FACETS: a CAD may
 * publish a parcel row while lawfully SUPPRESSING owner identity — Texas
 * confidentiality elections for judges, peace officers, and victims of family
 * violence are statutory. That is `owner-withheld`, an ESTABLISHED absence,
 * and it must never be flattened into "no owner name" (which reads as a data
 * gap) or into an empty string (which reads as a fact).
 *
 * We cannot detect an election directly — the CAD simply omits the name. What
 * we CAN do is refuse to guess: a blank owner on a row that otherwise looks
 * complete is reported as `no-owner-name` with the row's own evidence, and
 * callers that hold a district's published suppression list may pass
 * `withheldKeys` to promote those specific parcels to `owner-withheld`.
 * Absent that list we make the weaker, true claim.
 */

import {
  isLandUseJoinHoldCounty,
  isUsablePropId,
  normalizeForJoin,
} from "@hauska-engine/atoms";

export interface OwnerParcelInput {
  parcelKey: string;
}

export interface OwnerCadRowInput {
  propId: string | null;
  taxYear: number;
  ownerName: string | null;
  ownerMailingAddress: string | null;
  exemptionCodes: ReadonlyArray<string> | null;
  sourceVintage?: string | null;
}

export type OwnerAbsenceKind =
  | "no-owner-name"
  | "owner-withheld"
  | "no-cad-row"
  | "join-hold";

export interface PlannedPresentOwnerFact {
  outcome: "present";
  parcelKey: string;
  taxYear: number;
  ownerName: string;
  ownerMailingAddress?: string;
  exemptionCodes?: ReadonlyArray<string>;
  sourceVintage?: string;
}

export interface PlannedAbsentOwnerFact {
  outcome: "absent";
  parcelKey: string;
  taxYear: number;
  absenceKind: OwnerAbsenceKind;
  reason: string;
  sourceVintage?: string;
}

export type PlannedOwnerFact = PlannedPresentOwnerFact | PlannedAbsentOwnerFact;

export interface CountyOwnerFactPlan {
  countyFips: string;
  taxYear: number;
  hold: boolean;
  parcelsRead: number;
  cadRowsRead: number;
  planned: ReadonlyArray<PlannedOwnerFact>;
  counts: {
    present: number;
    absent: number;
    skippedUnusableKey: number;
    /** Present atoms that carry a mailing address alongside the name. */
    withMailingAddress: number;
    absentByKind: Record<OwnerAbsenceKind, number>;
  };
}

/**
 * Build a normalized prop_id → CAD row map. Latest taxYear wins when multiple
 * years are supplied; caller usually pre-filters to one year.
 */
export function indexOwnerCadRowsByJoinKey(
  rows: ReadonlyArray<OwnerCadRowInput>,
): Map<string, OwnerCadRowInput> {
  const out = new Map<string, OwnerCadRowInput>();
  for (const row of rows) {
    if (!isUsablePropId(row.propId)) continue;
    const key = normalizeForJoin(row.propId);
    const prev = out.get(key);
    if (!prev || row.taxYear >= prev.taxYear) out.set(key, row);
  }
  return out;
}

export function planCountyOwnerFacts(
  parcels: ReadonlyArray<OwnerParcelInput>,
  cadRows: ReadonlyArray<OwnerCadRowInput>,
  opts: {
    countyFips: string;
    taxYear: number;
    /**
     * Normalized parcel keys known to carry a statutory confidentiality
     * election. Only supply from a district's PUBLISHED list — never infer.
     */
    withheldKeys?: ReadonlySet<string>;
  },
): CountyOwnerFactPlan {
  const hold = isLandUseJoinHoldCounty(opts.countyFips);
  const cadByKey = indexOwnerCadRowsByJoinKey(cadRows);
  const withheld = opts.withheldKeys ?? new Set<string>();
  const planned: PlannedOwnerFact[] = [];
  let skippedUnusableKey = 0;
  let withMailingAddress = 0;
  const absentByKind: Record<OwnerAbsenceKind, number> = {
    "no-owner-name": 0,
    "owner-withheld": 0,
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
        reason: `LANDUSE_JOIN_HOLD county ${opts.countyFips} — TxGIO prop_id does not join the CAD account`,
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

    const vintage = cad.sourceVintage
      ? { sourceVintage: cad.sourceVintage }
      : {};
    const taxYear = cad.taxYear || opts.taxYear;

    // Published suppression list wins over the blank-name read.
    if (withheld.has(parcelKey)) {
      planned.push({
        outcome: "absent",
        parcelKey,
        taxYear,
        absenceKind: "owner-withheld",
        reason: `owner identity suppressed for ${opts.countyFips}:${parcelKey} under a statutory confidentiality election`,
        ...vintage,
      });
      absentByKind["owner-withheld"] += 1;
      continue;
    }

    const name = typeof cad.ownerName === "string" ? cad.ownerName.trim() : "";
    if (!name) {
      planned.push({
        outcome: "absent",
        parcelKey,
        taxYear,
        absenceKind: "no-owner-name",
        reason: `cad_property row present for ${opts.countyFips}:${parcelKey} but owner_name is blank`,
        ...vintage,
      });
      absentByKind["no-owner-name"] += 1;
      continue;
    }

    const mailing =
      typeof cad.ownerMailingAddress === "string"
        ? cad.ownerMailingAddress.trim()
        : "";
    if (mailing) withMailingAddress += 1;

    const codes = (cad.exemptionCodes ?? []).filter(
      (c): c is string => typeof c === "string" && c.trim().length > 0,
    );

    planned.push({
      outcome: "present",
      parcelKey,
      taxYear,
      ownerName: name,
      ...(mailing ? { ownerMailingAddress: mailing } : {}),
      ...(codes.length > 0 ? { exemptionCodes: codes } : {}),
      ...vintage,
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
      withMailingAddress,
      absentByKind,
    },
  };
}
