/**
 * Build + verify `rail-corridor-fact` atoms from a county plan.
 */

import {
  RAIL_CORRIDOR_FACT_SCHEMA,
  buildCountyRailCorridorCoverageAbsenceAtom,
  buildPresentRailCorridorFactAtom,
  buildRailCorridorFactAbsenceAtom,
  railCorridorFactClaimContentHash,
  type RailCorridorFactAtomInstance,
  type PropertyFactWriteProvenance,
} from "@hauska-engine/atoms";

import type {
  CountyRailCorridorPlan,
  PlannedRailCorridor,
} from "./plan-county-rail-corridor.js";

export type RailCorridorCountyRunProvenance = Omit<
  PropertyFactWriteProvenance,
  "contentHash" | "observedAt"
> & { observedAt: string };

export function buildAtomForPlannedRailCorridor(
  entry: PlannedRailCorridor,
  countyFips: string,
  provenance: RailCorridorCountyRunProvenance,
): RailCorridorFactAtomInstance {
  const parcelNodeId = `${countyFips}:${entry.parcelKey}`;

  if (entry.outcome === "present") {
    return buildPresentRailCorridorFactAtom(
      {
        parcelNodeId,
        bufferMeters: entry.bufferMeters,
        nearRailCorridor: entry.nearRailCorridor,
        ...(entry.nearRailCorridor
          ? {
              corridorStatus: entry.corridorStatus,
              corridorClass: entry.corridorClass,
              nearestCorridorDistanceMeters: entry.nearestCorridorDistanceMeters,
              ...(entry.atGradeCrossings
                ? { atGradeCrossings: entry.atGradeCrossings }
                : {}),
            }
          : {}),
      },
      {
        ...provenance,
        contentHash: railCorridorFactClaimContentHash({
          parcelNodeId,
          sourceTier: "ntad-narn",
          bufferMeters: entry.bufferMeters,
          nearRailCorridor: entry.nearRailCorridor,
          corridorStatus: entry.corridorStatus ?? null,
          corridorClass: entry.corridorClass ?? null,
          nearestCorridorDistanceMeters:
            entry.nearestCorridorDistanceMeters ?? null,
          atGradeCrossings: entry.atGradeCrossings ?? null,
        }),
      },
    );
  }

  return buildRailCorridorFactAbsenceAtom(
    {
      parcelNodeId,
      bufferMeters: entry.bufferMeters,
      absenceKind: entry.absenceKind,
      reason: entry.reason,
    },
    {
      ...provenance,
      contentHash: railCorridorFactClaimContentHash({
        parcelNodeId,
        sourceTier: "ntad-narn",
        bufferMeters: entry.bufferMeters,
        absenceKind: entry.absenceKind,
        absenceReason: entry.reason,
      }),
    },
  );
}

export function buildAtomsForRailCorridorPlan(
  plan: CountyRailCorridorPlan,
  provenance: RailCorridorCountyRunProvenance,
): ReadonlyArray<RailCorridorFactAtomInstance> {
  return plan.planned.map((entry) =>
    buildAtomForPlannedRailCorridor(entry, plan.countyFips, provenance),
  );
}

export function buildCountyRailCorridorCoverageAtom(
  countyFips: string,
  provenanceScope: ReadonlyArray<string>,
  provenance: RailCorridorCountyRunProvenance,
): RailCorridorFactAtomInstance {
  return buildCountyRailCorridorCoverageAbsenceAtom(
    { countyFips, provenanceScope },
    {
      ...provenance,
      contentHash: railCorridorFactClaimContentHash({
        parcelNodeId: `${countyFips}:_county_coverage`,
        sourceTier: "absent",
        bufferMeters: 0,
        verifiedAbsenceScope: provenanceScope,
      }),
    },
  );
}

export type StoredRailCorridorVerdict =
  | { ok: true }
  | { ok: false; parcelNodeId: string; problem: string };

export function verifyStoredRailCorridorFactAtom(
  stored: unknown,
  expected: {
    parcelNodeId: string;
    outcome: "present" | "absent";
    nearRailCorridor?: boolean;
  },
): StoredRailCorridorVerdict {
  const fail = (problem: string): StoredRailCorridorVerdict => ({
    ok: false,
    parcelNodeId: expected.parcelNodeId,
    problem,
  });

  const parsed = RAIL_CORRIDOR_FACT_SCHEMA.safeParse(stored);
  if (!parsed.success) {
    return fail(
      `stored bytes fail RAIL_CORRIDOR_FACT_SCHEMA: ${parsed.error.issues
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
  if (atom.accessPolicy !== "public-free") {
    return fail(`stored accessPolicy ${atom.accessPolicy} != public-free`);
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
    expected.nearRailCorridor !== undefined &&
    atom.nearRailCorridor !== expected.nearRailCorridor
  ) {
    return fail(
      `stored nearRailCorridor ${atom.nearRailCorridor} != expected ${expected.nearRailCorridor}`,
    );
  }
  return { ok: true };
}
