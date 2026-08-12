/**
 * Build + verify `road-node` atoms from a county PBF plan.
 */

import {
  buildAtomDid,
  isRoadNodeAtomInstance,
  type RoadNodeAtomInstance,
} from "@hauska-engine/atoms";

import {
  emitRoadNode,
  roadIntakeDescriptorFromCountyRegistry,
  GEOFABRIK_TEXAS_PBF_URL,
} from "../road-intake/index.js";
import type { RoadIntakeDescriptor } from "../road-intake/types.js";

import type { CountyRoadNodePlan, PlannedRoadNode } from "./plan-county-road-nodes.js";

export interface RoadCountyRunProvenance {
  sourceAdapter: string;
  sourceCitation: string;
  sourceUrl: string;
  observedAt: string;
  jurisdictionTenant: string;
  verificationStatus: "machine";
  pinnedMd5?: string;
}

export function descriptorForCountyRoadRun(
  countyFips: string,
  countyName: string,
  pinnedMd5: string,
): RoadIntakeDescriptor {
  return roadIntakeDescriptorFromCountyRegistry(
    { countyFips, countyName },
    {
      sourceUrl: `${GEOFABRIK_TEXAS_PBF_URL}#md5=${pinnedMd5}`,
    },
  );
}

export function buildAtomForPlannedRoadNode(
  entry: PlannedRoadNode,
  descriptor: RoadIntakeDescriptor,
): RoadNodeAtomInstance {
  return emitRoadNode(descriptor, entry.observation);
}

export function buildAtomsForPlan(
  plan: CountyRoadNodePlan,
  descriptor: RoadIntakeDescriptor,
): ReadonlyArray<RoadNodeAtomInstance> {
  return plan.planned.map((entry) => buildAtomForPlannedRoadNode(entry, descriptor));
}

export type StoredRoadNodeVerdict =
  | { ok: true }
  | { ok: false; roadNodeId: string; problem: string };

/**
 * Write-then-verify helper — validates stored bytes against road-node contract.
 * Lookup MUST use atom_did PK; never body->>'atomDid'.
 */
export function verifyStoredRoadNodeAtom(
  stored: unknown,
  expected: { roadNodeId: string; entityId: string; atomDid: string },
): StoredRoadNodeVerdict {
  const fail = (problem: string): StoredRoadNodeVerdict => ({
    ok: false,
    roadNodeId: expected.roadNodeId,
    problem,
  });

  if (!isRoadNodeAtomInstance(stored)) {
    return fail("stored bytes fail road-node instance guard (isRoadNodeAtomInstance)");
  }

  const atom = stored;
  if (atom.roadNodeId !== expected.roadNodeId) {
    return fail(
      `stored roadNodeId ${atom.roadNodeId} != expected ${expected.roadNodeId}`,
    );
  }
  if (atom.entityId !== expected.entityId) {
    return fail(`stored entityId ${atom.entityId} != expected ${expected.entityId}`);
  }
  const expectedDid =
    expected.atomDid ||
    buildAtomDid("road-node", expected.entityId).raw;
  if (atom.atomDid !== expectedDid) {
    return fail(`stored atomDid ${atom.atomDid} != expected ${expectedDid}`);
  }
  if (atom.status !== "active") {
    return fail(`stored status ${atom.status ?? "undefined"} != active`);
  }
  if (!atom.centerline?.coordinates?.length) {
    return fail("stored road-node missing centerline coordinates");
  }
  return { ok: true };
}
