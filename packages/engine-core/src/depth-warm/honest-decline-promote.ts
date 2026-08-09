/**
 * R27 / force-overwrite — supersede stale depth-warm promotes with an honest
 * verify-fail decline (recipe-version stamped, NO depthWarmPromotion marker).
 *
 * 1.15.0+: declines emit contract-shaped `absence` + `verifiedAbsence`. Legacy
 * engine-extension fields `warmVerifyDecline` / `warmVerifyDeclineCode` are
 * STILL written so old readers keep working, and STILL read by
 * {@link resolveEnvelopeDeclineCode} when stored rows predate the contract
 * shape (no store rewrite in this lane).
 */
import type { StoragePort } from "@hauska-engine/storage";
import {
  BUILDABLE_ENVELOPE_DERIVATION_METHOD,
  buildAtomDid,
  type BuildableEnvelopeAtomInstance,
} from "@hauska-engine/atoms";
import { createWidthedConfidence } from "@empressaio/atom-contract/read-contract";
import {
  toBuildableEnvelopeAbsenceKind,
  type BuildableEnvelopeAbsenceKind,
} from "@empressaio/atom-contract/property";
import {
  buildPropertyReadContract,
  contentHashExcludingProvenance,
  propertyEntityId,
} from "../property-reasoning/confidence.js";
import type { JurisdictionDescriptor } from "../property-reasoning/types.js";
import { writePropertyAtomIfEnabled } from "../property-reasoning/write-property-atom.js";
import { RECIPE_VERSION } from "./types.js";

export interface HonestVerifyDeclineInput {
  parcelNodeId: string;
  zoningFactAtomDid: string;
  descriptor: JurisdictionDescriptor;
  verifyReasons: string[];
  declineCode: string;
  extractedAt?: string;
  /** Optional override for verifiedAbsence.provenanceScope (defaults applied). */
  provenanceScope?: ReadonlyArray<string>;
}

/**
 * Engine-extension fields carried on a persisted honest-decline envelope atom.
 * `warmVerifyDecline*` remain for dual-read of pre-1.15.0 store rows; new
 * writers also set contract `absence` / `verifiedAbsence`.
 */
export type HonestVerifyDeclineAtom = BuildableEnvelopeAtomInstance & {
  recipeVersion?: string;
  /** @deprecated Prefer `absence.reason`; kept for dual-read of legacy rows. */
  warmVerifyDecline?: string;
  /** @deprecated Prefer `absence.kind`; kept for dual-read of legacy rows. */
  warmVerifyDeclineCode?: string;
};

/** Default evaluation sources cited on contract verifiedAbsence for declines. */
export const ENVELOPE_DECLINE_PROVENANCE_SCOPE_DEFAULT = [
  "depth-warm-verify",
  "txgio-parcel",
  "zoning-fact",
] as const;

/**
 * Resolve the named decline code from a stored envelope body.
 * Prefer contract `absence.kind`; fall back to legacy `warmVerifyDeclineCode`.
 */
export function resolveEnvelopeDeclineCode(body: {
  absence?: { kind?: string } | null;
  warmVerifyDeclineCode?: string | null;
} | null | undefined): string | null {
  if (!body) return null;
  const kind = body.absence?.kind;
  if (typeof kind === "string" && kind.trim().length > 0) return kind.trim();
  const legacy = body.warmVerifyDeclineCode;
  if (typeof legacy === "string" && legacy.trim().length > 0) return legacy.trim();
  return null;
}

/**
 * Resolve the human decline reason from a stored envelope body.
 * Prefer contract `absence.reason`; fall back to legacy `warmVerifyDecline`
 * then `outcome.reason` on no-buildable-area.
 */
export function resolveEnvelopeDeclineReason(body: {
  absence?: { reason?: string } | null;
  warmVerifyDecline?: string | null;
  outcome?: { kind?: string; reason?: string } | null;
} | null | undefined): string | null {
  if (!body) return null;
  const reason = body.absence?.reason;
  if (typeof reason === "string" && reason.trim().length > 0) return reason.trim();
  const legacy = body.warmVerifyDecline;
  if (typeof legacy === "string" && legacy.trim().length > 0) return legacy.trim();
  if (
    body.outcome?.kind === "no-buildable-area" &&
    typeof body.outcome.reason === "string" &&
    body.outcome.reason.trim().length > 0
  ) {
    return body.outcome.reason.trim();
  }
  return null;
}

/**
 * Build (without writing) a no-buildable-area envelope decline atom in the
 * R27 persisted-decline shape. Pure — callers own the write. Extracted so
 * both the depth-warm force-overwrite path (below) and other honest-decline
 * producers (e.g. the unzoned-county cascade bake) mint the SAME shape.
 *
 * Contract fields (1.15.0+): `absence` + `verifiedAbsence`.
 * Legacy dual-write: `warmVerifyDecline` / `warmVerifyDeclineCode` so
 * pre-migration readers and JSON path filters keep working until a
 * dedicated store rewrite lane lands.
 */
export function buildHonestVerifyDeclineAtom(
  input: HonestVerifyDeclineInput,
): HonestVerifyDeclineAtom {
  const extractedAt = input.extractedAt ?? new Date().toISOString();
  const version = 1;
  const entityId = propertyEntityId(input.parcelNodeId, "envelope", version);
  const atomDid = buildAtomDid("buildable-envelope", entityId).raw;
  const declineReason =
    input.verifyReasons.slice(0, 3).join("; ") ||
    "Mechanical warm verify failed — honest decline.";
  const absenceKind: BuildableEnvelopeAbsenceKind = toBuildableEnvelopeAbsenceKind(
    input.declineCode,
  );
  const provenanceScope = [
    ...(input.provenanceScope ?? ENVELOPE_DECLINE_PROVENANCE_SCOPE_DEFAULT),
  ];

  const instance: HonestVerifyDeclineAtom = {
    entityType: "buildable-envelope",
    atomDid,
    entityId,
    jurisdictionTenant: input.descriptor.jurisdictionTenant,
    parcelNodeId: input.parcelNodeId,
    fetchedAt: extractedAt,
    extractedAt,
    sourceAdapter: input.descriptor.sourceAdapter,
    sourceUrl: input.descriptor.sourceUrl ?? "",
    sourceCitation: "depth-warm-verify-decline",
    accessPolicy: input.descriptor.defaultAccessPolicy,
    atomTier: "data",
    status: "active",
    versionStamp: `${input.parcelNodeId}:buildable-envelope-decline:${version}:${extractedAt}`,
    outcome: {
      kind: "no-buildable-area",
      reason: declineReason,
    },
    absence: {
      kind: absenceKind,
      reason: declineReason,
    },
    verifiedAbsence: {
      evaluated: true,
      provenanceScope:
        provenanceScope.length > 0
          ? provenanceScope
          : [...ENVELOPE_DECLINE_PROVENANCE_SCOPE_DEFAULT],
    },
    reasoningChain: {
      reasoningKind: "derived",
      derivationMethod: BUILDABLE_ENVELOPE_DERIVATION_METHOD,
      inputAtomRefs: [
        {
          atomDid: input.zoningFactAtomDid,
          role: "fact",
          entityType: "zoning-fact",
        },
      ],
    },
    readContract: buildPropertyReadContract({
      asserted: createWidthedConfidence({
        estimate: 0.5,
        n: 0,
        intervalWidth: 0.2,
        provenance: "asserted",
      }),
      calibrated: null,
      consequence: {
        kind: "property-risk",
        stratum: "elevated",
        basis: "no-buildable-area",
        assertedAt: extractedAt,
      },
      assembledAt: extractedAt,
    }),
    contentHash: "",
    recipeVersion: RECIPE_VERSION,
    // Dual-write legacy fields — DO NOT remove until store rewrite completes.
    warmVerifyDecline: declineReason,
    warmVerifyDeclineCode: input.declineCode,
  };
  instance.contentHash = contentHashExcludingProvenance(instance);
  return instance;
}

/**
 * Write a no-buildable-area envelope that supersedes stale promoted atoms.
 * Omits depthWarmPromotion so cert roster excludes it; carries recipeVersion.
 */
export async function promoteHonestVerifyDecline(
  storage: StoragePort,
  input: HonestVerifyDeclineInput,
): Promise<{ buildableEnvelopeAtomDid: string } | null> {
  const instance = buildHonestVerifyDeclineAtom(input);
  const result = await writePropertyAtomIfEnabled(storage, instance);
  if (!result) return null;
  return { buildableEnvelopeAtomDid: result.atomDid };
}

/** Classify verify-fail reasons into a bucket key for STEP 0 diagnosis. */
export function bucketVerifyFailReasons(reasons: string[]): string {
  const text = reasons.join(" ").toLowerCase();
  if (text.includes("superseded") || text.includes("absent from county cadastral")) {
    return "superseded-prop-id";
  }
  if (text.includes("inset ring is null") || text.includes("marked empty")) {
    return "null-inset";
  }
  if (text.includes("classification") && text.includes("osm")) {
    return "road-classification-mismatch";
  }
  if (text.includes("orientation") || text.includes("front")) {
    return "front-orientation";
  }
  if (text.includes("facesanswer") || text.includes("situs")) {
    return "faces-answer";
  }
  if (text.includes("r32")) {
    return "r32-per-edge-inset";
  }
  if (text.includes("geometry") || text.includes("ring")) {
    return "geometry";
  }
  if (text.includes("setback")) {
    return "setback-edge-distance";
  }
  return "other-verify-fail";
}
