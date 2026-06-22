/**
 * ICC Code Connect PoC demo instance — isolated Layer 1 partition.
 *
 * The Code Connect PoC demo ingests 2018 IBC + 2018 IPMC under a
 * synthetic tenant (`icc-model-code`) with `platform-internal`
 * accessPolicy. ICC normative text is deep-linked, not hosted; the
 * partition is wind-downable without affecting production city tenants.
 *
 * Gate-side usage views scope ICC-derived atoms by all three axes:
 *   1. `jurisdictionTenant === "icc-model-code"`
 *   2. `sourceAdapter === "icc-code-connect"`
 *   3. DID `localId` prefix `icc-model-code/` (did:hauska:<type>:icc-model-code/…)
 */

import type { AccessPolicy } from "@hauska-engine/atoms";
import { parseAtomDid } from "@hauska-engine/atoms";

import {
  ICC_MODEL_CODE_TENANT,
  type IccCodeConnectAdapter,
} from "../adapters/icc-code-connect/index.js";
import {
  IBC_2018_EDITION_LABEL,
  IBC_2018_TITLE_ID,
  IPMC_2018_EDITION_LABEL,
  IPMC_2018_TITLE_ID,
} from "../adapters/icc-code-connect/__fixtures__/irc-2021.js";

export { ICC_MODEL_CODE_TENANT };

/** Source adapter stamped on every ICC-derived atom. */
export const ICC_CODE_CONNECT_SOURCE_ADAPTER = "icc-code-connect" as const;

/**
 * ADR-017 access tier for ICC-derived atoms. `platform-internal` keeps
 * the PoC partition invisible to anonymous/public catalog surfaces and
 * limits retrieval to gate callers presenting `X-Hauska-Access-Tier:
 * platform-internal` (designated administrators / platform operators).
 */
export const ICC_MODEL_CODE_ACCESS_POLICY: AccessPolicy = "platform-internal";

/**
 * Human label for the jurisdiction-status row and operator dashboards.
 */
export const ICC_MODEL_CODE_JURISDICTION_NAME =
  "ICC Model Code Base (Code Connect PoC)";

/**
 * I-Code editions in scope for the Code Connect PoC demo dry-run.
 * Live ingest filters `discover()` to these titleIds.
 */
export const ICC_CODE_CONNECT_DEMO_TITLE_IDS = [
  IBC_2018_TITLE_ID,
  IPMC_2018_TITLE_ID,
] as const;

export type IccCodeConnectDemoTitleId =
  (typeof ICC_CODE_CONNECT_DEMO_TITLE_IDS)[number];

/** Edition metadata for the PoC demo scope. */
export const ICC_CODE_CONNECT_DEMO_EDITIONS: ReadonlyArray<{
  titleId: IccCodeConnectDemoTitleId;
  editionLabel: string;
  codeAbbrev: string;
  year: number;
}> = [
  {
    titleId: IBC_2018_TITLE_ID,
    editionLabel: IBC_2018_EDITION_LABEL,
    codeAbbrev: "IBC",
    year: 2018,
  },
  {
    titleId: IPMC_2018_TITLE_ID,
    editionLabel: IPMC_2018_EDITION_LABEL,
    codeAbbrev: "IPMC",
    year: 2018,
  },
];

/** DID localId prefix shared by every atom in the demo partition. */
export const ICC_MODEL_CODE_DID_LOCAL_ID_PREFIX = `${ICC_MODEL_CODE_TENANT}/`;

/**
 * Designated-Administrator model: only platform-internal gate credentials
 * may read or meter usage against the `icc-model-code` partition.
 * City-tenant credentials must not inherit access to ICC-derived atoms
 * through the shared model-code base until a production licensing decision
 * promotes the access tier.
 */
export const ICC_MODEL_CODE_ADMIN_ACCESS_TIERS: ReadonlyArray<AccessPolicy> = [
  "platform-internal",
];

export interface IccModelCodeAtomIdentity {
  jurisdictionTenant: string;
  sourceAdapter: string;
  entityId: string;
}

/** True when an atom belongs to the ICC Code Connect PoC partition. */
export function isIccModelCodeAtom(atom: IccModelCodeAtomIdentity): boolean {
  return (
    atom.jurisdictionTenant === ICC_MODEL_CODE_TENANT &&
    atom.sourceAdapter === ICC_CODE_CONNECT_SOURCE_ADAPTER &&
    atom.entityId.startsWith(ICC_MODEL_CODE_DID_LOCAL_ID_PREFIX)
  );
}

/** True when a DID resolves to the ICC Code Connect PoC partition. */
export function isIccModelCodeAtomDid(atomDid: string): boolean {
  try {
    const parsed = parseAtomDid(atomDid);
    return parsed.localId.startsWith(ICC_MODEL_CODE_DID_LOCAL_ID_PREFIX);
  } catch {
    return false;
  }
}

/** Filter `discover()` references to the PoC demo edition scope. */
export function filterDemoCodeReferences<
  T extends { sourceId: string },
>(references: ReadonlyArray<T>): T[] {
  const allowed = new Set<string>(ICC_CODE_CONNECT_DEMO_TITLE_IDS);
  return references.filter((ref) => allowed.has(ref.sourceId));
}

/** Resolve the adapter mode string for operator reports. */
export function iccAdapterModeReport(adapter: IccCodeConnectAdapter): string {
  return adapter.mode;
}
