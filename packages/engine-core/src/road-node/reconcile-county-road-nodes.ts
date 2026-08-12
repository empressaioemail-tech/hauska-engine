/**
 * PBF-scoped orphan reconciliation for `road-node` county writer.
 *
 * Only rows minted by `road-intake-osm-geofabrik-pbf` may be retired when absent
 * from a new PBF plan. Warm-path adapters (Overpass, county roadway, surveyed,
 * CAD) are never retired by this reconcile.
 */

import { ROAD_PBF_SOURCE_ADAPTER } from "../road-intake/road-supersede.js";

import type { CountyRoadNodePlan } from "./plan-county-road-nodes.js";

export interface StoredRoadNodeRow {
  roadNodeId: string;
  sourceAdapter: string;
  status: "active" | "retired";
}

export interface RoadNodeOrphan {
  roadNodeId: string;
  sourceAdapter: string;
  reason: string;
}

export interface CountyRoadReconcilePlan {
  countyFips: string;
  priorActive: number;
  priorPbfActive: number;
  plannedIds: number;
  orphans: ReadonlyArray<RoadNodeOrphan>;
  counts: {
    orphans: number;
    skippedProtected: number;
  };
}

export function reconcileCountyRoadNodes(
  priorRows: ReadonlyArray<StoredRoadNodeRow>,
  plan: CountyRoadNodePlan,
): CountyRoadReconcilePlan {
  const plannedIds = new Set(plan.planned.map((p) => p.roadNodeId));
  const active = priorRows.filter((r) => r.status === "active");
  const orphans: RoadNodeOrphan[] = [];
  let skippedProtected = 0;

  for (const row of active) {
    if (plannedIds.has(row.roadNodeId)) continue;
    if (row.sourceAdapter !== ROAD_PBF_SOURCE_ADAPTER) {
      skippedProtected += 1;
      continue;
    }
    orphans.push({
      roadNodeId: row.roadNodeId,
      sourceAdapter: row.sourceAdapter,
      reason:
        `PBF-sourced road-node ${row.roadNodeId} is absent from the current ` +
        `Geofabrik plan for county ${plan.countyFips}; retiring stale PBF row`,
    });
  }

  return {
    countyFips: plan.countyFips,
    priorActive: active.length,
    priorPbfActive: active.filter((r) => r.sourceAdapter === ROAD_PBF_SOURCE_ADAPTER)
      .length,
    plannedIds: plannedIds.size,
    orphans,
    counts: {
      orphans: orphans.length,
      skippedProtected,
    },
  };
}

export type RoadOrphanRetirementVerdict =
  | { ok: true }
  | { ok: false; problem: string; stillActivePbfOrphans: ReadonlyArray<string> };

/**
 * Fail-closed: no active PBF rows remain outside the current plan after retire.
 */
export function assertNoActivePbfOrphans(
  reconcile: CountyRoadReconcilePlan,
  plannedRoadNodeIds: ReadonlySet<string>,
  remainingActive: ReadonlyArray<{ roadNodeId: string; sourceAdapter: string }>,
): RoadOrphanRetirementVerdict {
  const stillActive = remainingActive
    .filter(
      (r) =>
        r.sourceAdapter === ROAD_PBF_SOURCE_ADAPTER &&
        !plannedRoadNodeIds.has(r.roadNodeId),
    )
    .map((r) => r.roadNodeId);

  if (stillActive.length === 0) return { ok: true };
  return {
    ok: false,
    problem:
      `${stillActive.length} active PBF road-node row(s) for county ${reconcile.countyFips} ` +
      "were not retired after reconcile",
    stillActivePbfOrphans: stillActive.slice(0, 20),
  };
}
