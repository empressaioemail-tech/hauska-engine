/**
 * Road-node re-ingest supersede contract (F5 H5) — storage-layer copy.
 * Keep in sync with engine-core/src/road-intake/road-supersede.ts.
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

export interface WriteRoadAtomsBatchOptions {
  force?: boolean;
}

export interface RoadSupersedeBatchStats {
  inserted: number;
  upserted: number;
  skippedProtected: number;
  supersededRetired: number;
}

export interface ExistingRoadRow {
  atomDid: string;
  sourceAdapter: string;
  versionStamp?: string;
  status?: string;
  body: RoadNodeAtomInstance;
}

export function decideRoadSupersede(
  incoming: Pick<RoadNodeAtomInstance, "sourceAdapter" | "versionStamp">,
  existing: ExistingRoadRow | null,
  opts?: WriteRoadAtomsBatchOptions,
): "insert" | "upsert" | "skip-protected" | "supersede-retire" {
  if (!existing || existing.status === "retired") return "insert";
  if (opts?.force) return "upsert";
  if (existing.sourceAdapter === incoming.sourceAdapter) return "upsert";
  if (
    incoming.sourceAdapter === ROAD_PBF_SOURCE_ADAPTER &&
    ROAD_ADAPTERS_PROTECTED_FROM_PBF.has(existing.sourceAdapter)
  ) {
    return "skip-protected";
  }
  if (
    incoming.versionStamp &&
    existing.versionStamp &&
    incoming.versionStamp !== existing.versionStamp
  ) {
    return "supersede-retire";
  }
  return "skip-protected";
}

export function retireRoadNodeInstance(
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
