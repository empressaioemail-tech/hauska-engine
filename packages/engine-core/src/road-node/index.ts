/**
 * Rail roads `road-node` county writer module.
 *
 * CLI: scripts/write-road-node-county.mjs
 */

export {
  isPositiveLegacySyntheticBand,
  planCountyRoadNodes,
  type CountyRoadNodePlan,
  type PlannedRoadNode,
  type RoadNodeCollisionCandidate,
  type RoadWayPlanInput,
  type StoredRoadNodePriorRow,
} from "./plan-county-road-nodes.js";

export {
  assertNoActivePbfOrphans,
  reconcileCountyRoadNodes,
  type CountyRoadReconcilePlan,
  type RoadNodeOrphan,
  type RoadOrphanRetirementVerdict,
  type StoredRoadNodeRow,
} from "./reconcile-county-road-nodes.js";

export {
  buildAtomForPlannedRoadNode,
  buildAtomsForPlan,
  descriptorForCountyRoadRun,
  verifyStoredRoadNodeAtom,
  type RoadCountyRunProvenance,
  type StoredRoadNodeVerdict,
} from "./road-node-atoms.js";
