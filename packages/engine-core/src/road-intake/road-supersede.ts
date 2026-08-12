/**
 * Versioned retire-or-supersede contract for road-node re-ingest (F5 H5).
 */

import type { RoadNodeAtomInstance } from "@hauska-engine/atoms";

export const ROAD_PBF_SOURCE_ADAPTER = "road-intake-osm-geofabrik-pbf";

export const ROAD_ADAPTERS_PROTECTED_FROM_PBF: ReadonlySet<string> = new Set([
  "road-intake-osm-overpass",
  "road-intake-elgin-osm",
  "road-intake-bastrop-county-roadway",
  "road-intake-county-streets-surveyed-2016",
  "road-intake-caldwell-cad-centerlines",
]);

export interface RoadIngestSupersedeOptions {
  force?: boolean;
}

export interface RoadSupersedeDecision {
  action: "insert" | "upsert" | "skip-protected" | "supersede-retire";
  reason: string;
}

export interface ExistingRoadRow {
  atomDid: string;
  sourceAdapter: string;
  versionStamp?: string;
  status?: string;
}

export function decideRoadSupersede(
  incoming: Pick<RoadNodeAtomInstance, "sourceAdapter" | "versionStamp">,
  existing: ExistingRoadRow | null,
  opts?: RoadIngestSupersedeOptions,
): RoadSupersedeDecision {
  if (!existing || existing.status === "retired") {
    return { action: "insert", reason: "no-active-row" };
  }
  if (opts?.force) {
    return { action: "upsert", reason: "force-override" };
  }
  if (existing.sourceAdapter === incoming.sourceAdapter) {
    return { action: "upsert", reason: "same-adapter-re-ingest" };
  }
  if (
    incoming.sourceAdapter === ROAD_PBF_SOURCE_ADAPTER &&
    ROAD_ADAPTERS_PROTECTED_FROM_PBF.has(existing.sourceAdapter)
  ) {
    return {
      action: "skip-protected",
      reason: `protected-adapter:${existing.sourceAdapter}`,
    };
  }
  if (
    incoming.versionStamp &&
    existing.versionStamp &&
    incoming.versionStamp !== existing.versionStamp
  ) {
    return { action: "supersede-retire", reason: "versioned-cross-adapter" };
  }
  return { action: "skip-protected", reason: "cross-adapter-no-supersede" };
}

export function retireRoadNodeBody(
  body: RoadNodeAtomInstance,
  reason: string,
  retiredAt: string,
): RoadNodeAtomInstance {
  return {
    ...body,
    status: "retired",
    retiredAt,
    sourceCitation: `${body.sourceCitation} [retired: ${reason}]`,
  };
}
