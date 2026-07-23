import type { PropertyAtomInstance } from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import { isPropertyAtomPathEnabled } from "./env.js";

export interface WritePropertyAtomResult {
  atomDid: string;
  cid: string;
  skipped: boolean;
}

/**
 * Persist a property atom when PROPERTY_ATOM_PATH=1 and storage exposes
 * writePropertyAtom (Phase 1a atoms table jsonb path).
 */
export async function writePropertyAtomIfEnabled(
  storage: StoragePort,
  instance: PropertyAtomInstance,
): Promise<WritePropertyAtomResult | null> {
  if (!isPropertyAtomPathEnabled()) return null;
  if (typeof storage.writePropertyAtom !== "function") {
    throw new Error(
      "writePropertyAtomIfEnabled: storage port lacks writePropertyAtom — extend PgStorage for property entity types.",
    );
  }
  const { atomDid, cid } = await storage.writePropertyAtom(instance);
  return { atomDid, cid, skipped: false };
}
