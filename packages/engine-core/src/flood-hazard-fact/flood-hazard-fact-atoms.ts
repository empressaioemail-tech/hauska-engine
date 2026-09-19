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
  ContainmentState,
  SamplePointDerivation,
} from "./containment.js";
import type { LngLat } from "./geo.js";
import type {
  CountyFloodHazardPlan,
  PlannedFloodHazard,
} from "./plan-county-flood-hazard.js";

/**
 * The SAMPLING CONTRACT, stamped onto every emitted atom.
 *
 * SS-W11 had to borrow tier2's recorded centroid in order to adjudicate this
 * atom, because the atom did not record the point it evaluated. That made the
 * adjudication depend on the very store being retired. These three fields close
 * it: the standing check reads the point the writer actually used instead of
 * re-deriving a stand-in and hoping the two agree.
 *
 * They ride ALONGSIDE the contract atom rather than inside it. The published
 * FLOOD_HAZARD_FACT_SCHEMA is a strip-mode zod object, so a field passed into
 * createFloodHazardFact would be silently dropped; spreading it after the parse
 * is the same mechanism EnginePropertyPersistence already uses, and a live body
 * read back from `atoms` confirms those fields do persist. A first-class
 * contract field is the durable fix and is owed to hauska-atom-contract.
 */
export interface FloodSamplingProvenance {
  samplePoint: LngLat | null;
  samplePointDerivation: SamplePointDerivation;
  samplePointContainment: ContainmentState;
}

export type FloodHazardFactAtomWithSampling = FloodHazardFactAtomInstance &
  FloodSamplingProvenance;

export type FloodCountyRunProvenance = Omit<
  PropertyFactWriteProvenance,
  "contentHash" | "observedAt"
> & { observedAt: string };

export function buildAtomForPlannedFloodHazard(
  entry: PlannedFloodHazard,
  countyFips: string,
  provenance: FloodCountyRunProvenance,
): FloodHazardFactAtomWithSampling {
  const parcelNodeId = `${countyFips}:${entry.parcelKey}`;

  // FAIL CLOSED at the last possible moment.
  //
  // TypeScript proves this branch unreachable: `PlannedFloodHazard` stamps
  // `EmittableContainmentState`, which excludes `not-contained`, so a typed
  // caller cannot get here. The cast is deliberate and the guard stays, because
  // the ONE production caller is `write-flood-hazard-fact-county.mjs`, a `.mjs`
  // script that TypeScript never checks. The type covers every typed consumer;
  // this covers the untyped one.
  if ((entry.samplePointContainment as ContainmentState) === "not-contained") {
    throw new Error(
      `flood-hazard-fact REFUSED: ${parcelNodeId} sample point falls outside the parcel it answers for; a not-contained determination must never be built into an atom`,
    );
  }

  const sampling: FloodSamplingProvenance = {
    samplePoint: entry.samplePoint,
    samplePointDerivation: entry.samplePointDerivation,
    samplePointContainment: entry.samplePointContainment,
  };

  if (entry.outcome === "present") {
    return {
      ...buildPresentFloodHazardFactAtom(
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
      ),
      ...sampling,
    };
  }

  return {
    ...buildFloodHazardFactAbsenceAtom(
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
    ),
    ...sampling,
  };
}

/**
 * Atoms are built from `plan.planned` ONLY.
 *
 * `plan.refused` is a separate array by design: a refusal cannot become an atom
 * by omission, by oversight, or by a future edit to this function, because it
 * is not in the collection this function iterates.
 */
export function buildAtomsForFloodHazardPlan(
  plan: CountyFloodHazardPlan,
  provenance: FloodCountyRunProvenance,
): ReadonlyArray<FloodHazardFactAtomWithSampling> {
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
  expected: {
    parcelNodeId: string;
    outcome: "present" | "absent";
    samplePoint?: LngLat | null;
    samplePointContainment?: ContainmentState;
  },
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

  // The sampling stamp is verified against the STORED BYTES, never against the
  // in-memory atom. A verify that re-reads the object it has just built cannot
  // fail and is therefore not a verify — the special-district writer's verify
  // is exactly that shape and its verifyFailures can never be non-zero.
  const raw = stored as Record<string, unknown>;
  const storedContainment = raw.samplePointContainment;
  if (storedContainment === "not-contained") {
    return fail(
      "stored atom carries samplePointContainment=not-contained: a determination made outside the parcel reached the store",
    );
  }
  if (typeof storedContainment !== "string") {
    return fail(
      "stored atom carries no samplePointContainment: it was written by a writer with no containment gate",
    );
  }
  if (
    expected.samplePointContainment != null &&
    storedContainment !== expected.samplePointContainment
  ) {
    return fail(
      `stored samplePointContainment ${storedContainment} != planned ${expected.samplePointContainment}`,
    );
  }
  if (expected.samplePoint !== undefined) {
    const sp = raw.samplePoint as unknown;
    const want = expected.samplePoint;
    const same =
      want == null
        ? sp == null
        : Array.isArray(sp) &&
          Number(sp[0]) === want[0] &&
          Number(sp[1]) === want[1];
    if (!same) {
      return fail(
        `stored samplePoint ${JSON.stringify(sp)} != planned ${JSON.stringify(want)}`,
      );
    }
  }

  return { ok: true };
}
