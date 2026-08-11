/**
 * Build + verify `well-fact` atoms from a county plan.
 */

import {
  WELL_FACT_SCHEMA,
  buildCountyWellFactCoverageAbsenceAtom,
  buildPresentWellFactAtom,
  buildWellFactAbsenceAtom,
  wellFactClaimContentHash,
  type PropertyFactWriteProvenance,
  type WellFactAtomInstance,
} from "@hauska-engine/atoms";

import type {
  CountyWellFactPlan,
  PlannedWellFact,
} from "./plan-county-well-facts.js";
import { toContractWellStatus } from "./symnum.js";

export type WellCountyRunProvenance = Omit<
  PropertyFactWriteProvenance,
  "contentHash" | "observedAt"
> & { observedAt: string };

export function buildAtomForPlannedWellFact(
  entry: PlannedWellFact,
  countyFips: string,
  provenance: WellCountyRunProvenance,
  proximityRadiusMeters: number,
): WellFactAtomInstance {
  const parcelNodeId = `${countyFips}:${entry.parcelKey}`;

  if (entry.outcome === "present") {
    const wellStatus = toContractWellStatus(entry.wellStatus);
    return buildPresentWellFactAtom(
      {
        parcelNodeId,
        wellKey: entry.wellKey,
        apiNumber14: entry.apiNumber14,
        wellStatus,
        wellType: entry.wellType,
        orphaned: entry.orphaned,
        surfaceLocation: entry.surfaceLocation,
        parcelRelation: entry.parcelRelation,
        proximityRadiusMeters: entry.proximityRadiusMeters,
        proximityDistanceMeters: entry.proximityDistanceMeters,
      },
      {
        ...provenance,
        contentHash: wellFactClaimContentHash({
          parcelNodeId,
          wellKey: entry.wellKey,
          sourceTier: "texas-rrc-gis",
          apiNumber14: entry.apiNumber14,
          wellStatus,
          wellType: entry.wellType,
          parcelRelation: entry.parcelRelation,
        }),
      },
    );
  }

  return buildWellFactAbsenceAtom(
    {
      parcelNodeId,
      wellKey: "none",
      absenceKind: entry.absenceKind,
      reason: entry.reason,
      proximityRadiusMeters,
    },
    {
      ...provenance,
      contentHash: wellFactClaimContentHash({
        parcelNodeId,
        wellKey: "none",
        sourceTier: "texas-rrc-gis",
        absenceKind: entry.absenceKind,
        absenceReason: entry.reason,
      }),
    },
  );
}

export function buildAtomsForWellFactPlan(
  plan: CountyWellFactPlan,
  provenance: WellCountyRunProvenance,
): ReadonlyArray<WellFactAtomInstance> {
  return plan.planned.map((entry) =>
    buildAtomForPlannedWellFact(
      entry,
      plan.countyFips,
      provenance,
      plan.proximityRadiusMeters,
    ),
  );
}

export function buildCountyWellFactCoverageAtom(
  countyFips: string,
  provenanceScope: ReadonlyArray<string>,
  provenance: WellCountyRunProvenance,
): WellFactAtomInstance {
  return buildCountyWellFactCoverageAbsenceAtom(
    { countyFips, provenanceScope },
    {
      ...provenance,
      contentHash: wellFactClaimContentHash({
        parcelNodeId: `${countyFips}:_county_coverage`,
        wellKey: "_county_coverage",
        sourceTier: "absent",
        verifiedAbsenceScope: provenanceScope,
      }),
    },
  );
}

export type StoredWellFactVerdict =
  | { ok: true }
  | { ok: false; parcelNodeId: string; wellKey: string; problem: string };

export function verifyStoredWellFactAtom(
  stored: unknown,
  expected: {
    parcelNodeId: string;
    wellKey: string;
    outcome: "present" | "absent";
  },
): StoredWellFactVerdict {
  const fail = (problem: string): StoredWellFactVerdict => ({
    ok: false,
    parcelNodeId: expected.parcelNodeId,
    wellKey: expected.wellKey,
    problem,
  });

  const parsed = WELL_FACT_SCHEMA.safeParse(stored);
  if (!parsed.success) {
    return fail(
      `stored bytes fail WELL_FACT_SCHEMA: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const atom = parsed.data;
  if (atom.accessPolicy !== "public-free") {
    return fail(
      `stored accessPolicy ${atom.accessPolicy} != public-free`,
    );
  }
  if (atom.parcelNodeId !== expected.parcelNodeId) {
    return fail(
      `stored parcelNodeId ${atom.parcelNodeId} != expected ${expected.parcelNodeId}`,
    );
  }
  if (atom.wellKey !== expected.wellKey) {
    return fail(
      `stored wellKey ${atom.wellKey} != expected ${expected.wellKey}`,
    );
  }
  const storedOutcome = atom.absence ? "absent" : "present";
  if (storedOutcome !== expected.outcome) {
    return fail(
      `stored outcome ${storedOutcome} != planned ${expected.outcome}`,
    );
  }
  return { ok: true };
}
