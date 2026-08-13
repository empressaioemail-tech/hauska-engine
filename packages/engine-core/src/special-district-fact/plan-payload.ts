/**
 * Persisted special-district-fact plan artifact (slot-free plan/drain).
 *
 * Drain is FAIL CLOSED on membershipMethodId — only the locked true-geom
 * method may produce atoms.
 */

import { readFileSync, writeFileSync } from "node:fs";

import {
  EMPTY_COUNTY_DISTRICT_ABSENCE_RULE,
  OUTSIDE_TRUE_GEOM_ABSENCE_RULE,
} from "./honesty.js";
import {
  TRUE_GEOM_MEMBERSHIP_METHOD,
  assertTrueGeomMembershipMethod,
} from "./membership-method.js";
import type {
  CountySpecialDistrictPlan,
  PlannedSpecialDistrict,
} from "./plan-county-special-districts.js";
import type { PostgisSpecialDistrictPlanMeta } from "./postgis-special-district-plan.js";

export interface SpecialDistrictPlanStoreTruth {
  districtTablePresent?: boolean;
  districtRowsInCounty?: number;
  parcelsLoaded?: number;
  skippedNullGeometry?: number;
  registryCsvMissing?: string;
}

export interface SpecialDistrictPlanPayload {
  countyFips: string;
  membershipMethodId: string;
  plannedAt: string;
  districtsIndexed: number;
  emptyDistrictIndex: boolean;
  absenceReasoningRuleId: string;
  planned: PlannedSpecialDistrict[];
  counts: CountySpecialDistrictPlan["counts"];
  parcelsRead: number;
  storeTruth?: SpecialDistrictPlanStoreTruth;
  provenance?: {
    sourceAdapter: string;
    sourceCitation: string;
    sourceUrl: string;
    observedAt: string;
    jurisdictionTenant: string;
    verificationStatus: string;
    sourceVintage: string;
  };
}

export function buildPlanPayload(
  plan: CountySpecialDistrictPlan,
  meta: PostgisSpecialDistrictPlanMeta,
  extras?: {
    storeTruth?: SpecialDistrictPlanStoreTruth;
    provenance?: SpecialDistrictPlanPayload["provenance"];
  },
): SpecialDistrictPlanPayload {
  return {
    countyFips: plan.countyFips,
    membershipMethodId: meta.membershipMethodId,
    plannedAt: meta.plannedAt,
    districtsIndexed: plan.districtsIndexed,
    emptyDistrictIndex: plan.emptyDistrictIndex,
    absenceReasoningRuleId: meta.absenceReasoningRuleId,
    planned: [...plan.planned],
    counts: { ...plan.counts },
    parcelsRead: plan.parcelsRead,
    ...(extras?.storeTruth ? { storeTruth: extras.storeTruth } : {}),
    ...(extras?.provenance ? { provenance: extras.provenance } : {}),
  };
}

export function writePlanPayload(
  path: string,
  payload: SpecialDistrictPlanPayload,
): void {
  // Compact JSON — pretty-print doubles memory on metro counties and OOMs
  // the Node heap while stringifying (48039 @ 8GB).
  writeFileSync(path, JSON.stringify(payload));
}

export function readPlanPayload(path: string): SpecialDistrictPlanPayload {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as SpecialDistrictPlanPayload;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`special-district-fact plan payload invalid: ${path}`);
  }
  return parsed;
}

/**
 * Fail-closed drain gate: membershipMethodId must be the locked true-geom id.
 * Returns planned entries ready for atom build.
 */
export function drainSpecialDistrictPlanPayload(
  payload: SpecialDistrictPlanPayload,
): {
  countyFips: string;
  planned: PlannedSpecialDistrict[];
  plan: CountySpecialDistrictPlan;
  absenceReasoningRuleId: string;
  provenance: SpecialDistrictPlanPayload["provenance"];
} {
  if (
    payload.membershipMethodId == null ||
    payload.membershipMethodId === ""
  ) {
    throw new Error(
      `special-district-fact drain FAIL CLOSED: membershipMethodId missing`,
    );
  }
  assertTrueGeomMembershipMethod(payload.membershipMethodId);

  if (!payload.countyFips || !/^\d{5}$/.test(payload.countyFips)) {
    throw new Error(
      `special-district-fact drain FAIL CLOSED: invalid countyFips`,
    );
  }
  if (!Array.isArray(payload.planned)) {
    throw new Error(
      `special-district-fact drain FAIL CLOSED: planned[] missing`,
    );
  }

  const plan: CountySpecialDistrictPlan = {
    countyFips: payload.countyFips,
    districtsIndexed: payload.districtsIndexed ?? 0,
    parcelsRead: payload.parcelsRead ?? payload.planned.length,
    emptyDistrictIndex: Boolean(payload.emptyDistrictIndex),
    planned: payload.planned,
    counts: payload.counts ?? {
      presentMemberships: 0,
      absentOutside: 0,
      parcelsInDistrict: 0,
      parcelsOutside: 0,
      skippedUnusableKey: 0,
      rateEnrichedCount: 0,
    },
  };

  return {
    countyFips: payload.countyFips,
    planned: payload.planned,
    plan,
    absenceReasoningRuleId:
      payload.absenceReasoningRuleId ??
      (plan.emptyDistrictIndex
        ? EMPTY_COUNTY_DISTRICT_ABSENCE_RULE
        : OUTSIDE_TRUE_GEOM_ABSENCE_RULE),
    provenance: payload.provenance,
  };
}

export { TRUE_GEOM_MEMBERSHIP_METHOD };
