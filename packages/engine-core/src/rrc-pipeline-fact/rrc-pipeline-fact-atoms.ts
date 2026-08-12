/**
 * Build + verify `rrc-pipeline-fact` atoms from a county plan.
 */

import {
  RRC_PIPELINE_FACT_SCHEMA,
  buildCountyRrcPipelineCoverageAbsenceAtom,
  buildPresentRrcPipelineFactAtom,
  buildRrcPipelineFactAbsenceAtom,
  rrcPipelineFactClaimContentHash,
  type RrcPipelineFactAtomInstance,
  type PropertyFactWriteProvenance,
} from "@hauska-engine/atoms";

import type {
  CountyRrcPipelinePlan,
  PlannedRrcPipeline,
} from "./plan-county-rrc-pipeline.js";

export type RrcPipelineCountyRunProvenance = Omit<
  PropertyFactWriteProvenance,
  "contentHash" | "observedAt"
> & { observedAt: string };

export function buildAtomForPlannedRrcPipeline(
  entry: PlannedRrcPipeline,
  countyFips: string,
  provenance: RrcPipelineCountyRunProvenance,
): RrcPipelineFactAtomInstance {
  const parcelNodeId = `${countyFips}:${entry.parcelKey}`;

  if (entry.outcome === "present") {
    return buildPresentRrcPipelineFactAtom(
      {
        parcelNodeId,
        bufferMeters: entry.bufferMeters,
        nearPipeline: entry.nearPipeline,
        ...(entry.nearPipeline
          ? {
              nearestPipelineDistanceMeters:
                entry.nearestPipelineDistanceMeters,
              ...(entry.t4permit ? { t4permit: entry.t4permit } : {}),
              ...(entry.p5Num ? { p5Num: entry.p5Num } : {}),
              ...(entry.operatorName
                ? { operatorName: entry.operatorName }
                : {}),
              ...(entry.systemName ? { systemName: entry.systemName } : {}),
              ...(entry.commodity ? { commodity: entry.commodity } : {}),
              ...(entry.commodityDescription
                ? { commodityDescription: entry.commodityDescription }
                : {}),
              ...(entry.systemType ? { systemType: entry.systemType } : {}),
              ...(entry.status ? { status: entry.status } : {}),
              ...(entry.diameter !== undefined
                ? { diameter: entry.diameter }
                : {}),
              ...(entry.interstate !== undefined
                ? { interstate: entry.interstate }
                : {}),
            }
          : {}),
      },
      {
        ...provenance,
        contentHash: rrcPipelineFactClaimContentHash({
          parcelNodeId,
          sourceTier: "rrc-public-gis",
          bufferMeters: entry.bufferMeters,
          nearPipeline: entry.nearPipeline,
          nearestPipelineDistanceMeters:
            entry.nearestPipelineDistanceMeters ?? null,
          t4permit: entry.t4permit ?? null,
          p5Num: entry.p5Num ?? null,
          operatorName: entry.operatorName ?? null,
          systemName: entry.systemName ?? null,
          commodity: entry.commodity ?? null,
          commodityDescription: entry.commodityDescription ?? null,
          systemType: entry.systemType ?? null,
          status: entry.status ?? null,
          diameter: entry.diameter ?? null,
          interstate: entry.interstate ?? null,
        }),
      },
    );
  }

  return buildRrcPipelineFactAbsenceAtom(
    {
      parcelNodeId,
      bufferMeters: entry.bufferMeters,
      absenceKind: entry.absenceKind,
      reason: entry.reason,
    },
    {
      ...provenance,
      contentHash: rrcPipelineFactClaimContentHash({
        parcelNodeId,
        sourceTier: "rrc-public-gis",
        bufferMeters: entry.bufferMeters,
        absenceKind: entry.absenceKind,
        absenceReason: entry.reason,
      }),
    },
  );
}

export function buildAtomsForRrcPipelinePlan(
  plan: CountyRrcPipelinePlan,
  provenance: RrcPipelineCountyRunProvenance,
): ReadonlyArray<RrcPipelineFactAtomInstance> {
  return plan.planned.map((entry) =>
    buildAtomForPlannedRrcPipeline(entry, plan.countyFips, provenance),
  );
}

export function buildCountyRrcPipelineCoverageAtom(
  countyFips: string,
  provenanceScope: ReadonlyArray<string>,
  provenance: RrcPipelineCountyRunProvenance,
): RrcPipelineFactAtomInstance {
  return buildCountyRrcPipelineCoverageAbsenceAtom(
    { countyFips, provenanceScope },
    {
      ...provenance,
      contentHash: rrcPipelineFactClaimContentHash({
        parcelNodeId: `${countyFips}:_county_coverage`,
        sourceTier: "absent",
        bufferMeters: 0,
        verifiedAbsenceScope: provenanceScope,
      }),
    },
  );
}

export type StoredRrcPipelineVerdict =
  | { ok: true }
  | { ok: false; parcelNodeId: string; problem: string };

export function verifyStoredRrcPipelineFactAtom(
  stored: unknown,
  expected: {
    parcelNodeId: string;
    outcome: "present" | "absent";
    nearPipeline?: boolean;
  },
): StoredRrcPipelineVerdict {
  const fail = (problem: string): StoredRrcPipelineVerdict => ({
    ok: false,
    parcelNodeId: expected.parcelNodeId,
    problem,
  });

  const parsed = RRC_PIPELINE_FACT_SCHEMA.safeParse(stored);
  if (!parsed.success) {
    return fail(
      `stored bytes fail RRC_PIPELINE_FACT_SCHEMA: ${parsed.error.issues
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
    expected.nearPipeline !== undefined &&
    atom.nearPipeline !== expected.nearPipeline
  ) {
    return fail(
      `stored nearPipeline ${atom.nearPipeline} != expected ${expected.nearPipeline}`,
    );
  }
  return { ok: true };
}
