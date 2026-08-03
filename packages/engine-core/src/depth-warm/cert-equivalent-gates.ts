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
import { openRing, type Ring } from "./geometry.js";
import { measurePerEdgeInsetForRings } from "./measure-inset.js";
import type { WarmEdgeRole, WarmRoadSource } from "./types.js";
import { resolveInsetFeetForEdge, buildFlatSetbackFallback } from "./warm-compute.js";
import type { JurisdictionDescriptor } from "../property-reasoning/types.js";

export const DEFAULT_R32_INSET_TOL_FT = 1.0;

/** R35 — disclosed orientation decline for landlocked / no-frontage parcels. */
export const R35_ORIENTATION_DECLINE =
  "front orientation not determinable — no street frontage";

/**
 * R35 — situs indicates no determinable street frontage (lot-behind, landlocked, flag).
 * Never guess a front edge; honest-decline orientation instead.
 */
export function isNoDeterminableFrontageSitus(
  situsAddress: string | null | undefined,
): boolean {
  if (!situsAddress?.trim()) return false;
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
    const r32 = r32Measured[i]?.insetFeet ?? null;
    if (expected == null || r32 == null || Math.abs(r32 - expected) > tol) {
      reasons.push(
        `edge ${i}: R32 ${r32 ?? "null"}ft != expected ${expected ?? "?"}ft for role ${role}`,
      );
    }
  }

  return { pass: reasons.length === 0, reasons };
}
