/**
 * P-82-lite / BP-WRITE-01 write boundary.
 *
 * Refuses a non-canonical parcel binding, a sentinel inside a key, and a
 * body.atomDid whose namespace does not match the column DID, before any
 * INSERT. Road-node is not parcel-keyed and is not this grammar.
 */
import { buildAtomDid, parseAtomDid } from "./did.js";
import {
  isCountyCoverageParcelNodeId,
  isKeySentinelToken,
  parseEntityIdTokens,
} from "./parcel-write-identity.js";
import type { PropertyAtomInstance } from "./property-instances.js";

export const NON_CANONICAL_BINDING = "NON_CANONICAL_BINDING";
export const KEY_SENTINEL = "KEY_SENTINEL";
export const DID_NAMESPACE = "DID_NAMESPACE";
export const STARVED_EDGE = "STARVED_EDGE";

const FIPS = /^\d{5}$/;
const INTEGER_PROP = /^\d+$/;

export class WriteBoundaryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WriteBoundaryError";
    this.code = code;
  }
}

function isParcelKeyedType(entityType: string): boolean {
  return entityType !== "road-node";
}

/**
 * {fips}:{integer} plus optional non-sentinel discriminators, or county coverage.
 */
export function assertCanonicalBinding(key: string, field: "entityId" | "parcelNodeId"): void {
  const tokens = parseEntityIdTokens(key);
  if (tokens.length < 2 || !FIPS.test(tokens[0]!)) {
    throw new WriteBoundaryError(
      NON_CANONICAL_BINDING,
      `${field} is not {fips}:{integer}: ${key}`,
    );
  }
  for (const token of tokens) {
    if (isKeySentinelToken(token)) {
      throw new WriteBoundaryError(
        KEY_SENTINEL,
        `${field} contains sentinel token '${token}': ${key}`,
      );
    }
  }
  if (isCountyCoverageParcelNodeId(key)) {
    return;
  }
  if (!INTEGER_PROP.test(tokens[1]!)) {
    throw new WriteBoundaryError(
      NON_CANONICAL_BINDING,
      `${field} is not {fips}:{integer}: ${key}`,
    );
  }
}

export function assertDidNamespace(
  instance: Pick<PropertyAtomInstance, "entityType" | "entityId" | "atomDid">,
  columnAtomDid: string,
): void {
  const bodyDid = instance.atomDid;
  if (bodyDid == null || bodyDid === "") return;
  // Writer-local ids (fhfact_*, railfact_*) are not a DID namespace.
  // The column is minted as did:hauska. Only a did: method that is not
  // hauska, or a hauska DID whose type does not match the column, refuses.
  if (!bodyDid.startsWith("did:")) return;
  let parsed;
  try {
    parsed = parseAtomDid(bodyDid);
  } catch {
    throw new WriteBoundaryError(
      DID_NAMESPACE,
      `body.atomDid is not did:hauska: ${bodyDid}`,
    );
  }
  let columnParsed;
  try {
    columnParsed = parseAtomDid(columnAtomDid);
  } catch {
    throw new WriteBoundaryError(
      DID_NAMESPACE,
      `column atom_did is not did:hauska: ${columnAtomDid}`,
    );
  }
  if (parsed.entityType !== columnParsed.entityType) {
    throw new WriteBoundaryError(
      DID_NAMESPACE,
      `body.atomDid entityType ${parsed.entityType} != column ${columnParsed.entityType}`,
    );
  }
  const expected = buildAtomDid(instance.entityType, instance.entityId).raw;
  if (bodyDid !== expected && bodyDid !== columnAtomDid) {
    throw new WriteBoundaryError(
      DID_NAMESPACE,
      `body.atomDid ${bodyDid} != column ${columnAtomDid}`,
    );
  }
}

export function assertPropertyWriteBoundary(
  instance: Pick<
    PropertyAtomInstance,
    "entityType" | "entityId" | "parcelNodeId" | "atomDid"
  >,
): string {
  if (isParcelKeyedType(instance.entityType)) {
    assertCanonicalBinding(instance.entityId, "entityId");
    if (instance.parcelNodeId) {
      assertCanonicalBinding(instance.parcelNodeId, "parcelNodeId");
    }
  } else {
    const tokens = parseEntityIdTokens(instance.entityId);
    for (const token of tokens) {
      if (isKeySentinelToken(token)) {
        throw new WriteBoundaryError(
          KEY_SENTINEL,
          `entityId contains sentinel token '${token}': ${instance.entityId}`,
        );
      }
    }
  }
  const columnAtomDid = buildAtomDid(instance.entityType, instance.entityId).raw;
  assertDidNamespace(instance, columnAtomDid);
  return columnAtomDid;
}

export function expectedAppliesToCount(
  atoms: ReadonlyArray<Pick<PropertyAtomInstance, "entityType" | "parcelNodeId">>,
): number {
  let n = 0;
  for (const atom of atoms) {
    if (atom.entityType === "parcel-node") continue;
    if (!atom.parcelNodeId) continue;
    if (isCountyCoverageParcelNodeId(atom.parcelNodeId)) continue;
    n += 1;
  }
  return n;
}

export function assertEdgesNotStarved(
  atoms: ReadonlyArray<Pick<PropertyAtomInstance, "entityType" | "parcelNodeId">>,
  linksWritten: number,
): void {
  const expected = expectedAppliesToCount(atoms);
  if (expected > 0 && linksWritten !== expected) {
    throw new WriteBoundaryError(
      STARVED_EDGE,
      `writer produced ${linksWritten} applies-to links; body-derived expected ${expected}`,
    );
  }
}
