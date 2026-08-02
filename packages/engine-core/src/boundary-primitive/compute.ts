/**
 * Boundary edge atom compute (S2-U2): adjacency + road labeling + setback + temporal.
 */

import {
  boundaryEdgeIdFromParts,
  type BoundaryAdjacencyKind,
  type BoundaryEdgeAtomInstance,
  type BoundaryResolvedSetback,
  type BoundarySetbackAbsence,
  type RoadClassification,
} from "@hauska-engine/atoms";
import { buildAtomDid, roadNodeIdFromParts } from "@hauska-engine/atoms";

import { labelEdgesFromRoads } from "../depth-warm/edgeLabeling.js";
import type { Ring } from "../depth-warm/geometry.js";
import type { WarmRoadSource } from "../depth-warm/types.js";
import { classifyOsmHighwayTag } from "../road-intake/classify.js";
import {
  buildPropertyReadContract,
  contentHashExcludingTimestamps,
  propertyNotApplicableConsequence,
  widthedFromMatchBasis,
} from "../property-reasoning/confidence.js";
import { resolveDistrictEdgeSetback } from "../property-reasoning/resolve-road-class-setback.js";
import type { JurisdictionDescriptor, RoadEdgeRole } from "../property-reasoning/types.js";
import { computePropertyLineTagsFromLocalEnuEndpoints } from "../geometry/gis-property-line-tags.js";
import { getParcelEdgeNeighbors } from "./adjacency-grid.js";
import type { ParcelAdjacencyIndex } from "./types.js";
import { computeParcelInteriorFacts } from "./interior.js";

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
    };
  };
}

/** Convert persisted road-node atom body → depth-warm road source for labeling. */
export function roadAtomBodyToWarmSource(body: RoadAtomBody): WarmRoadSource | null {
  const centerline = body.centerline?.coordinates;
  if (!Array.isArray(centerline) || centerline.length < 2) return null;
  if (typeof body.osmWayId !== "number") return null;
  const osmHighwayTag =
    body.row?.provenance?.kind === "approximate-assumed-per-class"
      ? (body.row.provenance.osmHighwayTag ?? "unclassified")
      : "unclassified";
  const surface = body.row?.provenance?.surface;
  const classification = body.classification;
  if (!classification) return null;
  const tags = surface ? { surface } : undefined;
  const derived = classifyOsmHighwayTag(osmHighwayTag, tags);
  if (derived !== classification) return null;
  return {
    osmWayId: body.osmWayId,
    osmHighwayTag,
    surface,
    name: body.displayName,
    classification,
    polyline: centerline.map(([lng, lat]) => [lng, lat] as [number, number]),
  };
}

export interface ComputeBoundaryEdgeAtomsInput {
  parcelNodeId: string;
  countyFips: string;
  propId: string;
  district: string;
  parcelRing: Ring;
  descriptor: JurisdictionDescriptor;
  adjacencyIndex: ParcelAdjacencyIndex;
  roads: ReadonlyArray<WarmRoadSource>;
  /**
   * Parcel situs address (e.g. "901 PECAN ST") from tier-1 parcel data.
   * Optional: counties without situs data degrade to the adjacency heuristic.
   */
  situsAddress?: string | null;
  effectiveDate: string;
  extractedAt: string;
  sourceAdapter: string;
  sourceUrl: string;
  accessPolicy?: BoundaryEdgeAtomInstance["accessPolicy"];
}

function warmRoleToRoadRole(label: string): RoadEdgeRole {
  if (label === "side_corner") return "side_corner";
  return label as RoadEdgeRole;
}

function resolveSetbackForEdge(
  descriptor: JurisdictionDescriptor,
  district: string,
  role: RoadEdgeRole,
  adjacencyKind: BoundaryAdjacencyKind,
  _roadClass: RoadClassification | undefined,
  roleIsKnown: boolean,
): BoundaryResolvedSetback | BoundarySetbackAbsence {
  // R7: an edge with a KNOWN district and KNOWN role (front/side/rear/side_corner)
  // resolves to that district's setback for that role even when adjacency is
  // unmapped — only genuinely role-unknowable edges (labelEdgesFromRoads declined
  // entirely, so `role` is a hardcoded fallback, not a resolved fact) still decline.
  // This closes the primitive-bake gap so parcels that skip re-warm aren't stranded
  // with null envelopes when the district/role are already known.
  if (adjacencyKind === "unmapped" && !roleIsKnown) {
    return {
      kind: "unmapped-adjacency",
      reason: "No parcel or ROW adjacency mapped for this edge, and edge role is unresolved.",
    };
  }

  // WDLL 7 / RULING 2: NUMBER from flat district table by edge ROLE.
  // Road class may identify ROW/alley adjacency and front EDGE; never the VALUE.
  const hit = resolveDistrictEdgeSetback(descriptor, district, role);
  if ("kind" in hit) {
    return { kind: "no-setback-row", reason: hit.reason };
  }
  return {
    feet: hit.value,
    provenance: "district-setback-table",
    atomCitation: descriptor.key,
  };
}

function adjacencyKindForEdge(
  neighborPropId: string | null,
  roadClass?: RoadClassification,
): BoundaryAdjacencyKind {
  if (roadClass === "alley") return "alley";
  if (roadClass) return "ROW";
  if (neighborPropId) return "neighbor-parcel";
  return "unmapped";
}

/** Emit one property-boundary-edge atom per ring edge. */
export function computeBoundaryEdgeAtoms(
  input: ComputeBoundaryEdgeAtomsInput,
): ReadonlyArray<BoundaryEdgeAtomInstance> {
  const interiorFacts = computeParcelInteriorFacts(input.parcelRing);
  if (!interiorFacts) return [];

  const neighbors = getParcelEdgeNeighbors(input.adjacencyIndex, input.parcelNodeId);
  if (!neighbors) return [];

  const labelResult = labelEdgesFromRoads({
    parcelRing: input.parcelRing,
    roads: input.roads,
    situsAddress: input.situsAddress ?? null,
  });
  const edgeLabels = labelResult.ok ? labelResult.edgeLabels : [];

  const labelByIndex = new Map(edgeLabels.map((e) => [e.index, e]));
  const asserted = widthedFromMatchBasis("prefix");
  const accessPolicy = input.accessPolicy ?? input.descriptor.defaultAccessPolicy;

  const atoms: BoundaryEdgeAtomInstance[] = [];
  for (const edgeInterior of interiorFacts.edges) {
    const i = edgeInterior.edgeIndex;
    const label = labelByIndex.get(i);
    const roleIsKnown = label != null;
    const role = label?.label ?? "side";
    const roadClass = label?.roadClass;
    const neighborPropId = neighbors[i] ?? null;
    const adjacencyKind = adjacencyKindForEdge(neighborPropId, roadClass);
    const setback = resolveSetbackForEdge(
      input.descriptor,
      input.district,
      warmRoleToRoadRole(role),
      adjacencyKind,
      roadClass,
      roleIsKnown,
    );

    const boundaryEdgeId = boundaryEdgeIdFromParts(
      input.countyFips,
      input.propId,
      i,
    );
    const entityId = boundaryEdgeId;
    const atomDid = buildAtomDid("property-boundary-edge", entityId).raw;

    let facingRoad: BoundaryEdgeAtomInstance["facingRoad"] = null;
    if (roadClass && label) {
      const matchedRoad =
        (typeof label.osmWayId === "number"
          ? input.roads.find((r) => r.osmWayId === label.osmWayId)
          : undefined) ??
        input.roads.find(
          (r) =>
            r.classification === roadClass &&
            (!label.osmHighwayTag || r.osmHighwayTag === label.osmHighwayTag),
        );
      if (matchedRoad) {
        facingRoad = {
          roadNodeId: roadNodeIdFromParts(input.countyFips, matchedRoad.osmWayId),
          classification: matchedRoad.classification,
          provenance: "osm-overpass-v1",
          osmHighwayTag: matchedRoad.osmHighwayTag,
        };
      }
    }

    const propertyLineTags = computePropertyLineTagsFromLocalEnuEndpoints(
      edgeInterior.edgeEndpoints[0],
      edgeInterior.edgeEndpoints[1],
    );

    const instance: BoundaryEdgeAtomInstance = {
      entityType: "property-boundary-edge",
      atomDid,
      boundaryEdgeId,
      entityId,
      parcelNodeId: input.parcelNodeId,
      countyFips: input.countyFips,
      propId: input.propId,
      edgeIndex: i,
      role,
      ...(role === "front" && label?.frontBasis
        ? { frontBasis: label.frontBasis }
        : {}),
      adjacencyKind,
      parcelNeighborPropId: neighborPropId,
      facingRoad,
      setback,
      interior: {
        ringCcw: edgeInterior.ringCcw,
        centroidInside: edgeInterior.centroidInside,
        inwardNormal: edgeInterior.inwardNormal,
        edgeEndpoints: edgeInterior.edgeEndpoints,
      },
      propertyLineTags,
      effectiveDate: input.effectiveDate,
      status: "active",
      supersedesEntityId: null,
      reasoningChain: { reasoningKind: "observed" },
      accessPolicy,
      sourceCitation: "boundary-primitive S2-U2 (PRE-2 adjacency + road-node attach)",
      extractedAt: input.extractedAt,
      atomTier: "data",
      jurisdictionTenant: input.descriptor.jurisdictionTenant,
      fetchedAt: input.extractedAt,
      sourceAdapter: input.sourceAdapter,
      sourceUrl: input.sourceUrl,
      contentHash: "",
      readContract: buildPropertyReadContract({
        asserted,
        consequence: propertyNotApplicableConsequence(
          "property-boundary-edge-v1-no-life-safety-stratum",
          input.extractedAt,
        ),
        assembledAt: input.extractedAt,
      }),
    };
    // A6: exclude provenance timestamps from the hash — content hash must be
    // rewarm-deterministic, not wall-clock-dependent.
    instance.contentHash = contentHashExcludingTimestamps(instance);
    atoms.push(instance);
  }

  return atoms;
}
