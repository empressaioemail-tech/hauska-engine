/**
 * R33 — cert-equivalent promote gates (single source of truth).
 * Warm and mechanical cert MUST call these functions; no parallel checks.
 */

import {
  labelEdgesFromRoads,
  normalizeStreetNameForMatch,
  expandStreetAbbreviationTokens,
  situsStreetSegment,
  type EdgeLabelDraft,
} from "./edgeLabeling.js";
import { openRing, projectRing, type Ring } from "./geometry.js";
import { measurePerEdgeInsetForRings } from "./measure-inset.js";
import type { WarmEdgeRole, WarmRoadSource } from "./types.js";
import { resolveInsetFeetForEdge, buildFlatSetbackFallback } from "./warm-compute.js";
import type { JurisdictionDescriptor } from "../property-reasoning/types.js";

export const DEFAULT_R32_INSET_TOL_FT = 1.0;

/** R35 — disclosed orientation decline for landlocked / no-frontage / null-situs parcels. */
export const R35_ORIENTATION_DECLINE =
  "front orientation not determinable — no situs/frontage";

/**
 * R35 — situs indicates no determinable street frontage (lot-behind, landlocked, flag).
 * Never guess a front edge; honest-decline orientation instead.
 */
export function isNoDeterminableFrontageSitus(
  situsAddress: string | null | undefined,
): boolean {
  if (!situsAddress?.trim()) return true;
  const upper = situsAddress.trim().toUpperCase();
  if (/\bLOT\s+BEHIND\b/.test(upper)) return true;
  if (/\bLANDLOCKED\b/.test(upper)) return true;
  if (/\bFLAG\s+LOT\b/.test(upper)) return true;
  if (/\bREAR\s+OF\b/.test(upper)) return true;
  const segment = situsStreetSegment(situsAddress.trim());
  if (!/^\d+\s+\S/.test(segment) && /\b(LOT|TRACT|PARCEL)\b/.test(upper)) return true;
  return false;
}

/**
 * R33 facesAnswer — situs front-street token matches OSM road name after
 * normalization + abbreviation expansion. Substring match retained for partial names.
 */
export function streetNamesMatchForFacesAnswer(situsStreet: string, roadName: string): boolean {
  const keyA = expandStreetAbbreviationTokens(normalizeStreetNameForMatch(situsStreet));
  const keyB = expandStreetAbbreviationTokens(normalizeStreetNameForMatch(roadName));
  if (!keyA || !keyB) return false;
  return keyA === keyB || keyA.includes(keyB) || keyB.includes(keyA);
}

export function situsFrontStreetToken(situsAddress: string | null | undefined): string | null {
  if (!situsAddress?.trim()) return null;
  const streetPart = situsStreetSegment(situsAddress.trim());
  const m = /^\d+\s+(.+)$/.exec(streetPart);
  return m ? m[1]!.trim() : streetPart;
}

export interface FacesAnswerVerifyInput {
  situsAddress?: string | null;
  roads: ReadonlyArray<WarmRoadSource>;
  parcelRing: Ring;
}

export interface FacesAnswerVerifyResult {
  pass: boolean;
  reasons: string[];
  facesAnswer: boolean;
  frontStreetResolved: string | null;
  answerFrontKey: string | null;
  /** R35 — orientation axis honestly declined (cert PASS with disclosure). */
  orientationHonestDecline?: string;
}

/**
 * R33 facesAnswer gate — shared by warm promote and mechanical cert.
 */
export function verifyFacesAnswerMatch(input: FacesAnswerVerifyInput): FacesAnswerVerifyResult {
  if (isNoDeterminableFrontageSitus(input.situsAddress)) {
    return {
      pass: true,
      reasons: [R35_ORIENTATION_DECLINE],
      facesAnswer: false,
      frontStreetResolved: null,
      answerFrontKey: situsFrontStreetToken(input.situsAddress),
      orientationHonestDecline: R35_ORIENTATION_DECLINE,
    };
  }

  const answerFrontKeyRaw = situsFrontStreetToken(input.situsAddress);
  const answerFrontKey = answerFrontKeyRaw
    ? expandStreetAbbreviationTokens(normalizeStreetNameForMatch(answerFrontKeyRaw))
    : null;

  if (!answerFrontKey) {
    return {
      pass: true,
      reasons: [],
      facesAnswer: true,
      frontStreetResolved: null,
      answerFrontKey: null,
    };
  }

  const labelResult = labelEdgesFromRoads({
    parcelRing: input.parcelRing,
    roads: input.roads,
    situsAddress: input.situsAddress ?? null,
  });
  if (!labelResult.ok) {
    return {
      pass: false,
      reasons: [`fresh labeling declined: ${labelResult.decline}`],
      facesAnswer: false,
      frontStreetResolved: null,
      answerFrontKey,
    };
  }

  const freshFront = labelResult.edgeLabels.find((e) => e.label === "front");
  if (!freshFront) {
    return {
      pass: false,
      reasons: ["fresh labeling produced no front edge"],
      facesAnswer: false,
      frontStreetResolved: null,
      answerFrontKey,
    };
  }

  const backingRoad = input.roads.find((r) => r.osmWayId === freshFront.osmWayId) ?? null;
  const frontStreetResolved = backingRoad?.name ?? null;
  if (!frontStreetResolved) {
    return {
      pass: false,
      reasons: ["front edge has no resolved road name"],
      facesAnswer: false,
      frontStreetResolved: null,
      answerFrontKey,
    };
  }

  const facesAnswer = streetNamesMatchForFacesAnswer(answerFrontKeyRaw!, frontStreetResolved);
  return {
    pass: facesAnswer,
    reasons: facesAnswer
      ? []
      : [
          `facesAnswer: situs "${answerFrontKeyRaw}" != road "${frontStreetResolved}" (normalized keys ${answerFrontKey} vs ${expandStreetAbbreviationTokens(normalizeStreetNameForMatch(frontStreetResolved))})`,
        ],
    facesAnswer,
    frontStreetResolved,
    answerFrontKey,
  };
}

export interface R32VerifyInput {
  parcelRing: Ring;
  insetRing: Ring | null;
  edgeLabels: ReadonlyArray<Pick<EdgeLabelDraft, "index" | "label">>;
  descriptor: JurisdictionDescriptor;
  district: string;
  toleranceFt?: number;
  /** When set (cert path), use layer-23 key feet instead of descriptor resolution. */
  setbackKey?: { F: number; S: number; C: number | null; R: number };
  /**
   * Miter points collapseNearCollinearOffsetNotches (polygon-inset.ts)
   * produced building insetRing (WGS84) — same field as
   * WarmCandidate.miterPointsWgs84. When a lot edge's index-matched R32
   * measurement honestly reports matched:false (measure-inset.ts: "no
   * parallel inward-offset envelope edge found for this lot edge") AND
   * that edge's midpoint sits near an ACTUAL miter point this run
   * produced, the edge is honestly non-comparable (its own offset segment
   * was folded into a neighboring corner join) rather than a genuine R32
   * mismatch. See verifyR32PerEdgeInset.
   */
  miterPointsWgs84?: Ring;
}

function expectedFtForRoleFromKey(
  role: string,
  key: { F: number; S: number; C: number | null; R: number },
): number {
  if (role === "front") return key.F;
  if (role === "rear") return key.R;
  if (role === "side_corner") return key.C ?? key.S;
  return key.S;
}

export const R32_ABSORBED_EDGE_MITER_TOL_FT = 40;

/**
 * True when a lot edge's midpoint sits near an ACTUAL miter point the
 * offset run produced (never a length-based guess — see
 * perEdgeOffsetPlausible's identical requirement in polygon-inset.ts).
 * Projects everything into the parcel's own frame so distances are
 * directly comparable in feet.
 *
 * Exported (2026-08-07, block13 fossil-cohort fix) so every R32 per-edge
 * consumer — not just verifyR32PerEdgeInset — can apply the SAME
 * honest-non-comparable test instead of re-deriving it. This file's header
 * rule ("Warm and mechanical cert MUST call these functions; no parallel
 * checks") previously covered the pass/fail threshold call
 * (verifyR32PerEdgeInset) but not this helper specifically, which is how
 * cert-grade-core.ts's block13/query-mode grader drifted: it measures via
 * the same measurePerEdgeInsetForRings but never applied this or the
 * satisfiedByMoreRestrictiveNeighbor check, so an edge honestly reported as
 * "satisfied by containment" (measure-inset.ts's ownership-arbitration
 * rewrite, PR #269/#270) surfaced its neighbor's leftover unowned candidate
 * as if it were this edge's own measurement — false perEdgeInset failures
 * on 48021:34121 (edge 2: 84.06ft leftover reported against a 5ft side
 * expectation) and 48021:34161 (edge 0: 14.84ft leftover, matching the
 * REAR edge's ~15ft candidate, reported against a 5ft side expectation).
 */
export function edgeMidpointNearKnownMiterPoint(
  parcelRing: Ring,
  edgeIndex: number,
  miterPointsWgs84: Ring | undefined,
): boolean {
  if (!miterPointsWgs84 || miterPointsWgs84.length === 0) return false;
  const proj = projectRing(parcelRing);
  if (!proj) return false;
  const n = proj.points.length;
  const a = proj.points[edgeIndex % n];
  const b = proj.points[(edgeIndex + 1) % n];
  if (!a || !b) return false;
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const FEET_PER_METER = 3.280839895;
  for (const [lng, lat] of miterPointsWgs84) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const mx = (lng - proj.originLng) * proj.mPerDegLng;
    const my = (lat - proj.originLat) * proj.mPerDegLat;
    const distFt = Math.hypot(midX - mx, midY - my) * FEET_PER_METER;
    if (distFt <= R32_ABSORBED_EDGE_MITER_TOL_FT) return true;
  }
  return false;
}

/**
 * R32 per-edge inset remeasure — shared by warm promote and mechanical cert.
 */
export function verifyR32PerEdgeInset(input: R32VerifyInput): {
  pass: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (!input.insetRing?.length) {
    return { pass: false, reasons: ["no inset ring for R32 measurement"] };
  }

  const tol = input.toleranceFt ?? DEFAULT_R32_INSET_TOL_FT;
  const flatFallback = buildFlatSetbackFallback(input.descriptor, input.district);
  const r32Measured = measurePerEdgeInsetForRings(input.parcelRing, input.insetRing) ?? [];
  const nEdges = openRing(input.parcelRing).length;
  const labelByIndex = new Map(input.edgeLabels.map((e) => [e.index, e]));

  for (let i = 0; i < nEdges; i++) {
    const edgeLabel = labelByIndex.get(i);
    const role = edgeLabel?.label ?? "?";
    const expected =
      input.setbackKey != null
        ? expectedFtForRoleFromKey(role, input.setbackKey)
        : edgeLabel != null
          ? resolveInsetFeetForEdge(
              input.descriptor,
              input.district,
              { label: edgeLabel.label, roadClass: undefined },
              flatFallback,
            )
          : null;
    const measured = r32Measured[i];
    const r32 = measured?.insetFeet ?? null;

    // Honest non-comparable edge: R32's own index-matched measurer found
    // no dedicated offset segment (matched:false) for this lot edge, AND
    // that is explained by an ACTUAL notch collapse at this edge (not a
    // silent "assume it's fine" — a genuinely wrong/missing measurement on
    // an edge NOT near any real miter point still fails below).
    if (
      measured &&
      !measured.matched &&
      edgeMidpointNearKnownMiterPoint(input.parcelRing, i, input.miterPointsWgs84)
    ) {
      continue;
    }

    // 2026-08-07 OFFSET-CORE-VARIABLE-DISTANCE redesign (master planner
    // ruling 2, PR #269): measure-inset.ts's structural correspondence fix
    // reports satisfiedByMoreRestrictiveNeighbor: true when this edge's
    // own candidate boundary segment is actually owned by a more
    // restrictive, near-parallel ADJACENT lot edge — the envelope already
    // sits farther inward here than this edge's own setback requires
    // (satisfied by containment), not a genuine R32 mismatch. This is
    // independent of, and does not touch, the miter-point fallback above
    // (which covers the different case of a genuinely absorbed/collapsed
    // edge) — both are honest non-comparable outcomes, never a blanket
    // relaxation for an edge whose envelope truly fails to reach it.
    if (measured && !measured.matched && measured.satisfiedByMoreRestrictiveNeighbor) {
      continue;
    }

    if (expected == null || r32 == null || Math.abs(r32 - expected) > tol) {
      reasons.push(
        `edge ${i}: R32 ${r32 ?? "null"}ft != expected ${expected ?? "?"}ft for role ${role}`,
      );
    }
  }

  return { pass: reasons.length === 0, reasons };
}
