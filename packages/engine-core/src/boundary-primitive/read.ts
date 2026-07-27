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

/** Return ordered boundary edges for a parcel; fail closed when none persisted. */
export async function readBoundaryEdgesForParcel(
  storage: StoragePort,
  parcelNodeId: string,
): Promise<ReadonlyArray<BoundaryEdgeAtomInstance>> {
  const edges = await storage.listBoundaryEdgesByParcelNodeId(parcelNodeId);
  if (edges.length === 0) {
    throw new BoundaryPrimitiveMissingError(parcelNodeId);
  }
  return [...edges].sort((a, b) => a.edgeIndex - b.edgeIndex);
}
