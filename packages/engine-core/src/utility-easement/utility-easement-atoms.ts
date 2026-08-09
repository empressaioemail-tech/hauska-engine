/**
 * Build + verify `utility-easement` atoms from a county plan.
 */

import {
  UTILITY_EASEMENT_SCHEMA,
  utilityEasementClaimContentHash,
  buildCountyUtilityEasementCoverageAbsenceAtom,
  buildPresentUtilityEasementAtom,
  buildUtilityEasementPerParcelAbsenceAtom,
  type PropertyFactWriteProvenance,
  type UtilityEasementAtomInstance,
} from "@hauska-engine/atoms";

import type {
  CountyUtilityEasementPlan,
  PlannedUtilityEasement,
} from "./plan-county-utility-easement.js";

export type UtilityEasementCountyRunProvenance = Omit<
  PropertyFactWriteProvenance,
  "contentHash" | "observedAt"
> & { observedAt: string };

export function buildAtomForPlannedUtilityEasement(
  entry: PlannedUtilityEasement,
  countyFips: string,
  provenance: UtilityEasementCountyRunProvenance,
): UtilityEasementAtomInstance {
  if (entry.outcome === "county-coverage-absence") {
    return buildCountyUtilityEasementCoverageAbsenceAtom(
      {
        countyFips: entry.countyFips,
        provenanceScope: entry.provenanceScope,
      },
      {
        ...provenance,
        contentHash: utilityEasementClaimContentHash({
          parcelNodeId: `${countyFips}:_county_coverage`,
          easementId: "county-coverage",
          sourceTier: "absent",
          verifiedAbsenceScope: entry.provenanceScope,
        }),
      },
    );
  }

  const parcelNodeId = `${countyFips}:${entry.parcelKey}`;

  if (entry.outcome === "present") {
    return buildPresentUtilityEasementAtom(
      {
        parcelNodeId,
        easementId: entry.easementId,
        easementClass: entry.easementClass,
        sourceTier:
          provenance.sourceAdapter === "municipal-easement-rest-v1"
            ? "county-gis"
            : "plat-gis-authoritative",
        easementGeometry: entry.easementGeometry,
        ...(entry.corridorWidthFt !== undefined
          ? { corridorWidthFt: entry.corridorWidthFt }
          : {}),
        ...(entry.recordingRef ? { recordingRef: entry.recordingRef } : {}),
      },
      {
        ...provenance,
        contentHash: utilityEasementClaimContentHash({
          parcelNodeId,
          easementId: entry.easementId,
          sourceTier:
            provenance.sourceAdapter === "municipal-easement-rest-v1"
              ? "county-gis"
              : "plat-gis-authoritative",
          easementClass: entry.easementClass,
        }),
      },
    );
  }

  return buildUtilityEasementPerParcelAbsenceAtom(
    {
      parcelNodeId,
      sourceTier: entry.sourceTier,
      absenceKind: "no-easement-feature",
      reason: entry.reason,
    },
    {
      ...provenance,
      contentHash: utilityEasementClaimContentHash({
        parcelNodeId,
        easementId: "absent",
        sourceTier: entry.sourceTier,
        absenceKind: "no-easement-feature",
        absenceReason: entry.reason,
      }),
    },
  );
}

export function buildAtomsForUtilityEasementPlan(
  plan: CountyUtilityEasementPlan,
  provenance: UtilityEasementCountyRunProvenance,
): ReadonlyArray<UtilityEasementAtomInstance> {
  return plan.planned.map((entry) =>
    buildAtomForPlannedUtilityEasement(entry, plan.countyFips, provenance),
  );
}

export type StoredUtilityEasementVerdict =
  | { ok: true }
  | { ok: false; parcelNodeId: string; problem: string };

export function verifyStoredUtilityEasementAtom(
  stored: unknown,
  expected: {
    parcelNodeId: string;
    outcome: "present" | "absent" | "county-coverage";
    easementId?: string;
  },
): StoredUtilityEasementVerdict {
  const fail = (problem: string): StoredUtilityEasementVerdict => ({
    ok: false,
    parcelNodeId: expected.parcelNodeId,
    problem,
  });

  const parsed = UTILITY_EASEMENT_SCHEMA.safeParse(stored);
  if (!parsed.success) {
    return fail(
      `stored bytes fail UTILITY_EASEMENT_SCHEMA: ${parsed.error.issues
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

  let storedOutcome: "present" | "absent" | "county-coverage";
  if (atom.sourceTier === "absent" && atom.verifiedAbsence) {
    storedOutcome = "county-coverage";
  } else if (atom.absence || atom.sourceTier === "absent") {
    storedOutcome = "absent";
  } else {
    storedOutcome = "present";
  }

  if (storedOutcome !== expected.outcome) {
    return fail(
      `stored outcome ${storedOutcome} != planned ${expected.outcome}`,
    );
  }

  if (
    expected.easementId &&
    atom.easementId !== expected.easementId &&
    expected.outcome !== "county-coverage"
  ) {
    return fail(
      `stored easementId ${atom.easementId} != expected ${expected.easementId}`,
    );
  }

  return { ok: true };
}
