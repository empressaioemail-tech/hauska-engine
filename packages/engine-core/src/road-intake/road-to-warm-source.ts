/**
 * Convert persisted road-node atoms → depth-warm WarmRoadSource (S2-U1 shared loader).
 */

import type { RoadClassification } from "@hauska-engine/atoms";

import type { WarmRoadSource, WarmRoadProvenanceKind } from "../depth-warm/types.js";
import { classifyOsmHighwayTag } from "./classify.js";

export interface RoadAtomBody {
  osmWayId?: number;
  displayName?: string;
  classification?: RoadClassification;
  centerline?: { coordinates?: ReadonlyArray<readonly [number, number]> };
  row?: {
    provenance?: {
      kind?: string;
      osmHighwayTag?: string;
      surface?: string;
      countySegmentObjectId?: number;
    };
  };
}

function provenanceKind(body: RoadAtomBody): WarmRoadProvenanceKind {
  const kind = body.row?.provenance?.kind;
  if (kind === "county-roadway-authoritative") return "county-roadway-authoritative";
  if (kind === "county-surveyed-2016") return "county-surveyed-2016";
  return "osm-fallback";
}

function isCountyAuthoritative(provKind: WarmRoadProvenanceKind): boolean {
  return provKind === "county-roadway-authoritative" || provKind === "county-surveyed-2016";
}

export function roadAtomToWarmSource(body: RoadAtomBody): WarmRoadSource | null {
  const centerline = body.centerline?.coordinates;
  if (!Array.isArray(centerline) || centerline.length < 2) return null;
  if (typeof body.osmWayId !== "number") return null;

  const rawKind = body.row?.provenance?.kind;
  // Undefined county roadway geometry must not enter labeling pool — OSM stays best-available.
  if (rawKind === "county-roadway-undefined") return null;

  const provKind = provenanceKind(body);
  const osmHighwayTag =
    body.row?.provenance?.kind === "approximate-assumed-per-class"
      ? (body.row.provenance.osmHighwayTag ?? "unclassified")
      : provKind === "county-roadway-authoritative"
        ? "county-roadway"
        : "county-surveyed";
  const surface =
    body.row?.provenance?.kind === "approximate-assumed-per-class"
      ? body.row.provenance.surface
      : body.row?.provenance?.kind === "county-roadway-authoritative" ||
          body.row?.provenance?.kind === "county-surveyed-2016"
        ? (body.row.provenance as { countySurface?: string }).countySurface
        : undefined;
  const classification = body.classification;
  if (!classification) return null;

  if (!isCountyAuthoritative(provKind)) {
    const tags = surface ? { surface } : undefined;
    const derived = classifyOsmHighwayTag(osmHighwayTag, tags);
    if (derived !== classification) return null;
  }

  return {
    osmWayId: body.osmWayId,
    osmHighwayTag,
    surface,
    name: body.displayName,
    classification,
    polyline: centerline.map(([lng, lat]) => [lng, lat] as [number, number]),
    provenanceKind: provKind,
    countySegmentObjectId: body.row?.provenance?.countySegmentObjectId,
  };
}
