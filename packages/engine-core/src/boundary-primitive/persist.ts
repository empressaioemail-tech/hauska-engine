/**
 * Boundary edge persistence (S2-U2).
 */

import type { BoundaryEdgeAtomInstance } from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

function persistEnabled(): boolean {
  return (
    process.env.BOUNDARY_PRIMITIVE_PERSIST === "1" ||
    process.env.PROPERTY_ATOM_PATH === "1"
  );
}

/** Write one edge when persist flag enabled; otherwise no-op. */
export async function writeBoundaryEdgeIfEnabled(
  storage: StoragePort,
  instance: BoundaryEdgeAtomInstance,
): Promise<{ atomDid: string; cid: string } | null> {
  if (!persistEnabled()) return null;
  return storage.writeBoundaryEdgeAtom(instance);
}

/** Batch persist boundary edges for a parcel. */
export async function persistBoundaryEdges(
  storage: StoragePort,
  instances: ReadonlyArray<BoundaryEdgeAtomInstance>,
  options?: { force?: boolean },
): Promise<ReadonlyArray<{ atomDid: string; cid: string }>> {
  if (!options?.force && !persistEnabled()) return [];
  if (instances.length === 0) return [];
  return storage.writeBoundaryEdgeAtomsBatch(instances);
}
