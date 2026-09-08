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
  // In-process generation (2026-09-08) added its own reasons. They are part
  // of this union rather than cast into it: a cast would let a new failure
  // mode reach the atom as an unlisted string and nothing would notice.
  | "not-requested"
  | "no-api-key"
  | "no-citations"
  | "llm-disabled"
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
  // THE LDT CONTRACT. Nine families, exactly what
  // `/research/narrative-section` was built and tuned for.
  //
  // Do not widen this. It was widened on 2026-09-08 and it broke the service
  // path in production: the wider input made cortex-api's generation slower,
  // the client's 20s timeout tripped, and the narrative regressed to the
  // deterministic skeleton on parcels that had been working. Caught on the
  // canary — Caldwell 48055:20478 failed 3/3 with `request-failed` while the
  // serving revision produced a real narrative for the same parcel in 17s.
  //
  // The wide payload belongs to IN-PROCESS generation, which is ours to make
  // slower. `buildFullNarrativeFacts` carries it. Changing the shape of
  // another service's request is that service's decision, not this lane's.
  return buildLdtNarrativeFacts(model);
}

function buildLdtNarrativeFacts(model: ParcelReportModel): Record<string, unknown> {
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

    // ── Added 2026-09-08. Everything below was ABSENT from this payload. ──
    // The narrative was being asked to reason over a report it could only
    // see half of, which is why it never discussed the flood study or the
    // terrain: neither was sent. Nine families went out, and geometry, the
    // drainage study, all five PR #404 families and the package layer did
    // not.
    //
    // Each is PROJECTED, never spread. `model.drainage.study` carries
    // catchment GeoJSON, traced flow-line GeoJSON and a gradient raster;
    // spreading it would push megabytes of coordinates at a language model
    // that cannot use them, and bill for every token. The summary numbers
    // are the part a narrative can reason from.
    geometry:
      model.geometry.status === "present"
        ? {
            status: "present",
            zoningDistrict: model.geometry.model.summary.zoningDistrict ?? null,
            lotAreaSqFt: model.geometry.model.summary.lotAreaSqFt,
            buildableAreaSqFt: model.geometry.model.summary.buildableAreaSqFt,
            buildableAreaNote: model.geometry.model.summary.buildableAreaHonestNote ?? null,
            setbacks: model.geometry.model.setback.honestAbsence
              ? { status: "absent", reason: model.geometry.model.setback.honestAbsenceReason ?? null }
              : {
                  status: "present",
                  frontFt: model.geometry.model.setback.front,
                  sideFt: model.geometry.model.setback.side,
                  rearFt: model.geometry.model.setback.rear,
                  display: model.geometry.model.setback.displayLine,
                },
          }
        : { status: "absent", reason: model.geometry.reason },
    topography:
      model.geometry.status === "present"
        ? {
            status: "present",
            elevationRangeMeters: model.geometry.model.summary.elevationRangeMeters,
            reliefMeters:
              model.geometry.model.summary.elevationRangeMeters.max -
              model.geometry.model.summary.elevationRangeMeters.min,
            verticalDatum: model.geometry.model.summary.verticalDatumSummary,
            contourIntervalMeters: model.geometry.model.contourIntervalMeters,
          }
        : { status: "absent", reason: model.geometry.reason },
    drainageStudy:
      model.drainage.status === "present"
        ? {
            status: "present",
            catchmentAreaSqFt: model.drainage.study.stats.catchmentAreaSqFt,
            pondedAreaSqFt: model.drainage.study.stats.pondedAreaSqFt ?? null,
            flowExitCount: model.drainage.study.stats.flowExitCount,
            designStormInches: model.drainage.study.rainfallDepthInches,
            rainfallSource: model.drainage.study.rainfallSource,
            demResolutionMeters: model.drainage.study.demProvenance.resolutionMeters,
            honestEmptyReason: model.drainage.study.honestEmpty?.reason ?? null,
            generatedAt: model.drainage.study.generatedAt,
          }
        : { status: "absent", reason: model.drainage.reason },
    floodplainAcreage: model.facts.floodplainAcreage,
    firmPanel: model.facts.firmPanel,
    soil: model.facts.soil,
    electricProvider: model.facts.electricProvider,
    gasProvider: model.facts.gasProvider,
    verdict: model.package.verdict,
    openItems: model.package.openItems.map((i) => ({
      section: i.section,
      action: i.actionSentence,
    })),
    dataQualityNotes: model.package.dataQuality.supersededNotes,
  };
}


/**
 * The WIDE payload: every fact family, plus the composed sub-models the
 * families do not cover. Used ONLY by in-process generation.
 *
 * Kept separate from the LDT contract above because widening that one broke
 * it in production. This one we own end to end, so it can afford to be
 * expensive.
 *
 * Each addition is PROJECTED, never spread. `model.drainage.study` carries
 * catchment GeoJSON, traced flow-line GeoJSON and a gradient raster;
 * spreading it would push megabytes of coordinates at a language model that
 * cannot use them, and bill for every token.
 */
export function buildFullNarrativeFacts(model: ParcelReportModel): Record<string, unknown> {
  return {
    ...buildLdtNarrativeFacts(model),
    // ── Added 2026-09-08. Everything below was ABSENT from this payload. ──
    // The narrative was being asked to reason over a report it could only
    // see half of, which is why it never discussed the flood study or the
    // terrain: neither was sent. Nine families went out, and geometry, the
    // drainage study, all five PR #404 families and the package layer did
    // not.
    //
    // Each is PROJECTED, never spread. `model.drainage.study` carries
    // catchment GeoJSON, traced flow-line GeoJSON and a gradient raster;
    // spreading it would push megabytes of coordinates at a language model
    // that cannot use them, and bill for every token. The summary numbers
    // are the part a narrative can reason from.
    geometry:
      model.geometry.status === "present"
        ? {
            status: "present",
            zoningDistrict: model.geometry.model.summary.zoningDistrict ?? null,
            lotAreaSqFt: model.geometry.model.summary.lotAreaSqFt,
            buildableAreaSqFt: model.geometry.model.summary.buildableAreaSqFt,
            buildableAreaNote: model.geometry.model.summary.buildableAreaHonestNote ?? null,
            setbacks: model.geometry.model.setback.honestAbsence
              ? { status: "absent", reason: model.geometry.model.setback.honestAbsenceReason ?? null }
              : {
                  status: "present",
                  frontFt: model.geometry.model.setback.front,
                  sideFt: model.geometry.model.setback.side,
                  rearFt: model.geometry.model.setback.rear,
                  display: model.geometry.model.setback.displayLine,
                },
          }
        : { status: "absent", reason: model.geometry.reason },
    topography:
      model.geometry.status === "present"
        ? {
            status: "present",
            elevationRangeMeters: model.geometry.model.summary.elevationRangeMeters,
            reliefMeters:
              model.geometry.model.summary.elevationRangeMeters.max -
              model.geometry.model.summary.elevationRangeMeters.min,
            verticalDatum: model.geometry.model.summary.verticalDatumSummary,
            contourIntervalMeters: model.geometry.model.contourIntervalMeters,
          }
        : { status: "absent", reason: model.geometry.reason },
    drainageStudy:
      model.drainage.status === "present"
        ? {
            status: "present",
            catchmentAreaSqFt: model.drainage.study.stats.catchmentAreaSqFt,
            pondedAreaSqFt: model.drainage.study.stats.pondedAreaSqFt ?? null,
            flowExitCount: model.drainage.study.stats.flowExitCount,
            designStormInches: model.drainage.study.rainfallDepthInches,
            rainfallSource: model.drainage.study.rainfallSource,
            demResolutionMeters: model.drainage.study.demProvenance.resolutionMeters,
            honestEmptyReason: model.drainage.study.honestEmpty?.reason ?? null,
            generatedAt: model.drainage.study.generatedAt,
          }
        : { status: "absent", reason: model.drainage.reason },
    floodplainAcreage: model.facts.floodplainAcreage,
    firmPanel: model.facts.firmPanel,
    soil: model.facts.soil,
    electricProvider: model.facts.electricProvider,
    gasProvider: model.facts.gasProvider,
    verdict: model.package.verdict,
    openItems: model.package.openItems.map((i) => ({
      section: i.section,
      action: i.actionSentence,
    })),
    dataQualityNotes: model.package.dataQuality.supersededNotes,
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

  // Duration is emitted on EVERY outcome, successes included.
  //
  // Raised by doc-repo-79 2026-09-08, and the reasoning is the point: the
  // only latency anyone could see was the whole feasibility request, which
  // ranges 20.2s to 41.0s across counties on identical code. Inside that
  // envelope a 3s narrative call and an 18s one are indistinguishable, and an
  // 18s one passes today and fails on any slower day against this client's
  // 20s timeout. A measurement that cannot tell "fine" from "about to fail"
  // is not a measurement.
  //
  // Logging only failures would not fix it: the failures are the cases where
  // the duration is already known to be 20s. The distribution of the
  // SUCCESSES is what says whether the timeout has headroom.
  const startedAt = Date.now();
  const emit = (outcome: string, extra: Record<string, unknown> = {}): void => {
    console.log(
      JSON.stringify({
        level: outcome === "ok" ? "info" : "warn",
        service: "engine-core",
        event: "feasibility.narrative_section.call",
        outcome,
        durationMs: Date.now() - startedAt,
        timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        parcelNodeId: model.parcelNodeId,
        ...extra,
        ts: new Date().toISOString(),
      }),
    );
  };

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
    emit("request-failed", { detail: error instanceof Error ? error.message : String(error) });
    return {
      ok: false,
      reason: "request-failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (!res.ok) {
    emit("http-error", { status: res.status });
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
    emit("malformed-response");
    return { ok: false, reason: "malformed-response", detail: "response shape did not match" };
  }

  const text = parsed.narrative.trim();
  if (!text) { emit("empty-narrative"); return { ok: false, reason: "empty-narrative" }; }

  // The server's own no-content path. See the constant's comment: our
  // skeleton beats its apology, and this must not read as a real narrative.
  if (parsed.generatedBy === SERVER_NO_CONTENT_GENERATED_BY) {
    emit("server-reported-no-llm-content");
    return { ok: false, reason: "server-reported-no-llm-content" };
  }

  const { cited, uncited } = deriveCitedSections(text, Object.keys(facts));
  // A narrative that marked nothing cited nothing verifiable. Commitment #1
  // is that every output carries a reasoning chain and source citation, so an
  // unmarked wall of prose is refused in favour of the skeleton, which is
  // cited by construction.
  if (cited.length === 0) {
    emit("no-cited-sections");
    return { ok: false, reason: "no-cited-sections" };
  }

  emit("ok", { citedCount: cited.length, uncitedCount: uncited.length });
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
