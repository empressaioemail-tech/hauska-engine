/**
 * Mechanical verify agent (27c R3 WDLL 6).
 * Never second-agent re-assertion — geometry gate + classification-vs-source +
 * right-edge/right-distance checks only.
 */

import { classifyOsmHighwayTag } from "../road-intake/classify.js";
import { resolveRoadClassSetback } from "../property-reasoning/resolve-road-class-setback.js";
import type { JurisdictionDescriptor, RoadEdgeRole } from "../property-reasoning/types.js";
import { geometryCorrectnessGate } from "./geometry.js";
import type { VerifyResult, WarmCandidate } from "./types.js";

function roleForLabel(label: string): RoadEdgeRole {
  if (label === "front" || label === "rear" || label === "side") return label;
  if (label === "side_corner") return "side_corner";
  return "side";
}

/**
 * Gate: road classification on each edge must match OSM highway tag re-classified.
 */
export function verifyRoadClassificationMatchesSource(
  candidate: WarmCandidate,
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const edge of candidate.edges) {
    if (!edge.roadClass || !edge.osmHighwayTag) continue;
    const fromTag = classifyOsmHighwayTag(edge.osmHighwayTag);
    if (fromTag !== edge.roadClass) {
      reasons.push(
        `edge ${edge.index}: classification ${edge.roadClass} != OSM tag ${edge.osmHighwayTag} (${fromTag})`,
      );
    }
  }
  for (const road of candidate.roads) {
    const fromTag = classifyOsmHighwayTag(road.osmHighwayTag);
    if (fromTag !== road.classification) {
      reasons.push(
        `road ${road.osmWayId}: classification ${road.classification} != tag ${road.osmHighwayTag} (${fromTag})`,
      );
    }
  }
  return { pass: reasons.length === 0, reasons };
}

/**
 * Gate: applied inset feet on each edge match descriptor (road-class, edge-role) lookup.
 */
export function verifySetbackEdgeDistance(
  candidate: WarmCandidate,
  descriptor: JurisdictionDescriptor,
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const tol = 0.01;
  for (const edge of candidate.edges) {
    if (!edge.roadClass) continue;
    const expected = resolveRoadClassSetback(
      descriptor,
      candidate.district,
      edge.roadClass,
      roleForLabel(edge.label),
    );
    if ("kind" in expected) {
      reasons.push(`edge ${edge.index}: expected setback lookup failed (${expected.code})`);
      continue;
    }
    if (Math.abs(edge.insetFeet - expected.value) > tol) {
      reasons.push(
        `edge ${edge.index}: inset ${edge.insetFeet}ft != expected ${expected.value}ft for ${edge.roadClass}/${edge.label}`,
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
