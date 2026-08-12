/**
 * `special-district-fact` COUNTY PLANNER.
 *
 * Binary point-in-polygon against TCEQ water-district polygons loaded in
 * tx_special_district. No proximity semantics — adjacency does not imply
 * membership.
 */

import {
  buildEmptyCountyDistrictAbsenceReason,
  buildOutsideSourceAbsenceReason,
} from "./honesty.js";

import type { ComptrollerTaxRateEnrichment } from "./comptroller-registry.js";
import { buildDistrictSpatialIndex } from "./geo.js";
import type { LngLat, SpecialDistrictFeature } from "./geo.js";

export interface SpecialDistrictParcelInput {
  parcelKey: string;
  centroid: LngLat | null;
}

export interface PlannedPresentSpecialDistrict {
  outcome: "present";
  parcelKey: string;
  districtId: string;
  districtName: string;
  districtType: string;
  countyFips: string;
  taxRate?: ComptrollerTaxRateEnrichment;
}

export interface PlannedAbsentSpecialDistrict {
  outcome: "absent";
  parcelKey: string;
  absenceKind: "outside-tceq-source-boundaries";
  reason: string;
}

export type PlannedSpecialDistrict =
  | PlannedPresentSpecialDistrict
  | PlannedAbsentSpecialDistrict;

export interface CountySpecialDistrictPlan {
  countyFips: string;
  districtsIndexed: number;
  parcelsRead: number;
  emptyDistrictIndex: boolean;
  planned: ReadonlyArray<PlannedSpecialDistrict>;
  counts: {
    presentMemberships: number;
    absentOutside: number;
    parcelsInDistrict: number;
    parcelsOutside: number;
    skippedUnusableKey: number;
    rateEnrichedCount: number;
  };
}

export function planCountySpecialDistricts(
  parcels: ReadonlyArray<SpecialDistrictParcelInput>,
  districts: ReadonlyArray<SpecialDistrictFeature>,
  opts: {
    countyFips: string;
    /** When false, only counts + optional samples are retained (large-county dry-runs). */
    retainPlanned?: boolean;
    sampleLimit?: number;
    taxLookup?: (
      countyFips: string,
      districtType: string,
      districtName: string,
    ) => ComptrollerTaxRateEnrichment | undefined;
  },
): CountySpecialDistrictPlan {
  const retainPlanned = opts.retainPlanned !== false;
  const sampleLimit = opts.sampleLimit ?? 0;
  const emptyDistrictIndex = districts.length === 0;
  const planned: PlannedSpecialDistrict[] = [];
  let skippedUnusableKey = 0;
  let presentMemberships = 0;
  let parcelsInDistrict = 0;
  let parcelsOutside = 0;
  let absentOutside = 0;
  let rateEnrichedCount = 0;
  const seen = new Set<string>();
  const outsideReason = buildOutsideSourceAbsenceReason(opts.countyFips);
  const emptyCountyReason = buildEmptyCountyDistrictAbsenceReason(
    opts.countyFips,
  );

  const pushSample = (entry: PlannedSpecialDistrict) => {
    if (retainPlanned) {
      planned.push(entry);
      return;
    }
    if (sampleLimit > 0 && planned.length < sampleLimit) planned.push(entry);
  };

  const index = emptyDistrictIndex ? null : buildDistrictSpatialIndex(districts);

  for (const parcel of parcels) {
    const key = parcel.parcelKey?.trim() ?? "";
    if (!key || /^0+$/.test(key)) {
      skippedUnusableKey += 1;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);

    if (emptyDistrictIndex) {
      pushSample({
        outcome: "absent",
        parcelKey: key,
        absenceKind: "outside-tceq-source-boundaries",
        reason: emptyCountyReason,
      });
      parcelsOutside += 1;
      absentOutside += 1;
      continue;
    }

    if (
      !parcel.centroid ||
      !Number.isFinite(parcel.centroid[0]) ||
      !Number.isFinite(parcel.centroid[1])
    ) {
      pushSample({
        outcome: "absent",
        parcelKey: key,
        absenceKind: "outside-tceq-source-boundaries",
        reason: outsideReason,
      });
      parcelsOutside += 1;
      absentOutside += 1;
      continue;
    }

    const hits = index!.lookup(parcel.centroid[0], parcel.centroid[1]);

    if (hits.length === 0) {
      pushSample({
        outcome: "absent",
        parcelKey: key,
        absenceKind: "outside-tceq-source-boundaries",
        reason: outsideReason,
      });
      parcelsOutside += 1;
      absentOutside += 1;
      continue;
    }

    parcelsInDistrict += 1;
    for (const hit of hits) {
      const taxRate = opts.taxLookup?.(
        hit.countyFips,
        hit.districtType,
        hit.districtName,
      );
      if (taxRate) rateEnrichedCount += 1;
      pushSample({
        outcome: "present",
        parcelKey: key,
        districtId: hit.districtId,
        districtName: hit.districtName,
        districtType: hit.districtType,
        countyFips: hit.countyFips,
        ...(taxRate ? { taxRate } : {}),
      });
      presentMemberships += 1;
    }
  }

  const wouldWriteTotal = presentMemberships + absentOutside;

  return {
    countyFips: opts.countyFips,
    districtsIndexed: districts.length,
    parcelsRead: parcels.length,
    emptyDistrictIndex,
    planned,
    counts: {
      presentMemberships,
      absentOutside,
      parcelsInDistrict,
      parcelsOutside,
      skippedUnusableKey,
      rateEnrichedCount,
    },
  };
}

export function attachComptrollerTaxRates(
  plan: CountySpecialDistrictPlan,
  lookup: (
    countyFips: string,
    districtType: string,
    districtName: string,
  ) => ComptrollerTaxRateEnrichment | undefined,
): CountySpecialDistrictPlan {
  let rateEnrichedCount = 0;
  const planned = plan.planned.map((entry) => {
    if (entry.outcome !== "present") return entry;
    const taxRate = lookup(
      entry.countyFips,
      entry.districtType,
      entry.districtName,
    );
    if (taxRate) rateEnrichedCount += 1;
    return taxRate ? { ...entry, taxRate } : entry;
  });
  return {
    ...plan,
    planned,
    counts: { ...plan.counts, rateEnrichedCount },
  };
}
