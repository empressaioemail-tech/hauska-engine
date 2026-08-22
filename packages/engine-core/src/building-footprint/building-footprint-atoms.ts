/**
 * Build + verify `building-footprint` atoms from a county plan.
 */

import {
  BUILDING_FOOTPRINT_SCHEMA,
  buildBuildingFootprintPerParcelAbsenceAtom,
  buildCountyBuildingFootprintCoverageAbsenceAtom,
  buildPresentBuildingFootprintAtom,
  buildingFootprintClaimContentHash,
  type BuildingFootprintAtomInstance,
  type PropertyFactWriteProvenance,
} from "@hauska-engine/atoms";

import { ringToFootprintGeometry } from "./geo.js";
import type {
  CountyBuildingFootprintPlan,
  PlannedBuildingFootprint,
} from "./types.js";

export type FootprintCountyRunProvenance = Omit<
  PropertyFactWriteProvenance,
  "contentHash" | "observedAt"
> & { observedAt: string };

export function buildAtomForPlannedBuildingFootprint(
  entry: PlannedBuildingFootprint,
  countyFips: string,
  provenance: FootprintCountyRunProvenance,
): BuildingFootprintAtomInstance {
  if (entry.outcome === "county-coverage-absent") {
    return buildCountyBuildingFootprintCoverageAbsenceAtom(
      {
        countyFips,
        provenanceScope: entry.provenanceScope,
      },
      {
        ...provenance,
        contentHash: buildingFootprintClaimContentHash({
          parcelNodeId: `${countyFips}:_county_coverage`,
          footprintId: "county-coverage",
          sourceTier: "absent",
          verifiedAbsenceScope: entry.provenanceScope,
        }),
      },
    );
  }

  const parcelNodeId = `${countyFips}:${entry.parcelKey}`;

  if (entry.outcome === "present") {
    return buildPresentBuildingFootprintAtom(
      {
        parcelNodeId,
        footprintId: entry.footprintId,
        footprintGeometry: ringToFootprintGeometry(entry.ring),
        sourceTier: "ml-derived",
        structureRole: entry.structureRole,
        confidence: entry.flag === "straddle-review" ? 0.5 : 0.75,
        verificationStatus: "unsurveyed",
      },
      {
        ...provenance,
        contentHash: buildingFootprintClaimContentHash({
          parcelNodeId,
          footprintId: entry.footprintId,
          sourceTier: "ml-derived",
          mlFeatureId: entry.mlFeatureId,
          structureRole: entry.structureRole,
        }),
      },
    );
  }

  return buildBuildingFootprintPerParcelAbsenceAtom(
    {
      parcelNodeId,
      absenceKind: entry.absenceKind,
      reason: entry.reason,
      sourceTier: "ml-derived",
    },
    {
      ...provenance,
      contentHash: buildingFootprintClaimContentHash({
        parcelNodeId,
        footprintId: "none",
        sourceTier: "ml-derived",
        absenceKind: entry.absenceKind,
        absenceReason: entry.reason,
      }),
    },
  );
}

export function buildAtomsForBuildingFootprintPlan(
  plan: CountyBuildingFootprintPlan,
  provenance: FootprintCountyRunProvenance,
): ReadonlyArray<BuildingFootprintAtomInstance> {
  return plan.planned.map((entry) =>
    buildAtomForPlannedBuildingFootprint(entry, plan.countyFips, provenance),
  );
}

export type StoredBuildingFootprintVerdict =
  | { ok: true }
  | {
      ok: false;
      parcelNodeId: string;
      footprintId: string;
      problem: string;
    };

export function verifyStoredBuildingFootprintAtom(
  stored: unknown,
  expected: {
    parcelNodeId: string;
    footprintId: string;
    outcome: "present" | "absent";
  },
): StoredBuildingFootprintVerdict {
  const fail = (problem: string): StoredBuildingFootprintVerdict => ({
    ok: false,
    parcelNodeId: expected.parcelNodeId,
    footprintId: expected.footprintId,
    problem,
  });

  const parsed = BUILDING_FOOTPRINT_SCHEMA.safeParse(stored);
  if (!parsed.success) {
    return fail(
      `stored bytes fail BUILDING_FOOTPRINT_SCHEMA: ${parsed.error.issues
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
  if (atom.footprintId !== expected.footprintId) {
    return fail(
      `stored footprintId ${atom.footprintId} != expected ${expected.footprintId}`,
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

  if (storedOutcome === "present" && !atom.footprintGeometry) {
    return fail("present footprint atom missing footprintGeometry");
  }

  return { ok: true };
}
