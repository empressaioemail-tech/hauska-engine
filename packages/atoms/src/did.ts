/**
 * DID utilities per ADR-011.
 *
 * Atom identity is a DID of the form `did:hauska:<entityType>:<localId>`.
 * The DID is durable across versions; the CID is per-version.
 *
 * Specific method spec, key custody, and IPNS rotation policy are
 * deferred per ADR-011 §Open-for-refinement. This module provides
 * the structural shape so engine code can build / parse DIDs without
 * committing to mechanics yet.
 */

const DID_METHOD = "hauska";

export interface AtomDid {
  raw: string;
  entityType: string;
  localId: string;
}

export function buildAtomDid(entityType: string, localId: string): AtomDid {
  if (!entityType || !localId) {
    throw new Error(
      `buildAtomDid: entityType and localId required; got entityType="${entityType}" localId="${localId}"`,
    );
  }
  if (!/^[a-z0-9-]+$/.test(entityType)) {
    throw new Error(`buildAtomDid: entityType must be kebab-case; got "${entityType}"`);
  }
  return {
    raw: `did:${DID_METHOD}:${entityType}:${localId}`,
    entityType,
    localId,
  };
}

export function parseAtomDid(raw: string): AtomDid {
  const parts = raw.split(":");
  if (parts.length < 4 || parts[0] !== "did" || parts[1] !== DID_METHOD) {
    throw new Error(`parseAtomDid: malformed DID "${raw}"`);
  }
  const entityType = parts[2];
  const localId = parts.slice(3).join(":");
  if (!entityType || !localId) {
    throw new Error(`parseAtomDid: empty segment in "${raw}"`);
  }
  return { raw, entityType, localId };
}
