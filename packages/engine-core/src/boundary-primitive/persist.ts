/**
 * Boundary edge persistence (S2-U2).
 */

import type { BoundaryEdgeAtomInstance } from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import { contentHashExcludingProvenance } from "../property-reasoning/confidence.js";

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

/**
 * FIX 2 (2026-08-06 differential audit D2 / WS1 serve-truth amendment):
 * retire-not-overwrite for boundary-edge atoms at promote time. Prior to
 * this fix, promoteDepthWarmToStorage wrote the fresh warm-time edge set
 * but never retired the PRIOR generation's edges — a parcel could carry two
 * disagreeing "active" generations simultaneously at non-overlapping
 * edgeIndex slots (e.g. 4 fresh depth-warm-verify-promote edges at index
 * 0-3 plus 1-3 stale descriptor-fixture edges at index 4-6), and a naive
 * count-based read (edges.length === ringVerts) could pass by coincidence
 * while actually serving a mixed-generation set. Matches the repo's
 * existing retire-not-overwrite convention
 * (property-reasoning/retire.ts:flipPropertyAtomRetired) — flips `status`
 * to "retired" and re-persists; never deletes or mutates history in place.
 *
 * Generation identity is `versionStamp` (the same field every other emit
 * path in this repo already uses — zoning-fact, buildable-envelope,
 * setback-rule, road-node — see property-reasoning/retire.ts). Every
 * currently-active edge on the parcel whose `versionStamp` does not match
 * `currentVersionStamp` is retired, regardless of edgeIndex. Comparing by
 * versionStamp rather than "index not in the new set" also correctly
 * retires a same-index edge from an OLDER generation when the new
 * generation's edge count happens to coincide with the old one's — index
 * alone cannot distinguish generations when counts coincide (exactly the
 * D2 failure mode: 4 fresh + 3 stale = 7, which equalled the true 7-vertex
 * ring's edge count by coincidence).
 */
export async function retireStaleBoundaryEdgesAfterPromote(
  storage: StoragePort,
  parcelNodeId: string,
  currentVersionStamp: string,
  retiredAt: string,
): Promise<ReadonlyArray<{ atomDid: string; cid: string }>> {
  const existing = await storage.listBoundaryEdgesByParcelNodeId(parcelNodeId);
  const toRetire: BoundaryEdgeAtomInstance[] = [];
  for (const edge of existing) {
    if (edge.versionStamp === currentVersionStamp) continue;
    const retired: BoundaryEdgeAtomInstance = {
      ...edge,
      status: "retired",
      retiredAt,
    };
    retired.contentHash = contentHashExcludingProvenance(retired);
    toRetire.push(retired);
  }
  if (toRetire.length === 0) return [];
  return persistBoundaryEdges(storage, toRetire, { force: true });
}
