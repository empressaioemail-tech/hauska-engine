/**
 * Build + verify `special-district-fact` atoms from a county plan.
 */

import {
  SPECIAL_DISTRICT_FACT_SCHEMA,
  buildCountySpecialDistrictCoverageAbsenceAtom,
  buildPresentSpecialDistrictFactAtom,
  buildSpecialDistrictFactAbsenceAtom,
  specialDistrictFactClaimContentHash,
  type SpecialDistrictFactAtomInstance,
  type PropertyFactWriteProvenance,
} from "@hauska-engine/atoms";

import type {
  CountySpecialDistrictPlan,
  PlannedSpecialDistrict,
} from "./plan-county-special-districts.js";

export type SpecialDistrictCountyRunProvenance = Omit<
  PropertyFactWriteProvenance,
  "contentHash" | "observedAt"
> & { observedAt: string };

export function buildAtomForPlannedSpecialDistrict(
  entry: PlannedSpecialDistrict,
  countyFips: string,
  provenance: SpecialDistrictCountyRunProvenance,
): SpecialDistrictFactAtomInstance {
  const parcelNodeId = `${countyFips}:${entry.parcelKey}`;

  if (entry.outcome === "present") {
    return buildPresentSpecialDistrictFactAtom(
      {
        parcelNodeId,
        districtName: entry.districtName,
        districtId: entry.districtId,
        districtType: entry.districtType,
        countyFips: entry.countyFips,
        ...(entry.taxRate ? { taxRate: entry.taxRate } : {}),
      },
      {
        ...provenance,
        contentHash: specialDistrictFactClaimContentHash({
          parcelNodeId,
          sourceTier: "tceq-water-districts",
          districtId: entry.districtId,
          districtType: entry.districtType,
        }),
      },
    );
  }

  return buildSpecialDistrictFactAbsenceAtom(
    {
      parcelNodeId,
      absenceKind: entry.absenceKind,
      reason: entry.reason,
    },
    {
      ...provenance,
      contentHash: specialDistrictFactClaimContentHash({
        parcelNodeId,
        sourceTier: "tceq-water-districts",
        absenceKind: entry.absenceKind,
        absenceReason: entry.reason,
      }),
    },
  );
}

export function buildAtomsForSpecialDistrictPlan(
  plan: CountySpecialDistrictPlan,
  provenance: SpecialDistrictCountyRunProvenance,
): ReadonlyArray<SpecialDistrictFactAtomInstance> {
  return plan.planned.map((entry) =>
    buildAtomForPlannedSpecialDistrict(entry, plan.countyFips, provenance),
  );
}

export function buildCountySpecialDistrictCoverageAtom(
  countyFips: string,
  provenanceScope: ReadonlyArray<string>,
  provenance: SpecialDistrictCountyRunProvenance,
): SpecialDistrictFactAtomInstance {
  return buildCountySpecialDistrictCoverageAbsenceAtom(
    { countyFips, provenanceScope },
    {
      ...provenance,
      contentHash: specialDistrictFactClaimContentHash({
        parcelNodeId: `${countyFips}:_county_coverage`,
        sourceTier: "absent",
        verifiedAbsenceScope: provenanceScope,
      }),
    },
  );
}

export type StoredSpecialDistrictVerdict =
  | { ok: true }
  | { ok: false; parcelNodeId: string; problem: string };

export function verifyStoredSpecialDistrictFactAtom(
  stored: unknown,
  expected: {
    parcelNodeId: string;
    outcome: "present" | "absent";
    districtId?: string;
  },
): StoredSpecialDistrictVerdict {
  const fail = (problem: string): StoredSpecialDistrictVerdict => ({
    ok: false,
    parcelNodeId: expected.parcelNodeId,
    problem,
  });

  const parsed = SPECIAL_DISTRICT_FACT_SCHEMA.safeParse(stored);
  if (!parsed.success) {
    return fail(
      `stored bytes fail SPECIAL_DISTRICT_FACT_SCHEMA: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const atom = parsed.data;
  if (atom.parcelNodeId !== expected.parcelNodeId) {
    return fail(
      `stored parcelNodeId ${atom.parcelNodeId} != expected ${expected.parcelNodeId}`,
    );
  }
  const storedOutcome =
    atom.absence || atom.sourceTier === "absent" || atom.verifiedAbsence
      ? "absent"
      : "present";
  if (storedOutcome !== expected.outcome) {
    return fail(
      `stored outcome ${storedOutcome} != planned ${expected.outcome}`,
    );
  }
  if (
    expected.outcome === "present" &&
    expected.districtId &&
    atom.districtId !== expected.districtId
  ) {
    return fail(
      `stored districtId ${atom.districtId} != expected ${expected.districtId}`,
    );
  }
  return { ok: true };
}
