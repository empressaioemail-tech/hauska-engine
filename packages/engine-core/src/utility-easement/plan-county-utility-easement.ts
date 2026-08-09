/**
 * `utility-easement` COUNTY PLANNER.
 *
 * Honest-absence counties emit ONE county-coverage atom (never fake geometry).
 * Present-data counties spatial-join easement features to parcel rings.
 */

import { isUsablePropId } from "@hauska-engine/atoms";

import { planCountyEasementHonestAbsence } from "./county-absence.js";
import {
  resolveCountyEasementRoute,
  type CountyEasementRoute,
  type EasementScope,
} from "./constants.js";
import { classifyEasementStatus } from "./easement-classify.js";
import {
  easementIntersectsParcelRing,
  type EasementFeatureInput,
  type EasementParcelInput,
} from "./geo.js";
import { joinMunicipalEasementsToParcels } from "./municipal-easement.js";

export interface PlannedCountyEasementCoverage {
  outcome: "county-coverage-absence";
  countyFips: string;
  provenanceScope: readonly string[];
}

export interface PlannedPresentEasement {
  outcome: "present";
  parcelKey: string;
  easementId: string;
  easementClass: ReturnType<typeof classifyEasementStatus>;
  easementGeometry: EasementFeatureInput["geometry"];
  recordingRef: { county: string; instrumentNumber?: string } | null;
  corridorWidthFt?: number;
}

export interface PlannedPerParcelEasementAbsence {
  outcome: "per-parcel-absence";
  parcelKey: string;
  sourceTier: "plat-gis-authoritative" | "county-gis";
  reason: string;
}

export type PlannedUtilityEasement =
  | PlannedCountyEasementCoverage
  | PlannedPresentEasement
  | PlannedPerParcelEasementAbsence;

export interface CountyUtilityEasementPlan {
  countyFips: string;
  scope: EasementScope;
  route: CountyEasementRoute;
  parcelsRead: number;
  easementFeaturesRead: number;
  planned: ReadonlyArray<PlannedUtilityEasement>;
  counts: {
    countyCoverageAbsence: number;
    present: number;
    perParcelAbsence: number;
    skippedUnusableKey: number;
  };
}

function dedupeParcels(
  parcels: ReadonlyArray<EasementParcelInput>,
): { usable: EasementParcelInput[]; skippedUnusableKey: number } {
  const usable: EasementParcelInput[] = [];
  const seen = new Set<string>();
  let skippedUnusableKey = 0;
  for (const parcel of parcels) {
    const key = parcel.parcelKey?.trim() ?? "";
    if (!isUsablePropId(key)) {
      skippedUnusableKey += 1;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    usable.push({ ...parcel, parcelKey: key });
  }
  return { usable, skippedUnusableKey };
}

function planCadEasementRest(input: {
  countyFips: string;
  scope: EasementScope;
  route: Extract<CountyEasementRoute, { adapterKind: "cad-easement-rest" }>;
  parcels: ReadonlyArray<EasementParcelInput>;
  easements: ReadonlyArray<EasementFeatureInput>;
}): CountyUtilityEasementPlan {
  const { usable, skippedUnusableKey } = dedupeParcels(input.parcels);
  const planned: PlannedUtilityEasement[] = [];
  let present = 0;
  let perParcelAbsence = 0;

  for (const parcel of usable) {
    const hits = input.easements.filter((e) =>
      easementIntersectsParcelRing(
        e.geometry,
        parcel.ring,
        input.route.corridorDefaultWidthFt,
      ),
    );
    if (hits.length === 0) {
      planned.push({
        outcome: "per-parcel-absence",
        parcelKey: parcel.parcelKey,
        sourceTier: "plat-gis-authoritative",
        reason: `no easement feature intersects parcel after CAD layers ${input.route.layerIds.join(",")} join`,
      });
      perParcelAbsence += 1;
      continue;
    }
    for (const easement of hits) {
      planned.push({
        outcome: "present",
        parcelKey: parcel.parcelKey,
        easementId: easement.easementId,
        easementClass: classifyEasementStatus(easement.status),
        easementGeometry: easement.geometry,
        recordingRef: easement.docNum
          ? { county: input.countyFips, instrumentNumber: easement.docNum }
          : null,
        ...(easement.geometry.type === "LineString"
          ? { corridorWidthFt: input.route.corridorDefaultWidthFt }
          : {}),
      });
      present += 1;
    }
  }

  return {
    countyFips: input.countyFips,
    scope: input.scope,
    route: input.route,
    parcelsRead: input.parcels.length,
    easementFeaturesRead: input.easements.length,
    planned,
    counts: {
      countyCoverageAbsence: 0,
      present,
      perParcelAbsence,
      skippedUnusableKey,
    },
  };
}

function planMunicipalEasementRest(input: {
  countyFips: string;
  scope: EasementScope;
  route: Extract<CountyEasementRoute, { adapterKind: "municipal-easement-rest" }>;
  parcels: ReadonlyArray<EasementParcelInput>;
  easements: ReadonlyArray<EasementFeatureInput>;
}): CountyUtilityEasementPlan {
  const { usable, skippedUnusableKey } = dedupeParcels(input.parcels);
  const join = joinMunicipalEasementsToParcels({
    parcels: usable,
    easements: input.easements,
  });

  const planned: PlannedUtilityEasement[] = [];
  for (const hit of join.present) {
    planned.push({
      outcome: "present",
      parcelKey: hit.parcelKey,
      easementId: hit.easementId,
      easementClass: hit.easementClass,
      easementGeometry: hit.easementGeometry,
      recordingRef: null,
    });
  }
  for (const parcelKey of join.perParcelAbsence) {
    planned.push({
      outcome: "per-parcel-absence",
      parcelKey,
      sourceTier: "county-gis",
      reason:
        "municipal easement source exists but no Easements_/43 feature intersects parcel inside city limits",
    });
  }

  return {
    countyFips: input.countyFips,
    scope: input.scope,
    route: input.route,
    parcelsRead: input.parcels.length,
    easementFeaturesRead: input.easements.length,
    planned,
    counts: {
      countyCoverageAbsence: 0,
      present: join.present.length,
      perParcelAbsence: join.perParcelAbsence.length,
      skippedUnusableKey,
    },
  };
}

export function planCountyUtilityEasement(input: {
  countyFips: string;
  scope?: EasementScope;
  parcels?: ReadonlyArray<EasementParcelInput>;
  easements?: ReadonlyArray<EasementFeatureInput>;
}): CountyUtilityEasementPlan {
  const scope = input.scope ?? "county";
  const route = resolveCountyEasementRoute(input.countyFips, scope);

  if (route.adapterKind === "honest-absence") {
    const absence = planCountyEasementHonestAbsence({
      countyFips: input.countyFips,
      scope,
    });
    return {
      countyFips: input.countyFips,
      scope,
      route,
      parcelsRead: input.parcels?.length ?? 0,
      easementFeaturesRead: 0,
      planned: [absence.countyCoverage],
      counts: {
        countyCoverageAbsence: 1,
        present: 0,
        perParcelAbsence: 0,
        skippedUnusableKey: 0,
      },
    };
  }

  const parcels = input.parcels ?? [];
  const easements = input.easements ?? [];

  if (route.adapterKind === "cad-easement-rest") {
    return planCadEasementRest({
      countyFips: input.countyFips,
      scope,
      route,
      parcels,
      easements,
    });
  }

  if (route.adapterKind === "municipal-easement-rest") {
    return planMunicipalEasementRest({
      countyFips: input.countyFips,
      scope,
      route,
      parcels,
      easements,
    });
  }

  throw new Error(`Unsupported easement adapter kind: ${(route as CountyEasementRoute).adapterKind}`);
}
