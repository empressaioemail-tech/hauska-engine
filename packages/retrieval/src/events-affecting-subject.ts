/**
 * Structural would_affect edge write path with DB-layer immutability.
 */

import type { WouldAffectEdge } from "@hauska-engine/atom-contract-pin/tce";
import {
  parseWouldAffectEdge,
  type StructuralGraphStore,
} from "@hauska-engine/storage";

export class WouldAffectEdgeWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WouldAffectEdgeWriteError";
  }
}

export async function writeWouldAffectEdge(
  store: StructuralGraphStore,
  edge: WouldAffectEdge,
): Promise<"written" | "duplicate"> {
  let parsed: WouldAffectEdge;
  try {
    parsed = parseWouldAffectEdge(edge);
  } catch (err) {
    throw new WouldAffectEdgeWriteError(
      err instanceof Error ? err.message : "invalid would_affect edge",
    );
  }
  if (!parsed.sourceNodeId.startsWith("evt_")) {
    throw new WouldAffectEdgeWriteError(
      "sourceNodeId must carry evt_ prefix",
    );
  }
  return store.writeWouldAffectEdge(parsed);
}

export async function queryEventsAffectingSubject(
  store: StructuralGraphStore,
  targetSubjectId: string,
) {
  return store.queryEventsAffectingSubject(targetSubjectId);
}
