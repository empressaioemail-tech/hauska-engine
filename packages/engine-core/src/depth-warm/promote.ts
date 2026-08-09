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
import { checkEnvelopeGroundTruth } from "../geometry/envelope-ground-truth.js";

/**
 * FIX 3 (2026-08-06 differential audit + process-retro R2 candidate a/d/e):
 * thrown when a candidate fails the SHARED ground-truth predicate at the
 * moment of durable write. This is deliberately a SEPARATE, INDEPENDENT
 * check from mechanical verify (verify-mechanical.ts) — the process-retro's
 * central finding is that role/label-parity checks (serveTruthEdgeLabels)
 * and mechanical verify both passed on 48021:31308 while the actual
 * geometry leaked outside the parcel; no check in the promote path actually
 * asserted containment before this fix. promoteDepthWarmToStorage refuses
 * to write when this check fails — never persists a candidate the shared
 * predicate rejects, regardless of what verify already decided.
 */
export class EnvelopeGroundTruthPromoteDeclineError extends Error {
  readonly parcelNodeId: string;
  readonly failureReason: string | null;

  constructor(parcelNodeId: string, failureReason: string | null, detail: string) {
    super(
      `promote: envelope ground-truth predicate failed for ${parcelNodeId} (${failureReason ?? "unknown"}): ${detail}`,
    );
    this.name = "EnvelopeGroundTruthPromoteDeclineError";
    this.parcelNodeId = parcelNodeId;
    this.failureReason = failureReason;
  }
}

/**
 * WRITE-THEN-VERIFY (2026-08-07, master planner ruling, third instance of
 * "gate against an internal representation instead of ground truth"):
 * thrown when the ground-truth predicate, re-run against the atom AS ACTUALLY
 * READ BACK from storage post-persist (the exact serve representation — what
 * getPropertyAtomChain and PE actually return), disagrees with the pre-write
 * gate above. The pre-write gate checks the in-memory candidate; a pass
 * there does not prove the SERIALIZED, STORED bytes will read back
 * correctly (a serializer bug, a wrong-field write, or any transform
 * between the checked object and the persisted row would slip through the
 * pre-write gate undetected). This is the closing half of the law: every
 * gate in the promote path must run on the serialized read-back, not only
 * the in-memory object. On mismatch, the just-written buildable-envelope
 * atom is immediately retired (status: "retired") rather than left serving
 * a ring the predicate rejects — fail-closed, never a silent bad-serve.
 */
export class EnvelopeWriteThenVerifyMismatchError extends Error {
  readonly parcelNodeId: string;
  readonly buildableEnvelopeAtomDid: string;
  readonly failureReason: string | null;

  constructor(
    parcelNodeId: string,
    buildableEnvelopeAtomDid: string,
    failureReason: string | null,
    detail: string,
  ) {
    super(
      `promote: write-then-verify mismatch for ${parcelNodeId} (${buildableEnvelopeAtomDid}) — ` +
        `stored geojson failed the ground-truth predicate (${failureReason ?? "unknown"}), retired: ${detail}`,
    );
    this.name = "EnvelopeWriteThenVerifyMismatchError";
    this.parcelNodeId = parcelNodeId;
    this.buildableEnvelopeAtomDid = buildableEnvelopeAtomDid;
    this.failureReason = failureReason;
  }
}

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
  /** R33 — situs for ground-truth P2/P3 fresh relabel (34177 situs-street-match class). */
  situsAddress?: string | null;
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

  // FIX 3 — fail-closed ground-truth gate, independent of mechanical verify.
  // Runs only when the candidate actually has an inset ring to grade; an
  // empty/no-buildable-area candidate has no envelope to check and is
  // handled by the honest-decline path elsewhere, not this promote call.
  //
  // GROUND-TRUTH FRAME LAW (2026-08-07, master planner ruling): truth is
  // measured against candidate.rawParcelRing (the source-of-truth ring,
  // before any lot-line scrub) — NEVER candidate.parcelRing, which may be a
  // scrubbed/cleaned ring that silently dropped a real boundary edge (root
  // cause, verified on 48021:31299: the scrubbed ring differs from the raw
  // txgio/BCAD ring by one real 2.428m/7.97ft edge; the served envelope
  // graded PERFECTLY against its own scrubbed ring — 5/25/15/25ft exact —
  // while measuring 0.41/27.6/20.6/23.3ft against the true parcel ring).
  // edgeRoles is deliberately OMITTED here: input.candidate.edges[].index is
  // keyed in the SCRUBBED ring's frame, which may have a different edge
  // count/order than rawParcelRing — passing it would silently misalign
  // role-to-edge correspondence across two different rings (the exact
  // "index transform across frames" defect class this engagement's binding
  // rule forbids). checkEnvelopeGroundTruth falls back to a FRESH
  // labelEdgesFromRoads call on rawParcelRing itself when edgeRoles is
  // omitted, which is frame-consistent by construction.
  if (input.candidate.insetRing) {
    const groundTruthParcelRing = input.candidate.rawParcelRing ?? input.candidate.parcelRing;
    const groundTruth = checkEnvelopeGroundTruth({
      parcelRing: groundTruthParcelRing,
      envelopeRing: input.candidate.insetRing,
      descriptor: input.descriptor,
      district: input.candidate.district,
      roads: input.candidate.roads,
      situsAddress: input.situsAddress ?? null,
      // miterPointsWgs84 coordinates are absolute WGS84 points, not indexed
      // into either ring's frame — safe to pass alongside rawParcelRing
      // even though the miter run itself offset candidate.parcelRing.
      miterPointsWgs84: input.candidate.miterPointsWgs84,
    });
    if (!groundTruth.pass) {
      throw new EnvelopeGroundTruthPromoteDeclineError(
        input.candidate.parcelNodeId,
        groundTruth.failureReason,
        JSON.stringify({ p1: groundTruth.p1, p2Fails: groundTruth.p2.edges.filter((e) => !e.pass), p3: groundTruth.p3 }),
      );
    }
  }

  let setbackRuleAtomDid = "";
  let buildableEnvelopeAtomDid = "";
  const boundaryEdgeAtomDids: string[] = [];

  if (emitted.boundaryEdges.length > 0) {
    const edgeWrites = await persistBoundaryEdges(storage, emitted.boundaryEdges, {
      force: true,
    });
    boundaryEdgeAtomDids.push(...edgeWrites.map((w) => w.atomDid));

    // FIX 2 (D2 audit): retire every OTHER generation's boundary-edge atoms
    // for this parcel so exactly one coherent generation is left active.
    // versionStamp is shared across every edge emitted in this batch
    // (emit-boundary-edges-from-warm.ts), so a prior generation with a
    // different versionStamp — even one that happens to share edgeIndex
    // values or total count with the new generation — is retired, never
    // left coexisting as "active".
    const currentVersionStamp = emitted.boundaryEdges[0]!.versionStamp;
    if (currentVersionStamp) {
      const retireWrites = await retireStaleBoundaryEdgesAfterPromote(
        storage,
        input.candidate.parcelNodeId,
        currentVersionStamp,
        promotedAt,
      );
      boundaryEdgeAtomDids.push(...retireWrites.map((w) => w.atomDid));
    }
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

  // WRITE-THEN-VERIFY (2026-08-07, master planner ruling): read the
  // buildable-envelope atom BACK from storage — the exact bytes any serve
  // path (getPropertyAtomChain, cert-grade, PE) would read — and re-run the
  // ground-truth predicate against THAT geojson ring, against
  // rawParcelRing. Only runs when the pre-write gate above actually ran
  // (input.candidate.insetRing present) and a buildable-envelope atom was
  // actually written this call.
  if (input.candidate.insetRing && buildableEnvelopeAtomDid) {
    const readBack = (await storage.getAtomByDid(buildableEnvelopeAtomDid)) as
      | (PropertyAtomInstance & { geojson?: { features?: Array<{ geometry?: { coordinates?: unknown[][] } }> } })
      | null;
    const storedRing = readBack?.geojson?.features?.[0]?.geometry?.coordinates?.[0] as
      | WarmCandidate["insetRing"]
      | undefined;
    if (!readBack || !storedRing?.length) {
      throw new EnvelopeWriteThenVerifyMismatchError(
        input.candidate.parcelNodeId,
        buildableEnvelopeAtomDid,
        "read-back-missing",
        "read-back returned no atom or no geojson ring for the atomDid just written",
      );
    } else {
      const groundTruthParcelRing = input.candidate.rawParcelRing ?? input.candidate.parcelRing;
      const readBackGroundTruth = checkEnvelopeGroundTruth({
        parcelRing: groundTruthParcelRing,
        envelopeRing: storedRing,
        descriptor: input.descriptor,
        district: input.candidate.district,
        roads: input.candidate.roads,
        situsAddress: input.situsAddress ?? null,
        miterPointsWgs84: input.candidate.miterPointsWgs84,
      });
      if (!readBackGroundTruth.pass) {
        // Fail-closed: retire the atom just written rather than leave a
        // predicate-rejected ring active and servable.
        const retired = {
          ...readBack,
          status: "retired" as const,
        };
        await writePropertyAtomIfEnabled(storage, retired);
        throw new EnvelopeWriteThenVerifyMismatchError(
          input.candidate.parcelNodeId,
          buildableEnvelopeAtomDid,
          readBackGroundTruth.failureReason,
          JSON.stringify({
            p1: readBackGroundTruth.p1,
            p2Fails: readBackGroundTruth.p2.edges.filter((e) => !e.pass),
            p3: readBackGroundTruth.p3,
          }),
        );
      }
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
