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
  type BuildableEnvelopeZeroProof,
  type EnvelopeHonestOutcome,
} from "@hauska-engine/atoms";
import { createWidthedConfidence } from "@empressaio/atom-contract/read-contract";
import {
  toBuildableEnvelopeAbsenceKind,
  type BuildableEnvelopeAbsenceKind,
} from "@empressaio/atom-contract/property";
import {
  assertEnvelopeOutcomeIsHonest,
  outcomeForEnvelopeDecline,
} from "../property-reasoning/envelope-outcome-honesty.js";
import {
  buildPropertyReadContract,
  contentHashExcludingProvenance,
  propertyEntityId,
} from "../property-reasoning/confidence.js";
import type { JurisdictionDescriptor } from "../property-reasoning/types.js";
import { writePropertyAtomIfEnabled } from "../property-reasoning/write-property-atom.js";
import { promoteTableBackedSetbackIfAbsent } from "../property-reasoning/table-backed-setback-from-zoning.js";
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
  /** When set with cityKey + countyFips, also mint table-backed setback if absent. */
  district?: string;
  cityKey?: string;
  countyFips?: string;
  /**
   * P-263 — a computed, verified zero, when THIS decline is a completed
   * computation whose result was zero (setbacks consuming the lot). Present:
   * the outcome is `no-buildable-area` and carries the proof. Absent (the
   * normal case for a decline): the outcome is `not-applicable` for an unzoned
   * cohort and `provisional-front-edge` otherwise, because a decline that ran
   * no computation may not claim a zero.
   */
  zero?: BuildableEnvelopeZeroProof;
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

  /**
   * P-263 — the OUTCOME is decided by whether this decline computed a zero,
   * not by the fact that it is a decline.
   *
   * Before P-263 this line read `outcome: { kind: "no-buildable-area", reason }`
   * unconditionally, which is how the unzoned cascade and the not-yet-onboarded
   * breadth cohort (362,643 of the six counties' 490,185) came to assert a
   * computed zero — and how the serving facet came to print "Setbacks consume
   * the lot" about land no setback derivation was attempted on.
   *
   * With a zero proof: the claim, carrying its computation.
   * Without one: `not-applicable` when the reason names an unzoned cohort (no
   * ordinance reaches the parcel), `provisional-front-edge` otherwise (a
   * pending derivation — the ledger apply decides what the cell becomes).
   */
  const outcome: EnvelopeHonestOutcome = input.zero
    ? { kind: "no-buildable-area", reason: declineReason, zero: input.zero }
    : outcomeForEnvelopeDecline({
        declineCode: input.declineCode,
        reason: declineReason,
      });
  assertEnvelopeOutcomeIsHonest(outcome, {
    writer: "buildHonestVerifyDeclineAtom",
    parcelNodeId: input.parcelNodeId,
  });

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
    outcome,
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

  const district = input.district?.trim();
  const cityKey = input.cityKey?.trim();
  const countyFips = input.countyFips?.trim();
  if (district && cityKey && countyFips) {
    await promoteTableBackedSetbackIfAbsent(storage, {
      parcelNodeId: input.parcelNodeId,
      countyFips,
      district,
      cityKey,
      zoningFactAtomDid: input.zoningFactAtomDid,
      extractedAt: input.extractedAt,
    });
  }

  return { buildableEnvelopeAtomDid: result.atomDid };
}

/**
 * The explicit sink for a verify failure this taxonomy cannot name. P-264
 * requires an unclassified bucket that is REACHED, not inferred: a failure
 * that no known class claims must land here visibly rather than be absorbed
 * into the nearest-looking named class.
 */
export const UNCLASSIFIED_VERIFY_FAIL_BUCKET = "unclassified-verify-fail";

/**
 * Road-NAME parity bucket. Deliberately distinct from `road-classification-
 * mismatch` (road CLASS, from the roadClassification gate) and from
 * `front-orientation` (which edge bears the front, from the frontOrientation
 * gate). A-177 governs whether the street-name dictionary and the road-class
 * rules move earlier in the programme, and that call cannot be made if the two
 * are reported as one number.
 */
export const ROAD_NAME_MISMATCH_BUCKET = "road-name-mismatch";

export interface VerifyFailGateSet {
  geometry?: { reasons?: readonly string[] } | null;
  roadClassification?: { reasons?: readonly string[] } | null;
  setbackEdgeDistance?: { reasons?: readonly string[] } | null;
  frontOrientation?: { reasons?: readonly string[] } | null;
  r32PerEdgeInset?: { reasons?: readonly string[] } | null;
  facesAnswer?: { reasons?: readonly string[] } | null;
}

/**
 * Gate -> bucket. This is the ONE mapping from a mechanical gate to its
 * failure class; every caller that has the structured gates must come here
 * rather than sniffling prose.
 */
const VERIFY_FAIL_GATE_BUCKETS: ReadonlyArray<
  readonly [keyof VerifyFailGateSet, string]
> = [
  // Road-NAME parity FIRST. The facesAnswer reason interpolates the resolved
  // street name as a value, so a parcel facing "Front Street" contains the
  // literal substring "front"; any prose cascade that tested `front` before
  // this gate reported that parcel as an orientation failure.
  ["facesAnswer", ROAD_NAME_MISMATCH_BUCKET],
  ["roadClassification", "road-classification-mismatch"],
  ["frontOrientation", "front-orientation"],
  ["setbackEdgeDistance", "setback-edge-distance"],
  ["r32PerEdgeInset", "r32-per-edge-inset"],
  ["geometry", "geometry"],
];

/**
 * P-264: map verify-fail GATES to failure classes by gate identity.
 *
 * The batch runner previously flattened all six gates' reason strings into one
 * list and substring-sniffed them (bucketVerifyFailReasons). Flattening
 * destroyed the only information that actually identifies the failure — which
 * gate produced it — and two defects followed:
 *
 *   1. ROAD-NAME THEFT: a road-NAME mismatch on a street whose name contains
 *      "front"/"frontage" was bucketed as "front-orientation", hiding it.
 *   2. OVER-BROAD ORIENTATION: any reason mentioning a front edge in prose,
 *      including per-edge setback rows ("...for role front..."), also landed in
 *      "front-orientation".
 *
 * Keying on the gate removes both: no substring inference, and no interpolated
 * value ever reaches the decision. Returns EVERY failing gate's class, because
 * a parcel can legitimately fail both road-name and road-class, and a residual
 * that silently kept only the first would under-report one of them.
 */
export function verifyFailGateBuckets(gates: VerifyFailGateSet): string[] {
  const buckets: string[] = [];
  const source = (gates ?? {}) as Record<
    string,
    { reasons?: readonly string[] } | null | undefined
  >;
  for (const [gate, bucket] of VERIFY_FAIL_GATE_BUCKETS) {
    const reasons = source[gate]?.reasons;
    if (Array.isArray(reasons) && reasons.length > 0) buckets.push(bucket);
  }
  // A gate this taxonomy does not recognise, but which reported reasons, is an
  // unattributable failure. It is surfaced as unclassified rather than dropped:
  // a silently-ignored failure mode is the one outcome the residual must never
  // produce, because it makes the total look complete while hiding a class.
  const known = new Set<string>(VERIFY_FAIL_GATE_BUCKETS.map(([gate]) => gate as string));
  const unknownFailed = Object.entries(source).some(
    ([key, value]) =>
      !known.has(key) && Array.isArray(value?.reasons) && value!.reasons!.length > 0,
  );
  if (unknownFailed) buckets.push(UNCLASSIFIED_VERIFY_FAIL_BUCKET);
  return buckets;
}

/**
 * Single-bucket convenience over verifyFailGateBuckets, for callers whose
 * contract carries one bucket per parcel (e.g. recordRefusedParcel). Priority
 * is the table order above; road-NAME is therefore preferred over the classes
 * below it. An empty failure set is UNCLASSIFIED, never a named class.
 */
export function bucketVerifyFailGates(gates: VerifyFailGateSet): string {
  return verifyFailGateBuckets(gates)[0] ?? UNCLASSIFIED_VERIFY_FAIL_BUCKET;
}

/**
 * Classify verify-fail REASON STRINGS into a bucket key for STEP 0 diagnosis.
 *
 * Prose fallback for callers that hold only strings, where gate identity is
 * already lost. Prefer bucketVerifyFailGates whenever the structured gates are
 * in hand — this function can only guess.
 *
 * ORDER IS LOAD-BEARING: the road-NAME test runs before the orientation test.
 * The facesAnswer reason is `facesAnswer: situs "X" != road "Y" (...)`, which
 * contains neither "orientation" nor a literal "front" — but "Y", the resolved
 * road name, is interpolated as a value and may itself be "Front Street". With
 * the orientation test first, that row was claimed as "front-orientation" and
 * the road-name failure was invisible.
 */
export function bucketVerifyFailReasons(reasons: string[]): string {
  const text = reasons.join(" ").toLowerCase();
  if (text.includes("superseded") || text.includes("absent from county cadastral")) {
    return "superseded-prop-id";
  }
  if (text.includes("inset ring is null") || text.includes("marked empty")) {
    return "null-inset";
  }
  if (text.includes("facesanswer")) {
    return ROAD_NAME_MISMATCH_BUCKET;
  }
  if (text.includes("classification") && text.includes("osm")) {
    return "road-classification-mismatch";
  }
  if (text.includes("orientation") || text.includes("front")) {
    return "front-orientation";
  }
  if (text.includes("situs")) {
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
  return UNCLASSIFIED_VERIFY_FAIL_BUCKET;
}
