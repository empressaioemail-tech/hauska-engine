/**
 * Mechanical verify agent (27c R3 WDLL 6).
 * Never second-agent re-assertion — geometry gate + classification-vs-source +
 * right-edge/right-distance checks only.
 */

import { classifyOsmHighwayTag } from "../road-intake/classify.js";
import {
  isNearRectangularParcelRing,
  nearRectEnvelopeCheck,
} from "../boundary-primitive/lot-line-scrub.js";
import { openRing, projectRing } from "./geometry.js";
import { isConvexPlanarRing } from "../geometry/polygon-inset.js";
import type { JurisdictionDescriptor } from "../property-reasoning/types.js";
import { geometryCorrectnessGate } from "./geometry.js";
import type { VerifyResult, WarmCandidate } from "./types.js";
import {
  buildFlatSetbackFallback,
  resolveInsetFeetForEdge,
} from "./warm-compute.js";

function classifyForVerify(
  osmHighwayTag: string | undefined,
  surface?: string,
): ReturnType<typeof classifyOsmHighwayTag> {
  return classifyOsmHighwayTag(
    osmHighwayTag,
    surface ? { surface } : undefined,
  );
}

/**
 * Gate: road classification on each edge must match OSM highway tag re-classified.
 */
export function verifyRoadClassificationMatchesSource(
  candidate: WarmCandidate,
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const edge of candidate.edges) {
    if (
      edge.roadProvenanceKind === "county-roadway-authoritative" ||
      edge.roadProvenanceKind === "county-surveyed-2016"
    )
      continue;
    if (!edge.roadClass || !edge.osmHighwayTag) continue;
    const fromTag = classifyForVerify(edge.osmHighwayTag, edge.osmSurfaceTag);
    if (fromTag !== edge.roadClass) {
      reasons.push(
        `edge ${edge.index}: classification ${edge.roadClass} != OSM tag ${edge.osmHighwayTag} (${fromTag})`,
      );
    }
  }
  for (const road of candidate.roads) {
    if (
      road.provenanceKind === "county-roadway-authoritative" ||
      road.provenanceKind === "county-surveyed-2016"
    )
      continue;
    const fromTag = classifyForVerify(road.osmHighwayTag, road.surface);
    if (fromTag !== road.classification) {
      reasons.push(
        `road ${road.osmWayId}: classification ${road.classification} != tag ${road.osmHighwayTag} (${fromTag})`,
      );
    }
  }
  return { pass: reasons.length === 0, reasons };
}

/**
 * Gate: applied inset feet on each edge match flat district table by edge ROLE
 * (WDLL 7 — road class must not invent a different NUMBER).
 */
export function verifySetbackEdgeDistance(
  candidate: WarmCandidate,
  descriptor: JurisdictionDescriptor,
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const tol = 0.01;
  const flatFallback = buildFlatSetbackFallback(descriptor, candidate.district);
  for (const edge of candidate.edges) {
    const expectedFt = resolveInsetFeetForEdge(
      descriptor,
      candidate.district,
      edge,
      flatFallback,
    );
    if (Math.abs(edge.insetFeet - expectedFt) > tol) {
      reasons.push(
        `edge ${edge.index}: inset ${edge.insetFeet}ft != expected ${expectedFt}ft for role ${edge.label} (roadClass=${edge.roadClass ?? "none"} ignored for value)`,
      );
    }
  }
  const applied = candidate.insetFeetPerEdge;
  for (const edge of candidate.edges) {
    const appliedFt = applied[edge.index];
    if (appliedFt === undefined) {
      reasons.push(`edge ${edge.index}: missing applied inset`);
      continue;
    }
    if (Math.abs(appliedFt - edge.insetFeet) > tol) {
      reasons.push(
        `edge ${edge.index}: applied ${appliedFt}ft != labeled ${edge.insetFeet}ft`,
      );
    }
  }
  return { pass: reasons.length === 0, reasons };
}

/**
 * Run all mechanical gates. Fail closed on any miss.
 */
export function verifyWarmCandidateMechanically(
  candidate: WarmCandidate,
  descriptor: JurisdictionDescriptor,
): VerifyResult {
  const geometry = geometryCorrectnessGate(
    candidate.parcelRing,
    candidate.empty ? null : candidate.insetRing,
    candidate.insetFeetPerEdge,
  );
  if (candidate.empty) {
    geometry.pass = false;
    geometry.reasons.push("warm candidate marked empty — cannot promote");
  } else if (
    candidate.insetRing &&
    isNearRectangularParcelRing(candidate.parcelRing)
  ) {
    const parcelVerts = openRing(candidate.parcelRing).length;
    const rectCheck = nearRectEnvelopeCheck(
      candidate.parcelRing,
      candidate.insetRing,
      parcelVerts + 1,
    );
    if (!rectCheck.pass) {
      geometry.pass = false;
      geometry.reasons.push(...rectCheck.reasons);
    }
    const insetFrame = projectRing(candidate.insetRing);
    if (insetFrame && !isConvexPlanarRing(insetFrame.points)) {
      geometry.pass = false;
      geometry.reasons.push("inset ring is not convex (R5 near-rect gate)");
    }
  }

  const roadClassification = verifyRoadClassificationMatchesSource(candidate);
  const setbackEdgeDistance = verifySetbackEdgeDistance(candidate, descriptor);

  const pass =
    geometry.pass && roadClassification.pass && setbackEdgeDistance.pass;

  return {
    pass,
    gates: {
      geometry,
      roadClassification,
      setbackEdgeDistance,
    },
  };
}
