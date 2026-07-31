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
import type { VerifyResult, WarmCandidate, WarmRoadSource } from "./types.js";
import {
  labelEdgesFromRoads,
  type LabelEdgesResult,
} from "./edgeLabeling.js";
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

export interface FrontOrientationVerifyInput {
  situsAddress?: string | null;
  roads?: ReadonlyArray<WarmRoadSource>;
}

/**
 * R31 — front edge ROLE must match fresh road/situs labeling. Catches
 * mis-oriented envelopes where correct magnitudes land on wrong edges.
 */
export function verifyFrontEdgeOrientation(
  candidate: WarmCandidate,
  descriptor: JurisdictionDescriptor,
  input?: FrontOrientationVerifyInput,
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const roads = input?.roads ?? candidate.roads;
  const fresh: LabelEdgesResult = labelEdgesFromRoads({
    parcelRing: candidate.parcelRing,
    roads,
    situsAddress: input?.situsAddress ?? null,
  });
  if (!fresh.ok) {
    reasons.push(`fresh front labeling declined: ${fresh.decline}`);
    return { pass: false, reasons };
  }
  const freshFront = fresh.edgeLabels.find((e) => e.label === "front");
  const warmFront = candidate.edges.find((e) => e.label === "front");
  if (!freshFront) {
    reasons.push("fresh labeling produced no front edge");
    return { pass: false, reasons };
  }
  if (!warmFront) {
    reasons.push("warm candidate has no front edge");
    return { pass: false, reasons };
  }
  if (freshFront.index !== warmFront.index) {
    reasons.push(
      `front edge index ${warmFront.index} != fresh ${freshFront.index} (basis ${freshFront.frontBasis ?? "?"})`,
    );
  }
  const flatFallback = buildFlatSetbackFallback(descriptor, candidate.district);
  const freshByIndex = new Map(fresh.edgeLabels.map((e) => [e.index, e]));
  for (const edge of candidate.edges) {
    const freshEdge = freshByIndex.get(edge.index);
    if (freshEdge && freshEdge.label !== edge.label) {
      reasons.push(
        `edge ${edge.index}: warm role ${edge.label} != fresh role ${freshEdge.label}`,
      );
    }
    const roleForInset = freshEdge?.label ?? edge.label;
    const appliedFt = candidate.insetFeetPerEdge[edge.index];
    if (appliedFt === undefined) continue;
    const expectedForRole = resolveInsetFeetForEdge(
      descriptor,
      candidate.district,
      { label: roleForInset, roadClass: edge.roadClass },
      flatFallback,
    );
    if (Math.abs(appliedFt - expectedForRole) > 0.01) {
      reasons.push(
        `edge ${edge.index}: applied ${appliedFt}ft != ${expectedForRole}ft for role ${roleForInset}`,
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
  orientationInput?: FrontOrientationVerifyInput,
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
    // R5 near-rect gate — ONLY for lots that are themselves near-rectangular
    // AND convex (isNearRectangularParcelRing now requires turn-sign
    // consistency). On such a lot a non-convex or over-vertexed inset means the
    // offset math corrupted a clean rectangle (the 1006 Jefferson notch), so we
    // demand convexity + a bounded vertex count on top of the plain validity
    // gate. R29: genuinely irregular / notched / multi-part lots (e.g.
    // 48021:34121, an L-shaped hexagon hugging the alley) are NOT near-rect, so
    // this branch is skipped for them and their legitimately non-convex inset is
    // validated by geometryCorrectnessGate alone (containment, no
    // self-intersection/self-touch, positive area, per-edge plausibility).
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
  const frontOrientation =
    orientationInput?.situsAddress != null &&
    orientationInput.situsAddress.trim() !== ""
      ? verifyFrontEdgeOrientation(candidate, descriptor, orientationInput)
      : { pass: true, reasons: [] as string[] };

  const pass =
    geometry.pass &&
    roadClassification.pass &&
    setbackEdgeDistance.pass &&
    frontOrientation.pass;

  return {
    pass,
    gates: {
      geometry,
      roadClassification,
      setbackEdgeDistance,
      frontOrientation,
    },
  };
}
