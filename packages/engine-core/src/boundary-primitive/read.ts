/**
 * Fail-closed read path for Unit 3 (S2-U3) — no silent re-derive.
 */

import type { BoundaryEdgeAtomInstance } from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

export class BoundaryPrimitiveMissingError extends Error {
  readonly parcelNodeId: string;

  constructor(parcelNodeId: string) {
    super(`Boundary primitive missing for parcel ${parcelNodeId}`);
    this.name = "BoundaryPrimitiveMissingError";
    this.parcelNodeId = parcelNodeId;
  }
}

/**
 * FIX 2 (D2 audit) belt-and-suspenders: raised when `status='active'`
 * boundary-edge rows for one parcel carry more than one distinct
 * `versionStamp`. retireStaleBoundaryEdgesAfterPromote (persist.ts) is the
 * primary defense — every promote retires every OTHER generation — but this
 * error exists so a read never silently serves a mixed set if retirement
 * was skipped, raced, or predates this fix (e.g. a parcel promoted before
 * versionStamp was populated on boundary-edge atoms).
 */
export class MixedGenerationBoundaryPrimitiveError extends Error {
  readonly parcelNodeId: string;
  readonly versionStamps: ReadonlyArray<string | undefined>;

  constructor(parcelNodeId: string, versionStamps: ReadonlyArray<string | undefined>) {
    super(
      `Boundary primitive for parcel ${parcelNodeId} has mixed generations (versionStamps: ${JSON.stringify(
        versionStamps,
      )}) — refusing to serve a blended edge set`,
    );
    this.name = "MixedGenerationBoundaryPrimitiveError";
    this.parcelNodeId = parcelNodeId;
    this.versionStamps = versionStamps;
  }
}

/**
 * Filter a raw active-edge read down to the single most-recent generation
 * (by versionStamp), or throw MixedGenerationBoundaryPrimitiveError if more
 * than one distinct versionStamp is present among edges that were NOT
 * already filtered as retired by the storage layer. Edges with no
 * versionStamp at all (pre-fix legacy rows, e.g. descriptor-fixture) are
 * treated as their own single generation when they are the ONLY generation
 * present — never silently merged with a versioned generation.
 */
export function selectLiveGeneration(
  edges: ReadonlyArray<BoundaryEdgeAtomInstance>,
): ReadonlyArray<BoundaryEdgeAtomInstance> {
  if (edges.length === 0) return edges;
  const stamps = new Set(edges.map((e) => e.versionStamp ?? null));
  if (stamps.size <= 1) return edges;

  // Multiple distinct generations present as "active" — fail closed rather
  // than silently blend edgeIndex ranges from different generations.
  throw new MixedGenerationBoundaryPrimitiveError(
    edges[0]!.parcelNodeId,
    edges.map((e) => e.versionStamp),
  );
}

/** Return ordered boundary edges for a parcel; fail closed when none persisted. */
export async function readBoundaryEdgesForParcel(
  storage: StoragePort,
  parcelNodeId: string,
): Promise<ReadonlyArray<BoundaryEdgeAtomInstance>> {
  const edges = await storage.listBoundaryEdgesByParcelNodeId(parcelNodeId);
  if (edges.length === 0) {
    throw new BoundaryPrimitiveMissingError(parcelNodeId);
  }
  const live = selectLiveGeneration(edges);
  return [...live].sort((a, b) => a.edgeIndex - b.edgeIndex);
}
