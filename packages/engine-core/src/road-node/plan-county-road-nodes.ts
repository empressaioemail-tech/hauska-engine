/**
 * `road-node` county planner — pure plan from PBF-extracted OSM ways.
 *
 * Entity id is `{countyFips}:road:{osmWayId}` (roadNodeId alone; not parcel-keyed).
 * Same ruling as road-intake `emitRoadNode` / @empressaio/atom-contract road-node.
 */

import { roadNodeIdFromParts } from "@hauska-engine/atoms";

import { isCaldwellCadSyntheticWayId } from "../road-intake/classify-caldwell-cad.js";
import {
  isCountyRoadwaySyntheticWayId,
  isLegacyCountySyntheticWayId,
} from "../road-intake/classify-county-street.js";
import type { OsmRoadObservation } from "../road-intake/types.js";

export interface RoadWayPlanInput {
  osmWayId: number;
  observation: OsmRoadObservation;
}

export interface PlannedRoadNode {
  osmWayId: number;
  roadNodeId: string;
  observation: OsmRoadObservation;
}

export interface RoadNodeCollisionCandidate {
  roadNodeId: string;
  osmWayId: number;
  reason: string;
  priorSourceAdapter?: string;
}

export interface CountyRoadNodePlan {
  countyFips: string;
  waysRead: number;
  planned: ReadonlyArray<PlannedRoadNode>;
  collisionCandidates: ReadonlyArray<RoadNodeCollisionCandidate>;
  counts: {
    planned: number;
    skippedDuplicateWay: number;
    positiveLegacyBand: number;
    priorAdapterCollision: number;
  };
}

export interface StoredRoadNodePriorRow {
  roadNodeId: string;
  osmWayId: number;
  sourceAdapter: string;
  status: "active" | "retired";
}

/** Positive OSM id bands that overlap legacy Bastrop synthetic minting (F5 H4). */
export function isPositiveLegacySyntheticBand(osmWayId: number): boolean {
  return (
    isLegacyCountySyntheticWayId(osmWayId) ||
    isCountyRoadwaySyntheticWayId(osmWayId) ||
    isCaldwellCadSyntheticWayId(osmWayId)
  );
}

/**
 * Build the county atom plan from parsed OSM observations (post-taxonomy filter).
 * Dedupes on osmWayId within the county scope.
 */
export function planCountyRoadNodes(
  ways: ReadonlyArray<RoadWayPlanInput>,
  opts: { countyFips: string },
  priorRows: ReadonlyArray<StoredRoadNodePriorRow> = [],
): CountyRoadNodePlan {
  const seen = new Set<number>();
  const planned: PlannedRoadNode[] = [];
  const collisionCandidates: RoadNodeCollisionCandidate[] = [];
  let skippedDuplicateWay = 0;
  let positiveLegacyBand = 0;
  let priorAdapterCollision = 0;

  const priorById = new Map<string, StoredRoadNodePriorRow>();
  for (const row of priorRows) {
    if (row.status !== "active") continue;
    priorById.set(row.roadNodeId, row);
  }

  for (const way of ways) {
    if (seen.has(way.osmWayId)) {
      skippedDuplicateWay += 1;
      continue;
    }
    seen.add(way.osmWayId);

    const roadNodeId = roadNodeIdFromParts(opts.countyFips, way.osmWayId);
    planned.push({
      osmWayId: way.osmWayId,
      roadNodeId,
      observation: way.observation,
    });

    if (isPositiveLegacySyntheticBand(way.osmWayId)) {
      positiveLegacyBand += 1;
      collisionCandidates.push({
        roadNodeId,
        osmWayId: way.osmWayId,
        reason:
          `osmWayId ${way.osmWayId} falls in a positive legacy synthetic band ` +
          `(800M/900M/700M) that collides with pre-F5 warm-path rows until migration`,
      });
    }

    const prior = priorById.get(roadNodeId);
    if (prior && prior.sourceAdapter !== "road-intake-osm-geofabrik-pbf") {
      priorAdapterCollision += 1;
      collisionCandidates.push({
        roadNodeId,
        osmWayId: way.osmWayId,
        reason:
          `active prior row at ${roadNodeId} from protected/non-PBF adapter ` +
          `${prior.sourceAdapter} — PBF cannot claim this id without migration`,
        priorSourceAdapter: prior.sourceAdapter,
      });
    }
  }

  return {
    countyFips: opts.countyFips,
    waysRead: ways.length,
    planned,
    collisionCandidates,
    counts: {
      planned: planned.length,
      skippedDuplicateWay,
      positiveLegacyBand,
      priorAdapterCollision,
    },
  };
}
