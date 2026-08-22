/**
 * Wave C / P-55 new-write identity.
 *
 * Canonical parcel-keyed entity_id is {fips}:{integer} plus a non-sentinel
 * family suffix. StratMap decimal padding belongs in externalKeys.
 * :outside and :primary must not appear as entity_id tokens.
 * Special-district absence is {fips}:{integer}:sd:none (same discriminator
 * as footprint :footprint:none). Bare :sd is not minted.
 *
 * Atoms has no Postgres trigger (R-07 Q1a). This helper is the writer-path
 * stand-in for BP-WRITE-01. Bypass: COPY / raw SQL INSERT INTO atoms that
 * never calls mintParcelFactIdentity, assertCanonicalParcelEntityId, or
 * writePropertyAtomsBatch.
 */

import type { AtomLink } from "./atom-link.js";
import type { ParcelExternalKey, PropertyAtomInstance } from "./property-instances.js";

export const STRATMAP_PAD_SUFFIX = ".00000000";

const DECIMAL_PADDED_PROP = /^(\d+)\.\d+$/;
const FIPS = /^\d{5}$/;
const KEY_SENTINELS = new Set(["outside", "primary"]);
const COUNTY_COVERAGE_TOKEN = "_county_coverage";

const PADDED_SOURCE_CITATION =
  "StratMap decimal-padded parcel key alias of canonical {fips}:{integer}";
const RECEIVED_SOURCE_CITATION = "source parcel key as received at write";

export class ParcelEntityIdRejectedError extends Error {
  readonly code = "PARCEL_ENTITY_ID_REJECTED";
  constructor(entityId: string, reason: string) {
    super(`parcel entity_id rejected (${reason}): ${entityId}`);
    this.name = "ParcelEntityIdRejectedError";
  }
}

export interface MintedParcelFactIdentity {
  /** Canonical {fips}:{integer} or unchanged non-padded / coverage id. */
  parcelNodeId: string;
  /** entity_id actually persisted. */
  entityId: string;
  /** Source key(s) on the same object as entity_id (C3). */
  externalKeys: ReadonlyArray<ParcelExternalKey>;
  sourceParcelNodeId: string;
  paddedSource: boolean;
}

export function parseEntityIdTokens(entityId: string): string[] {
  return entityId.split(":").filter((t) => t.length > 0);
}

export function isCountyCoverageParcelNodeId(parcelNodeId: string): boolean {
  const tokens = parseEntityIdTokens(parcelNodeId);
  return tokens.length >= 2 && tokens[1] === COUNTY_COVERAGE_TOKEN;
}

export function isKeySentinelToken(token: string): boolean {
  return KEY_SENTINELS.has(token);
}

/**
 * Reject decimal-padded parcel grammar and :outside / :primary tokens.
 * County-coverage rows and non-FIPS identities are not this helper's
 * grammar; they pass unless they carry a named sentinel.
 */
export function assertCanonicalParcelEntityId(entityId: string): void {
  const tokens = parseEntityIdTokens(entityId);
  for (const token of tokens) {
    if (isKeySentinelToken(token)) {
      throw new ParcelEntityIdRejectedError(
        entityId,
        `sentinel token '${token}' is forbidden in entity_id`,
      );
    }
  }
  if (
    tokens.length >= 2 &&
    FIPS.test(tokens[0]!) &&
    tokens[1] !== COUNTY_COVERAGE_TOKEN &&
    DECIMAL_PADDED_PROP.test(tokens[1]!)
  ) {
    throw new ParcelEntityIdRejectedError(
      entityId,
      "decimal-padded parcel grammar is forbidden on entity_id; put it in externalKeys",
    );
  }
}

function sourceKeyFor(
  sourceParcelNodeId: string,
  paddedSource: boolean,
): ParcelExternalKey {
  return {
    keyKind: "prop_id",
    keyValue: sourceParcelNodeId,
    sourceCitation: paddedSource ? PADDED_SOURCE_CITATION : RECEIVED_SOURCE_CITATION,
  };
}

/**
 * Canonicalize a caller parcelNodeId. Padded StratMap form becomes
 * {fips}:{integer}; the received key is always recorded in externalKeys
 * for parcel-keyed (non-coverage) writes so C3 cannot drop the source key.
 */
export function resolveCanonicalParcelKey(parcelNodeId: string): MintedParcelFactIdentity {
  const tokens = parseEntityIdTokens(parcelNodeId);
  if (tokens.length < 2 || !FIPS.test(tokens[0]!)) {
    throw new ParcelEntityIdRejectedError(
      parcelNodeId,
      "parcelNodeId must be {fips}:{token}",
    );
  }
  const fips = tokens[0]!;
  const prop = tokens[1]!;
  if (prop === COUNTY_COVERAGE_TOKEN) {
    const coverageId = `${fips}:${COUNTY_COVERAGE_TOKEN}`;
    return {
      parcelNodeId: coverageId,
      entityId: coverageId,
      externalKeys: [],
      sourceParcelNodeId: parcelNodeId,
      paddedSource: false,
    };
  }
  const paddedMatch = DECIMAL_PADDED_PROP.exec(prop);
  const canonicalProp = paddedMatch ? paddedMatch[1]! : prop;
  const canonical = `${fips}:${canonicalProp}`;
  const paddedSource = paddedMatch !== null;
  const identity: MintedParcelFactIdentity = {
    parcelNodeId: canonical,
    entityId: canonical,
    externalKeys: [sourceKeyFor(paddedSource ? `${fips}:${prop}` : canonical, paddedSource)],
    sourceParcelNodeId: parcelNodeId,
    paddedSource,
  };
  assertCanonicalParcelEntityId(identity.entityId);
  return identity;
}

/**
 * Mint a parcel-keyed fact identity. Suffixes are family discriminators
 * (sd, footprint, tax year, well key). Sentinels in suffixes throw.
 */
export function mintParcelFactIdentity(
  sourceParcelNodeId: string,
  suffixes: ReadonlyArray<string> = [],
): MintedParcelFactIdentity {
  for (const suffix of suffixes) {
    if (isKeySentinelToken(suffix)) {
      throw new ParcelEntityIdRejectedError(
        `${sourceParcelNodeId}:${suffixes.join(":")}`,
        `sentinel token '${suffix}' is forbidden in entity_id; move it to a body field`,
      );
    }
  }
  const base = resolveCanonicalParcelKey(sourceParcelNodeId);
  const entityId =
    suffixes.length === 0 ? base.parcelNodeId : `${base.parcelNodeId}:${suffixes.join(":")}`;
  assertCanonicalParcelEntityId(entityId);
  return {
    ...base,
    entityId,
  };
}

export function specialDistrictPresentEntityId(
  sourceParcelNodeId: string,
  districtId: string,
): MintedParcelFactIdentity {
  return mintParcelFactIdentity(sourceParcelNodeId, ["sd", districtId]);
}

export function specialDistrictAbsenceEntityId(
  sourceParcelNodeId: string,
): MintedParcelFactIdentity {
  return mintParcelFactIdentity(sourceParcelNodeId, ["sd", "none"]);
}

export function buildingFootprintPresentEntityId(
  sourceParcelNodeId: string,
  footprintId: string,
): MintedParcelFactIdentity {
  if (footprintId === "primary") {
    return mintParcelFactIdentity(sourceParcelNodeId, ["footprint"]);
  }
  return mintParcelFactIdentity(sourceParcelNodeId, ["footprint", footprintId]);
}

export function buildingFootprintAbsenceEntityId(
  sourceParcelNodeId: string,
): MintedParcelFactIdentity {
  return mintParcelFactIdentity(sourceParcelNodeId, ["footprint", "none"]);
}

export function appliesToParcelLink(
  entityType: string,
  entityId: string,
  canonicalParcelNodeId: string,
): AtomLink {
  return {
    fromEntityType: entityType,
    fromEntityId: entityId,
    toEntityType: "parcel-node",
    toEntityId: canonicalParcelNodeId,
    linkType: "applies-to",
  };
}

/**
 * Derive applies-to from a built property atom. body.parcelNodeId is the
 * join hint, not the edge — this function is what must be persisted.
 * Returns null for identity nodes and county-coverage rows.
 * road-node is not a PropertyAtomInstance (StoredAtomInstance only), so
 * it cannot reach this helper and must not be compared here (TS2367).
 */
export function appliesToLinkFromPropertyAtom(
  atom: Pick<PropertyAtomInstance, "entityType" | "entityId" | "parcelNodeId">,
): AtomLink | null {
  if (atom.entityType === "parcel-node") {
    return null;
  }
  if (!atom.parcelNodeId || isCountyCoverageParcelNodeId(atom.parcelNodeId)) {
    return null;
  }
  const canonical = resolveCanonicalParcelKey(atom.parcelNodeId).parcelNodeId;
  return appliesToParcelLink(atom.entityType, atom.entityId, canonical);
}

export function appliesToLinksFromPropertyAtoms(
  atoms: ReadonlyArray<Pick<PropertyAtomInstance, "entityType" | "entityId" | "parcelNodeId">>,
): AtomLink[] {
  const out: AtomLink[] = [];
  for (const atom of atoms) {
    const link = appliesToLinkFromPropertyAtom(atom);
    if (link) out.push(link);
  }
  return out;
}

/**
 * A write that skips the helper can still mint the old shape. Named so
 * tests can demonstrate the bypass without touching the store.
 */
export function mintOldShapeIfHelperSkipped(entityId: string): string {
  return entityId;
}

/**
 * Rewrite a built parcel-keyed atom onto canonical identity. Used by
 * writers whose observation still carries the source parcelNodeId.
 */
export function finalizeParcelFactAtom<
  T extends {
    parcelNodeId: string;
    entityId: string;
    externalKeys?: ReadonlyArray<ParcelExternalKey>;
  },
>(atom: T, suffixes: ReadonlyArray<string> = []): T {
  const id = mintParcelFactIdentity(atom.parcelNodeId, suffixes);
  return {
    ...atom,
    parcelNodeId: id.parcelNodeId,
    entityId: id.entityId,
    ...(id.externalKeys.length > 0 ? { externalKeys: id.externalKeys } : {}),
  };
}
