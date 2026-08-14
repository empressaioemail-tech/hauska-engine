/**
 * Build + verify `land-use-fact` atoms from a county plan.
 */

import {
  LAND_USE_FACT_SCHEMA,
  buildCountyLandUseCoverageAbsenceAtom,
  buildLandUseFactAbsenceAtom,
  buildPresentLandUseFactAtom,
  landUseFactClaimContentHash,
  type LandUseFactAtomInstance,
  type PropertyFactWriteProvenance,
} from "@hauska-engine/atoms";

import type {
  CountyLandUseFactPlan,
  PlannedLandUseFact,
} from "./plan-county-land-use-facts.js";

export type LandUseCountyRunProvenance = Omit<
  PropertyFactWriteProvenance,
  "contentHash" | "observedAt"
> & { observedAt: string };

export function buildAtomForPlannedLandUseFact(
  entry: PlannedLandUseFact,
  countyFips: string,
  provenance: LandUseCountyRunProvenance,
): LandUseFactAtomInstance {
  const parcelNodeId = `${countyFips}:${entry.parcelKey}`;

  if (entry.outcome === "present") {
    return buildPresentLandUseFactAtom(
      {
        parcelNodeId,
        taxYear: entry.taxYear,
        landUseCode: entry.landUseCode,
      },
      {
        ...provenance,
        ...(entry.sourceVintage ? { sourceVintage: entry.sourceVintage } : {}),
        contentHash: landUseFactClaimContentHash({
          parcelNodeId,
          taxYear: entry.taxYear,
          sourceTier: "cad-authoritative",
          landUseCode: entry.landUseCode,
        }),
      },
    );
  }

  const atomAbsenceKind =
    entry.absenceKind === "vintage-gap" ? "no-cad-row" : entry.absenceKind;

  return buildLandUseFactAbsenceAtom(
    {
      parcelNodeId,
      taxYear: entry.taxYear,
      // Contract LandUseAbsenceKind does not yet include vintage-gap;
      // kind stays no-cad-row while basis travels in reason (L17 open: contract bump).
      absenceKind: atomAbsenceKind,
      reason: entry.reason,
    },
    {
      ...provenance,
      ...(entry.sourceVintage ? { sourceVintage: entry.sourceVintage } : {}),
      contentHash: landUseFactClaimContentHash({
        parcelNodeId,
        taxYear: entry.taxYear,
        sourceTier: "cad-authoritative",
        absenceKind: entry.absenceKind,
        absenceReason: entry.reason,
      }),
    },
  );
}

export function buildAtomsForLandUseFactPlan(
  plan: CountyLandUseFactPlan,
  provenance: LandUseCountyRunProvenance,
): ReadonlyArray<LandUseFactAtomInstance> {
  return plan.planned.map((entry) =>
    buildAtomForPlannedLandUseFact(entry, plan.countyFips, provenance),
  );
}

export function buildCountyLandUseCoverageAtom(
  countyFips: string,
  taxYear: number,
  provenanceScope: ReadonlyArray<string>,
  provenance: LandUseCountyRunProvenance,
): LandUseFactAtomInstance {
  return buildCountyLandUseCoverageAbsenceAtom(
    { countyFips, taxYear, provenanceScope },
    {
      ...provenance,
      contentHash: landUseFactClaimContentHash({
        parcelNodeId: `${countyFips}:_county_coverage`,
        taxYear,
        sourceTier: "absent",
        verifiedAbsenceScope: provenanceScope,
      }),
    },
  );
}

export type StoredLandUseFactVerdict =
  | { ok: true }
  | { ok: false; parcelNodeId: string; taxYear: number; problem: string };

export function verifyStoredLandUseFactAtom(
  stored: unknown,
  expected: {
    parcelNodeId: string;
    taxYear: number;
    outcome: "present" | "absent";
  },
): StoredLandUseFactVerdict {
  const fail = (problem: string): StoredLandUseFactVerdict => ({
    ok: false,
    parcelNodeId: expected.parcelNodeId,
    taxYear: expected.taxYear,
    problem,
  });

  const parsed = LAND_USE_FACT_SCHEMA.safeParse(stored);
  if (!parsed.success) {
    return fail(
      `stored bytes fail LAND_USE_FACT_SCHEMA: ${parsed.error.issues
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
  if (atom.taxYear !== expected.taxYear) {
    return fail(
      `stored taxYear ${atom.taxYear} != expected ${expected.taxYear}`,
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
  return { ok: true };
}
