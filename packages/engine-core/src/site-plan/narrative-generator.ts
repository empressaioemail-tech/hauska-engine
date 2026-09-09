import { buildFullNarrativeFacts, deriveCitedSections } from "./narrative-section-client.js";
import type { ParcelReportModel } from "./report-model.js";
import {
  GROK_SEARCH_DEFAULT_MODEL,
  GROK_SEARCH_DEFAULT_TIMEOUT_MS,
  createGrokSearchClient,
  type GrokCitation,
  type GrokSearchClient,
} from "../llm/grok-search.js";

/**
 * The Feasibility narrative, generated IN THIS SERVICE.
 *
 * Why this exists rather than the cross-repo hop in
 * `narrative-section-client.ts`: that client POSTs to
 * `/research/narrative-section` in legacy-design-tools, which needs
 * `BROKERAGE_API_BASE_URL` and a `SERVICE_API_KEY` whose secret lives in a
 * DIFFERENT GCP project from the one engine-api runs in. That is why the
 * narrative has never run in production — every report ever generated fell
 * back to the deterministic skeleton.
 *
 * The client's own header says the server half "runs the same
 * `completeBriefingLlm` machinery every other brief function uses". That
 * machinery is in THIS package (`llm/`, `briefing/`), and engine-api already
 * runs with `XAI_API_KEY` mounted and `BRIEFING_LLM_MODE=grok`. So the hop
 * bought nothing and cost the feature. Generating here needs no new secret,
 * no new env var, and no second service to be up.
 *
 * ── The two rules this file exists to enforce ──────────────────────────
 *
 * 1. ATOM FACTS AND WEB FACTS NEVER MIX. The model is given the report's own
 *    facts and, separately, live web search. Anything it learned from the web
 *    must be written in a delimited block, and that block is rendered apart
 *    from the report body under an explicit unverified label. A web sentence
 *    that drifts into the main narrative is indistinguishable from a
 *    source-of-record finding, which is the whole risk of putting a language
 *    model in a paid deliverable.
 *
 * 2. CITE OR DECLINE. Main-body sentences carry `[factKey]` markers and the
 *    cited set is derived by SCANNING the returned text, never by trusting a
 *    field the model filled in. Web claims must carry a URL that appears in
 *    the provider's own citation annotations; a claim citing a URL the search
 *    tool never returned is dropped, because the alternative is printing a
 *    fabricated source next to real ones.
 *
 * Fail closed throughout: every failure returns a reason and no narrative, and
 * the caller keeps its complete deterministic skeleton.
 */

export const WEB_BLOCK_OPEN = "<<<WEB_FINDINGS>>>";
export const WEB_BLOCK_CLOSE = "<<<END_WEB_FINDINGS>>>";

/** Printed above the web block wherever it renders. */
export const WEB_FINDINGS_DISCLOSURE =
  "Found on the open web and NOT verified against a source of record. Treat as a lead to confirm, never as a finding.";

export interface WebFinding {
  text: string;
  url: string;
  title?: string;
}

export interface GeneratedNarrative {
  narrativeOverride: { text: string; generatedBy: string; generatedAt: string };
  citedSections: ReadonlyArray<string>;
  uncitedSections: ReadonlyArray<string>;
  webFindings: ReadonlyArray<WebFinding>;
  /** Every URL the search tool actually returned, whether cited or not. */
  searchedUrls: ReadonlyArray<string>;
  usage?: Record<string, unknown>;
}

export type NarrativeFailureReason =
  | "llm-disabled"
  | "no-api-key"
  | "request-failed"
  | "empty-narrative"
  | "no-citations";

export type GenerateNarrativeOutcome =
  | ({ ok: true } & GeneratedNarrative)
  | { ok: false; reason: NarrativeFailureReason; detail?: string };

export interface GenerateNarrativeOptions {
  model?: string;
  timeoutMs?: number;
  client?: GrokSearchClient;
  /** Off by default. Web search adds latency and per-call cost to a
   * synchronous customer path, so it is opt-in at the call site rather than
   * something a deploy turns on by surprise. */
  webSearch?: boolean;
  maxOutputTokens?: number;
  /**
   * How much narrative to write.
   *
   * "full" is the Feasibility Study's: 350-500 words reasoning across every
   * fact family, because that document is the one a buyer takes to a
   * decision.
   *
   * "snapshot" is the X-Ray's: 150-220 words. X-Ray is a mini feasibility —
   * a high-level read of what the parcel is and what stands out — and a
   * five-paragraph essay on a four-sheet document is the wrong shape. Same
   * facts, same cite-or-decline rules, less of it.
   */
  style?: "full" | "snapshot";
}

/**
 * Fast model without search, reasoning model with it. Measured on one parcel,
 * 2026-09-08, same prompt and same payload:
 *
 *   grok-3-mini   16.0s   13 cited   392 words
 *   grok-4.3      12.7s   18 cited   372 words   <- default
 *   grok-4.6      74.1s   20 cited   477 words
 *
 * grok-4.6 does not fit: Property Explorer budgets 55s for the WHOLE compose.
 * grok-4.3 is the fastest of the three AND cites the most families per second,
 * and its prose reasons across facts rather than listing them — it refuses the
 * empty-lot inference unprompted and closes by saying which confirmation to
 * get first.
 *
 * MEASURED SEPARATELY, and the more useful finding: the first cut of these
 * numbers had grok-3-mini at 142 words and grok-4.3 at 226, and the limiter
 * was this file's own prompt ("three to six SHORT paragraphs"), not the
 * models. Stating a word count and saying the narrative appears on the cover
 * took grok-3-mini from 142 to 392 words at the same latency. Prompt before
 * model, when output looks thin.
 *
 * Web search is the exception. The searching run has to judge which results
 * are about THIS parcel and which are a different Church Street, and the
 * reasoning model was visibly better at declining when it could not tell.
 * A search run is already off the synchronous path on latency alone, so it
 * can afford the slower model.
 *
 * `XAI_NARRATIVE_MODEL` overrides both.
 */
export const NARRATIVE_MODEL_FAST = "grok-4.3";
export const NARRATIVE_MODEL_SEARCH = GROK_SEARCH_DEFAULT_MODEL;

function defaultModelFor(webSearch: boolean): string {
  return webSearch ? NARRATIVE_MODEL_SEARCH : NARRATIVE_MODEL_FAST;
}

const SNAPSHOT_RULES = `6. Plain prose. No bullet lists, no headings, no bold.
7. LENGTH: write 150 to 220 words, in two or three paragraphs. This is a SNAPSHOT at the front of a short document, not a full study. Say what this parcel is, what governs it, and the one or two things that most stand out — then stop. Do not walk the whole fact list.
8. Attach a marker to the sentence that actually used the fact. Do not stack unrelated markers at the end of a sentence.
9. Lead with what the parcel is and what can be built on it. If something genuinely constrains a build here, that is the second sentence, not the last.`;

const FULL_RULES = `6. Plain prose. No bullet lists, no headings, no bold.
7. LENGTH: write 350 to 500 words, in four to six paragraphs. This is the primary narrative of the document and it appears on the cover, where it is the first thing a buyer reads. A three-sentence answer is a failure of the task, not a concise version of it.
8. Attach a marker to the sentence that actually used the fact. Do not stack unrelated markers at the end of a sentence: "[a][b][c][d][e]" tells a reader nothing about which claim rests on which fact.
9. Lead with what a decision-maker needs first. Open with what can be built and what governs it; put the confirmations and the unknowns after that, and close with what stands between this packet and a decision.`;

function systemPrompt(style: "full" | "snapshot"): string {
  return `You are writing the narrative section of a property feasibility study for a developer or buyer deciding whether to build on one parcel.

You are given a JSON object of FACTS assembled from public records and models. Write for someone making a decision, not for the system that produced the data.

RULES, all mandatory:

1. Every sentence drawn from the FACTS must end with a marker naming the fact key it used, in square brackets, e.g. [drainageStudy] or [geometry]. A sentence with no marker will be discarded.
2. Reason ACROSS facts. The value of this section is what the facts mean together: what the buildable envelope plus the setbacks plus the topography imply for siting; what the drainage study means for grading and finished-floor elevation; what an absence means for the schedule. Do not restate single values that already appear in the tables.
3. Where two facts disagree, say so plainly and say which one a reader should act on. Disagreements are the most valuable thing you can surface.
4. An absent fact is not a negative finding. "No record was found" never becomes "there is none". Never infer a vacant site from a missing footprint.
5. No dollar figures, no yield or unit estimates, no schedule estimates. None are supported by this data.
${style === "snapshot" ? SNAPSHOT_RULES : FULL_RULES}

If you used web search, put everything you learned from the web AFTER the main narrative, inside these exact delimiters:
${WEB_BLOCK_OPEN}
- one line per finding, each ending with the full source URL in parentheses
${WEB_BLOCK_CLOSE}

Nothing from the web may appear in the main narrative. Web findings are unverified leads and are labelled as such for the reader.`;
}

function buildUserPrompt(model: ParcelReportModel, facts: Record<string, unknown>, webSearch: boolean): string {
  const address =
    model.geometry.status === "present" ? model.geometry.model.summary.address : undefined;
  const county =
    model.geometry.status === "present" ? model.geometry.model.summary.countyName : undefined;
  const where = [address, county].filter(Boolean).join(", ");

  const searchInstruction = webSearch
    ? `\n\nYou also have web search. Use it to look for things this record set cannot know: historic designation or landmark status, overlay districts or design-review requirements, recent rezoning or annexation, and any known development constraint at this address. Search for the ADDRESS${where ? ` (${where})` : ""}. Report only what you can attribute to a page you actually retrieved, each with its URL, inside the delimiters. If you find nothing, omit the block entirely rather than filling it.`
    : "";

  return `Parcel ${model.parcelNodeId}${where ? ` at ${where}` : ""}.

FACTS:
${JSON.stringify(facts, null, 1)}${searchInstruction}`;
}

/**
 * Split the model's answer into the main narrative and the web block.
 *
 * A model that ignores the delimiters produces no web findings rather than
 * leaking web prose into the body — the failure direction that keeps
 * unverified material out of the report.
 */
export function splitWebBlock(raw: string): { body: string; webBlock: string | null } {
  const open = raw.indexOf(WEB_BLOCK_OPEN);
  if (open === -1) return { body: raw.trim(), webBlock: null };
  const afterOpen = open + WEB_BLOCK_OPEN.length;
  const close = raw.indexOf(WEB_BLOCK_CLOSE, afterOpen);
  const body = raw.slice(0, open).trim();
  const webBlock = raw.slice(afterOpen, close === -1 ? undefined : close).trim();
  return { body, webBlock: webBlock.length > 0 ? webBlock : null };
}

/**
 * Turn the web block's lines into findings, keeping ONLY claims whose URL the
 * search tool actually returned.
 *
 * This is the check that makes a citation mean something. The model supplies
 * both the sentence and the URL, so on its own that pair is one party
 * asserting both halves. The provider's `url_citation` annotations are a
 * second, independently produced list, and a URL absent from it was not
 * retrieved — printing it would put a fabricated source beside real ones.
 */
export function extractWebFindings(
  webBlock: string | null,
  citations: ReadonlyArray<GrokCitation>,
): WebFinding[] {
  if (!webBlock) return [];
  const allowed = new Map<string, GrokCitation>();
  for (const c of citations) allowed.set(normalizeUrl(c.url), c);
  if (allowed.size === 0) return [];

  const findings: WebFinding[] = [];
  for (const rawLine of webBlock.split("\n")) {
    const line = rawLine.replace(/^\s*[-*•]\s*/, "").trim();
    if (line.length === 0) continue;
    const urls = line.match(/https?:\/\/[^\s)<>\]]+/g);
    if (!urls || urls.length === 0) continue;
    const matched = urls
      .map((u) => allowed.get(normalizeUrl(u)))
      .find((c): c is GrokCitation => c !== undefined);
    if (!matched) continue;
    const text = line
      .replace(/\(?\s*https?:\/\/[^\s)<>\]]+\s*\)?/g, "")
      .replace(/\s{2,}/g, " ")
      .replace(/[\s.,;]+$/, "")
      .trim();
    if (text.length === 0) continue;
    findings.push({
      text,
      url: matched.url,
      ...(matched.title ? { title: matched.title } : {}),
    });
  }
  return findings;
}

function normalizeUrl(u: string): string {
  return u.replace(/[).,;]+$/, "").replace(/\/+$/, "").toLowerCase();
}

export async function generateFeasibilityNarrative(
  model: ParcelReportModel,
  options: GenerateNarrativeOptions = {},
): Promise<GenerateNarrativeOutcome> {
  // The WIDE payload — in-process only. The LDT client keeps its own
  // nine-family contract; widening that one regressed it in production.
  const facts = buildFullNarrativeFacts(model);
  const webSearch = options.webSearch === true;
  // Never open a live client from a test run. An injected client is always
  // honoured, but an ambient XAI_API_KEY in a developer shell or a CI secret
  // must not turn a unit test into a billed network call — the same guard
  // `storageFromEnv` already applies for DATABASE_URL, and the same reason
  // the #404 fact resolvers are injected rather than defaulted.
  const underTest = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  const client =
    options.client ??
    (!underTest && process.env.XAI_API_KEY ? createGrokSearchClient() : null);
  if (!client) return { ok: false, reason: "no-api-key" };

  let raw: string;
  let citations: ReadonlyArray<GrokCitation>;
  let searchedUrls: string[];
  let usage: Record<string, unknown> | undefined;
  try {
    const result = await client.respondWithSearch({
      model: options.model ?? process.env.XAI_NARRATIVE_MODEL?.trim() ?? defaultModelFor(webSearch),
      system: systemPrompt(options.style ?? "full"),
      user: buildUserPrompt(model, facts, webSearch),
      // Gates the TOOL, not just the wording. Without this the provider
      // searches regardless and the citations are discarded rather than
      // rendered — see GrokSearchParams.search.
      search: webSearch,
      timeoutMs: options.timeoutMs ?? GROK_SEARCH_DEFAULT_TIMEOUT_MS,
      ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
    });
    raw = result.text;
    citations = webSearch ? result.citations : [];
    searchedUrls = webSearch ? result.searches.flatMap((s) => [...s.sources]) : [];
    usage = result.usage;
  } catch (error) {
    return {
      ok: false,
      reason: "request-failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const { body, webBlock } = splitWebBlock(raw);
  if (body.trim().length === 0) return { ok: false, reason: "empty-narrative" };

  const { cited, uncited } = deriveCitedSections(body, Object.keys(facts));
  if (cited.length === 0) {
    // An uncited narrative is refused, not printed. Same posture the
    // cross-repo client already took: prose that names no fact it drew on
    // cannot be checked against anything.
    return { ok: false, reason: "no-citations" };
  }

  return {
    ok: true,
    narrativeOverride: {
      text: body,
      generatedBy: `xai:${options.model ?? process.env.XAI_NARRATIVE_MODEL?.trim() ?? defaultModelFor(webSearch)}${webSearch ? "+web" : ""}`,
      generatedAt: new Date().toISOString(),
    },
    citedSections: cited,
    uncitedSections: uncited,
    webFindings: extractWebFindings(webBlock, citations),
    searchedUrls,
    ...(usage ? { usage } : {}),
  };
}
