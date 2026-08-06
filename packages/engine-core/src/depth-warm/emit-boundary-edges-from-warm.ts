/**
 * WS1 Option A — emit property-boundary-edge atoms from a verify-pass warm
 * candidate (labels + ring tessellation). Supersedes stale stored primitives
 * at promote time so serve path reads the same edges cert graded.
 */

import {
  boundaryEdgeIdFromParts,
  buildAtomDid,
  roadNodeIdFromParts,
  type BoundaryEdgeAtomInstance,
  type BoundaryResolvedSetback,
} from "@hauska-engine/atoms";

import { computeParcelInteriorFacts } from "../boundary-primitive/interior.js";
import { computePropertyLineTagsFromLocalEnuEndpoints } from "../geometry/gis-property-line-tags.js";
import {
  buildPropertyReadContract,
  contentHashExcludingProvenance,
  propertyNotApplicableConsequence,
  widthedFromMatchBasis,
} from "../property-reasoning/confidence.js";
import type { JurisdictionDescriptor } from "../property-reasoning/types.js";
import type { WarmCandidate, WarmEdgeInfo, WarmRoadSource } from "./types.js";
import {
  DEPTH_WARM_PROMOTION_MARKER,
  DEPTH_WARM_SOURCE_CITATION,
} from "./types.js";

function parseParcelNodeId(parcelNodeId: string): { countyFips: string; propId: string } | null {
  const [countyFips, propId] = parcelNodeId.split(":");
  if (!countyFips || !propId) return null;
  return { countyFips, propId };
}

function adjacencyKindForWarmEdge(edge: WarmEdgeInfo | undefined): BoundaryEdgeAtomInstance["adjacencyKind"] {
  if (!edge?.roadClass) return "unmapped";
  if (edge.roadClass === "alley") return "alley";
  return "ROW";
}

function facingRoadFromWarmEdge(
  edge: WarmEdgeInfo,
  roads: ReadonlyArray<WarmRoadSource>,
  countyFips: string,
): BoundaryEdgeAtomInstance["facingRoad"] {
  if (!edge.roadClass) return null;
  const matched =
    (typeof edge.osmHighwayTag === "string"
      ? roads.find((r) => r.osmWayId && r.classification === edge.roadClass)
      : undefined) ??
    roads.find((r) => r.classification === edge.roadClass);
  if (!matched) return null;
  return {
    roadNodeId: roadNodeIdFromParts(countyFips, matched.osmWayId),
    classification: matched.classification,
    provenance: "osm-overpass-v1",
    osmHighwayTag: matched.osmHighwayTag,
  };
}

function setbackFromWarmInset(insetFeet: number): BoundaryResolvedSetback {
  return {
    feet: insetFeet,
    provenance: "depth-warm-promote",
    atomCitation: DEPTH_WARM_SOURCE_CITATION,
  };
}

/** One property-boundary-edge atom per warm-ring edge index. */
export function emitBoundaryEdgesFromWarmCandidate(input: {
  candidate: WarmCandidate;
  descriptor: JurisdictionDescriptor;
  extractedAt: string;
}): BoundaryEdgeAtomInstance[] {
  const { candidate, descriptor, extractedAt } = input;
  const ids = parseParcelNodeId(candidate.parcelNodeId);
  if (!ids) return [];

  const interiorFacts = computeParcelInteriorFacts(candidate.parcelRing);
  if (!interiorFacts) return [];

  const edgeByIndex = new Map(candidate.edges.map((e) => [e.index, e]));
  const asserted = widthedFromMatchBasis("prefix");
  const accessPolicy = descriptor.defaultAccessPolicy ?? "public-free";
  // One versionStamp per promote batch — shared by every edge atom emitted
  // in this call, so persist.ts can retire every OTHER generation's edges
  // by versionStamp mismatch regardless of edgeIndex (FIX 2, D2 audit).
  const versionStamp = `${candidate.parcelNodeId}:property-boundary-edge:${extractedAt}`;

  const atoms: BoundaryEdgeAtomInstance[] = [];
  for (const edgeInterior of interiorFacts.edges) {
    const i = edgeInterior.edgeIndex;
    const warmEdge = edgeByIndex.get(i);
    const role = warmEdge?.label ?? "side";
    const insetFeet =
      warmEdge?.insetFeet ??
      candidate.insetFeetPerEdge[i] ??
      0;

    const boundaryEdgeId = boundaryEdgeIdFromParts(ids.countyFips, ids.propId, i);
    const atomDid = buildAtomDid("property-boundary-edge", boundaryEdgeId).raw;

    const propertyLineTags = computePropertyLineTagsFromLocalEnuEndpoints(
      edgeInterior.edgeEndpoints[0],
      edgeInterior.edgeEndpoints[1],
    );

    const instance: BoundaryEdgeAtomInstance = {
      entityType: "property-boundary-edge",
      atomDid,
      boundaryEdgeId,
      entityId: boundaryEdgeId,
      parcelNodeId: candidate.parcelNodeId,
      countyFips: ids.countyFips,
      propId: ids.propId,
      edgeIndex: i,
      role,
      adjacencyKind: adjacencyKindForWarmEdge(warmEdge),
      parcelNeighborPropId: null,
      facingRoad: warmEdge ? facingRoadFromWarmEdge(warmEdge, candidate.roads, ids.countyFips) : null,
      setback: setbackFromWarmInset(insetFeet),
      interior: {
        ringCcw: edgeInterior.ringCcw,
        centroidInside: edgeInterior.centroidInside,
        inwardNormal: edgeInterior.inwardNormal,
        edgeEndpoints: edgeInterior.edgeEndpoints,
      },
      propertyLineTags,
      effectiveDate: extractedAt.slice(0, 10),
      status: "active",
      supersedesEntityId: null,
      reasoningChain: { reasoningKind: "observed" },
      accessPolicy,
      sourceCitation: `${DEPTH_WARM_SOURCE_CITATION} (${DEPTH_WARM_PROMOTION_MARKER})`,
      extractedAt,
      atomTier: "data",
      jurisdictionTenant: descriptor.jurisdictionTenant,
      fetchedAt: extractedAt,
      sourceAdapter: "depth-warm-verify-promote",
      sourceUrl: "https://hauska.dev/internal/depth-warm/promote",
      versionStamp,
      contentHash: "",
      readContract: buildPropertyReadContract({
        asserted,
        consequence: propertyNotApplicableConsequence(
          "property-boundary-edge-v1-no-life-safety-stratum",
          extractedAt,
        ),
        assembledAt: extractedAt,
      }),
    };
    instance.contentHash = contentHashExcludingProvenance(instance);
    atoms.push(instance);
  }

  return atoms;
}
