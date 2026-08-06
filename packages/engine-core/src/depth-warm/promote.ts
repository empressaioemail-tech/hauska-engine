/**
 * Promotion write to durable property atoms (27c R3 WDLL 6 / WDLL 8 read path).
 */

import type {
  BoundaryEdgeAtomInstance,
  BuildableEnvelopeAtomInstance,
  PropertyAtomInstance,
  SetbackRuleAtomInstance,
} from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import { createWidthedConfidence } from "@empressaio/atom-contract/read-contract";
import { emitBuildableEnvelope } from "../property-reasoning/emit-buildable-envelope.js";
import { emitSetbackRule, resolveSetbackTableRow } from "../property-reasoning/emit-setback-rule.js";
import type { JurisdictionDescriptor } from "../property-reasoning/types.js";
import { writePropertyAtomIfEnabled } from "../property-reasoning/write-property-atom.js";
import {
  persistBoundaryEdges,
  retireStaleBoundaryEdgesAfterPromote,
} from "../boundary-primitive/persist.js";
import { emitBoundaryEdgesFromWarmCandidate } from "./emit-boundary-edges-from-warm.js";
import type { PromotedDepthWarmBundle, WarmCandidate } from "./types.js";
import {
  DEPTH_WARM_PROMOTION_MARKER,
  DEPTH_WARM_SOURCE_CITATION,
  RECIPE_VERSION,
} from "./types.js";

function aggregateSetbacks(candidate: WarmCandidate): {
  front: number;
  side: number;
  rear: number;
} {
  let front = 0;
  let side = 0;
  let rear = 0;
  for (const e of candidate.edges) {
    if (e.label === "front") front = e.insetFeet;
    else if (e.label === "rear") rear = e.insetFeet;
    else if (e.label === "side" || e.label === "side_corner") {
      if (side === 0) side = e.insetFeet;
    }
  }
  return { front, side, rear };
}

function buildGeojson(insetRing: NonNullable<WarmCandidate["insetRing"]>) {
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        geometry: {
          type: "Polygon" as const,
          coordinates: [insetRing],
        },
        properties: {
          kind: "buildable-envelope",
          depthWarm: DEPTH_WARM_PROMOTION_MARKER,
          recipeVersion: RECIPE_VERSION,
        },
      },
    ],
  };
}

export interface PromoteDepthWarmInput {
  candidate: WarmCandidate;
  descriptor: JurisdictionDescriptor;
  zoningFactAtomDid: string;
  extractedAt?: string;
}

export interface DepthWarmPromotionEmit {
  boundaryEdges: BoundaryEdgeAtomInstance[];
  propertyAtoms: PropertyAtomInstance[];
}

/**
 * Emit depth-warm verified atoms (boundary-edge + setback-rule + buildable-envelope).
 * Does not write — use promoteDepthWarmToStorage for persistence.
 */
export function emitDepthWarmPromotion(
  input: PromoteDepthWarmInput,
): DepthWarmPromotionEmit {
  const { candidate, descriptor, zoningFactAtomDid } = input;
  const extractedAt = input.extractedAt ?? new Date().toISOString();
  const agg = aggregateSetbacks(candidate);

  const resolved = resolveSetbackTableRow(descriptor.setbackTable, candidate.district);
  if ("kind" in resolved) {
    throw new Error(`promote: setback row missing for ${candidate.district}`);
  }
  const rawRow = descriptor.setbackTable?.rows.find(
    (r) => r.district_code.toLowerCase() === candidate.district.trim().toLowerCase(),
  );
  if (!rawRow) {
    throw new Error(`promote: raw setback row missing for ${candidate.district}`);
  }

  /** Per-parcel layer 23 is authoritative for scalars — do not overwrite with edge aggregate. */
  const perParcelScalars =
    descriptor.sourceAdapter === "bastrop-per-parcel-record-layer-23";
  const rowForEmit = perParcelScalars
    ? rawRow
    : {
        ...rawRow,
        front_ft: { ...rawRow.front_ft!, value: agg.front },
        side_ft: { ...rawRow.side_ft!, value: agg.side },
        rear_ft: { ...rawRow.rear_ft!, value: agg.rear },
      };

  const setback = emitSetbackRule(
    descriptor,
    candidate.district,
    rowForEmit,
    candidate.parcelNodeId,
  );
  if (setback && "kind" in setback) {
    throw new Error(`promote: setback emit declined (${setback.code})`);
  }
  const setbackAtom = setback as SetbackRuleAtomInstance;

  const zAsserted = createWidthedConfidence({
    estimate: 0.85,
    n: 0,
    intervalWidth: 0.15,
    provenance: "asserted",
  });
  const sAsserted = setbackAtom.readContract?.axes.assertedConfidence;
  if (!sAsserted) {
    throw new Error("promote: setback atom missing assertedConfidence");
  }

  const envelope = emitBuildableEnvelope({
    descriptor: {
      ...descriptor,
      sourceAdapter: "depth-warm-verify-promote",
      sourceUrl: "https://hauska.dev/internal/depth-warm/promote",
    },
    parcelNodeId: candidate.parcelNodeId,
    zoningFactAtomDid,
    setbackRuleAtomDid: setbackAtom.atomDid,
    geometryRefId: `${candidate.parcelNodeId}/geometry`,
    frontEdgeRefId: `${candidate.parcelNodeId}/front-edge`,
    outcome: {
      kind: "buildable",
      areaSqFt: Math.round(candidate.buildableAreaSqFt),
    },
    inputAssertedConfidences: [zAsserted, sAsserted],
    sourceCitation: DEPTH_WARM_SOURCE_CITATION,
    extractedAt,
  });
  if (envelope && "kind" in envelope) {
    throw new Error(`promote: envelope emit declined (${envelope.code})`);
  }

  const envAtom = envelope as BuildableEnvelopeAtomInstance & {
    geojson?: unknown;
    depthWarmPromotion?: string;
    depthWarmVerifiedAt?: string;
    recipeVersion?: string;
  };
  if (candidate.insetRing) {
    envAtom.geojson = buildGeojson(candidate.insetRing);
  }
  envAtom.depthWarmPromotion = DEPTH_WARM_PROMOTION_MARKER;
  envAtom.depthWarmVerifiedAt = extractedAt;
  envAtom.recipeVersion = RECIPE_VERSION;

  const boundaryEdges = emitBoundaryEdgesFromWarmCandidate({
    candidate,
    descriptor,
    extractedAt,
  });

  return {
    boundaryEdges,
    propertyAtoms: [setbackAtom, envAtom],
  };
}

export async function promoteDepthWarmToStorage(
  storage: StoragePort,
  input: PromoteDepthWarmInput,
): Promise<PromotedDepthWarmBundle> {
  const emitted = emitDepthWarmPromotion(input);
  const promotedAt = input.extractedAt ?? new Date().toISOString();
  let setbackRuleAtomDid = "";
  let buildableEnvelopeAtomDid = "";
  const boundaryEdgeAtomDids: string[] = [];

  if (emitted.boundaryEdges.length > 0) {
    const edgeWrites = await persistBoundaryEdges(storage, emitted.boundaryEdges, {
      force: true,
    });
    boundaryEdgeAtomDids.push(...edgeWrites.map((w) => w.atomDid));
    const promotedIndices = new Set(emitted.boundaryEdges.map((e) => e.edgeIndex));
    const retireWrites = await retireStaleBoundaryEdgesAfterPromote(
      storage,
      input.candidate.parcelNodeId,
      promotedIndices,
      promotedAt,
    );
    boundaryEdgeAtomDids.push(...retireWrites.map((w) => w.atomDid));
  }

  for (const atom of emitted.propertyAtoms) {
    const result = await writePropertyAtomIfEnabled(storage, atom);
    if (!result) {
      throw new Error("promote: PROPERTY_ATOM_PATH not enabled or write skipped");
    }
    if (atom.entityType === "setback-rule") setbackRuleAtomDid = result.atomDid;
    if (atom.entityType === "buildable-envelope") {
      buildableEnvelopeAtomDid = result.atomDid;
    }
  }

  return {
    parcelNodeId: input.candidate.parcelNodeId,
    setbackRuleAtomDid,
    buildableEnvelopeAtomDid,
    boundaryEdgeAtomDids,
    promotedAt,
  };
}
