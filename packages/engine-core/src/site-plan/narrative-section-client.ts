import type { ParcelReportModel } from "./report-model.js";

/**
 * OPS-16 P-120 item 6 — hauska-engine's consuming side of the Feasibility
 * narrative generator.
 *
 * The server half is `POST /api/brokerage/v1/research/narrative-section` in
 * legacy-design-tools (PR #633), which runs the same `completeBriefingLlm`
 * machinery every other brief function uses. This module builds its request,
 * calls it, and turns the response into the `narrativeOverride` the PDF
 * emitter already accepts.
 *
 * The contract, read from the shipped route rather than from a description
 * of it:
 *
 *   request  { parcelNodeId, facts: Record<string, unknown>,
 *              courthouseDocuments?: [{ citation, excerpt }] }
 *   response { narrative, generatedBy, generatedAt }
 *
 * There is deliberately no `citedSections` field on the response. The server
 * asks the model to mark each sentence with the fact category it drew on, as
 * a `[category]` bracket marker, and the CALLER derives the cited set by
 * scanning the returned text for its own keys. That is the same post-hoc
 * text-scan convention the rest of this codebase uses, and it is the reason
 * the field is absent: a self-reported citation list is one the caller cannot
 * independently verify, so it is not accepted as evidence.
 *
 * Fail-closed posture. Every failure path returns `undefined`, which leaves
 * the caller on its complete deterministic skeleton. A missing narrative
 * never becomes an error the customer sees, and it never becomes a
 * half-written report either.
 */

/** Where to reach the narrative-section endpoint, and how to authenticate. */
export interface NarrativeSectionConfig {
  /** Origin or origin+prefix, e.g. `https://…/api/brokerage/v1`. */
  baseUrl: string;
  /**
   * `SERVICE_API_KEY`. Sent as `Authorization: Bearer <key>`, which
   * `extractBrokerageApiKey` reads first (it also accepts `X-Hauska-Key`;
   * bearer is the documented service path and takes precedence).
   */
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface NarrativeSectionOutcome {
  /** Shaped for `emitPdfFeasibility`'s existing `narrativeOverride`. */
  narrativeOverride: { text: string; generatedBy: string; generatedAt: string };
  /** Fact categories the narrative actually marked, derived by scanning. */
  citedSections: ReadonlyArray<string>;
  /** Categories offered to the model that it did not mark. */
  uncitedSections: ReadonlyArray<string>;
}

/**
 * Why no generated narrative was used. Always populated when the caller
 * falls back, so the skeleton is a declared degradation rather than a silent
 * one.
 */
export type NarrativeFallbackReason =
  | "not-configured"
  | "request-failed"
  | "http-error"
  | "malformed-response"
  | "empty-narrative"
  | "server-reported-no-llm-content"
  | "no-cited-sections";

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * The server's own last-resort string when the LLM returns nothing. It comes
 * back with `generatedBy: "rules-v1"` and is a one-line apology, not a
 * narrative. Accepting it would put that sentence in the customer's PDF AND
 * mark the report as carrying a generated narrative. Our deterministic
 * skeleton is a strictly better artifact, so this is treated as unavailable.
 */
const SERVER_NO_CONTENT_GENERATED_BY = "rules-v1";

/**
 * Build the per-category facts payload.
 *
 * Most sections are already `FeasibilityFactState<T>`, which IS the
 * `{ status: "present" | "absent", … }` shape the endpoint expects, so they
 * pass through untouched. Two sections are not fact-states and are wrapped
 * here, each on its own honest reading:
 *
 * - `jurisdiction` is present when a county is actually known. `cityLimitsStatus`
 *   and `etjStatus` ride along as the literal `"unresolved"` they are, so the
 *   model can say they are unresolved rather than guess a value.
 * - `hoa` is ABSENT unless a document is actually mounted. `searchStatus:
 *   "not-searched"` is the absence of a search, not a finding of no
 *   restrictions, and must never be handed to the model as a present fact.
 *
 * `terrain` is now itself `FeasibilityFactState`-shaped upstream (it depends
 * on the parcel's composed geometry, which can be absent — R2), so it passes
 * through untouched too, same as flood/parcelOwnership/etc.
 */
export function buildNarrativeFacts(model: ParcelReportModel): Record<string, unknown> {
  const jurisdictionKnown = model.facts.jurisdiction.countyFips !== null;
  const hoaCitation = model.facts.hoa.mountedDocumentCitation;

  return {
    jurisdiction: jurisdictionKnown
      ? { status: "present", ...model.facts.jurisdiction }
      : { status: "absent", reason: "No county could be resolved for this parcel." },
    parcelOwnership: model.facts.parcelOwnership,
    flood: model.facts.flood,
    specialDistricts: model.facts.specialDistricts,
    wellsPipelines: model.facts.wellsPipelines,
    terrain: model.facts.terrain,
    utilities: model.facts.utilities,
    hoa: hoaCitation
      ? { status: "present", mountedDocumentCitation: hoaCitation }
      : {
          status: "absent",
          reason:
            "Recorded restrictions and HOA documents have not been searched for this parcel.",
        },
    footprint: model.facts.footprint,
    dischargePoint: model.facts.dischargePoint,
  };
}

/**
 * Which categories the narrative marked, by scanning for `[key]`.
 *
 * Deliberately a scan of the text rather than a field the model filled in.
 * A model that claims to have cited `flood` while never mentioning it cannot
 * pass this; it has to actually emit the marker.
 */
export function deriveCitedSections(
  narrative: string,
  factKeys: ReadonlyArray<string>,
): { cited: string[]; uncited: string[] } {
  const cited: string[] = [];
  const uncited: string[] = [];
  for (const key of factKeys) {
    if (narrative.includes(`[${key}]`)) cited.push(key);
    else uncited.push(key);
  }
  return { cited, uncited };
}

/**
 * Call the narrative-section endpoint. Returns `undefined` on every failure
 * path, with the reason, so the caller can fall back to the deterministic
 * skeleton and SAY it did.
 */
export async function fetchFeasibilityNarrative(input: {
  model: ParcelReportModel;
  config: NarrativeSectionConfig;
  courthouseDocuments?: ReadonlyArray<{ citation: string; excerpt: string }>;
}): Promise<
  | { ok: true; outcome: NarrativeSectionOutcome }
  | { ok: false; reason: NarrativeFallbackReason; detail?: string }
> {
  const { model, config } = input;
  if (!config.baseUrl || !config.apiKey) {
    return { ok: false, reason: "not-configured" };
  }

  const facts = buildNarrativeFacts(model);
  const body = {
    parcelNodeId: model.parcelNodeId,
    facts,
    ...(input.courthouseDocuments?.length
      ? { courthouseDocuments: [...input.courthouseDocuments] }
      : {}),
  };

  const url = `${config.baseUrl.replace(/\/+$/, "")}/research/narrative-section`;
  const doFetch = config.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      reason: "request-failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (!res.ok) {
    return { ok: false, reason: "http-error", detail: `HTTP ${res.status}` };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (error) {
    return {
      ok: false,
      reason: "malformed-response",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const parsed = payload as {
    narrative?: unknown;
    generatedBy?: unknown;
    generatedAt?: unknown;
  } | null;
  if (
    !parsed ||
    typeof parsed.narrative !== "string" ||
    typeof parsed.generatedBy !== "string" ||
    typeof parsed.generatedAt !== "string"
  ) {
    return { ok: false, reason: "malformed-response", detail: "response shape did not match" };
  }

  const text = parsed.narrative.trim();
  if (!text) return { ok: false, reason: "empty-narrative" };

  // The server's own no-content path. See the constant's comment: our
  // skeleton beats its apology, and this must not read as a real narrative.
  if (parsed.generatedBy === SERVER_NO_CONTENT_GENERATED_BY) {
    return { ok: false, reason: "server-reported-no-llm-content" };
  }

  const { cited, uncited } = deriveCitedSections(text, Object.keys(facts));
  // A narrative that marked nothing cited nothing verifiable. Commitment #1
  // is that every output carries a reasoning chain and source citation, so an
  // unmarked wall of prose is refused in favour of the skeleton, which is
  // cited by construction.
  if (cited.length === 0) {
    return { ok: false, reason: "no-cited-sections" };
  }

  return {
    ok: true,
    outcome: {
      narrativeOverride: {
        text,
        generatedBy: parsed.generatedBy,
        generatedAt: parsed.generatedAt,
      },
      citedSections: cited,
      uncitedSections: uncited,
    },
  };
}
