/**
 * Build + verify `flood-hazard-fact` atoms from a county plan.
 */

import {
  FLOOD_HAZARD_FACT_SCHEMA,
  buildCountyFloodHazardCoverageAbsenceAtom,
  buildFloodHazardFactAbsenceAtom,
  buildPresentFloodHazardFactAtom,
  floodHazardFactClaimContentHash,
  type FloodHazardFactAtomInstance,
  type PropertyFactWriteProvenance,
} from "@hauska-engine/atoms";

import type {
  CountyFloodHazardPlan,
  PlannedFloodHazard,
} from "./plan-county-flood-hazard.js";

export type FloodCountyRunProvenance = Omit<
  PropertyFactWriteProvenance,
  "contentHash" | "observedAt"
> & { observedAt: string };

export function buildAtomForPlannedFloodHazard(
  entry: PlannedFloodHazard,
  countyFips: string,
  provenance: FloodCountyRunProvenance,
): FloodHazardFactAtomInstance {
  const parcelNodeId = `${countyFips}:${entry.parcelKey}`;

  if (entry.outcome === "present") {
    return buildPresentFloodHazardFactAtom(
      {
        parcelNodeId,
        inSpecialFloodHazardArea: entry.inSpecialFloodHazardArea,
        floodZone: entry.floodZone,
        zoneSubtype: entry.zoneSubtype,
        baseFloodElevation: entry.baseFloodElevation,
      },
      {
        ...provenance,
        ...(entry.sourceVintage ? { sourceVintage: entry.sourceVintage } : {}),
        contentHash: floodHazardFactClaimContentHash({
          parcelNodeId,
          sourceTier: "fema-nfhl",
          inSpecialFloodHazardArea: entry.inSpecialFloodHazardArea,
          floodZone: entry.floodZone,
        }),
      },
    );
  }

  return buildFloodHazardFactAbsenceAtom(
    {
      parcelNodeId,
      absenceKind: entry.absenceKind,
      reason: entry.reason,
    },
    {
      ...provenance,
      contentHash: floodHazardFactClaimContentHash({
        parcelNodeId,
        sourceTier: "fema-nfhl",
        absenceKind: entry.absenceKind,
        absenceReason: entry.reason,
      }),
    },
  );
}

export function buildAtomsForFloodHazardPlan(
  plan: CountyFloodHazardPlan,
  provenance: FloodCountyRunProvenance,
): ReadonlyArray<FloodHazardFactAtomInstance> {
  return plan.planned.map((entry) =>
    buildAtomForPlannedFloodHazard(entry, plan.countyFips, provenance),
  );
}

export function buildCountyFloodHazardCoverageAtom(
  countyFips: string,
  provenanceScope: ReadonlyArray<string>,
  provenance: FloodCountyRunProvenance,
): FloodHazardFactAtomInstance {
  return buildCountyFloodHazardCoverageAbsenceAtom(
    { countyFips, provenanceScope },
    {
      ...provenance,
      contentHash: floodHazardFactClaimContentHash({
        parcelNodeId: `${countyFips}:_county_coverage`,
        sourceTier: "absent",
        verifiedAbsenceScope: provenanceScope,
      }),
    },
  );
}

export type StoredFloodHazardVerdict =
  | { ok: true }
  | { ok: false; parcelNodeId: string; problem: string };

export function verifyStoredFloodHazardFactAtom(
  stored: unknown,
  expected: { parcelNodeId: string; outcome: "present" | "absent" },
): StoredFloodHazardVerdict {
  const fail = (problem: string): StoredFloodHazardVerdict => ({
    ok: false,
    parcelNodeId: expected.parcelNodeId,
    problem,
  });

  const parsed = FLOOD_HAZARD_FACT_SCHEMA.safeParse(stored);
  if (!parsed.success) {
    return fail(
      `stored bytes fail FLOOD_HAZARD_FACT_SCHEMA: ${parsed.error.issues
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
  return { ok: true };
}
