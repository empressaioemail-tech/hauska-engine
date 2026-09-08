/**
 * xAI Responses API with the server-side `web_search` tool.
 *
 * SEPARATE from `grok.ts` on purpose. That module posts to
 * `/v1/chat/completions`, which xAI now documents as LEGACY, and the
 * web-search tool does not exist there — it is a Responses-API tool. Rather
 * than migrate the briefing and finding paths (a different lane's blast
 * radius), this adds the one call shape the Feasibility narrative needs and
 * leaves `completeChat` exactly as it is.
 *
 * THE RESPONSE SHAPE HERE WAS READ OFF A LIVE CALL, NOT OFF THE DOCS.
 * xAI's own guide says citations arrive as `response.citations`. On a real
 * 200 from `grok-4.6` that field does not exist. What actually comes back:
 *
 *   output[] where type === "message"
 *     content[] where type === "output_text"
 *       .text          the assistant prose
 *       .annotations[] { type: "url_citation", url, title, start_index, end_index }
 *   output[] where type === "web_search_call"
 *     .action.query    what it searched for
 *     .action.sources[] { type: "url", url }
 *
 * The captured response is checked in at
 * `__tests__/fixtures/xai-responses-web-search.json` so the parser is tested
 * against an observed payload rather than a described one. If xAI changes the
 * shape, the fixture is what tells us.
 *
 * FAIL CLOSED. Every failure — HTTP, timeout, unparseable body, missing text —
 * throws a typed error. The narrative caller catches it and falls back to the
 * deterministic skeleton, so a search outage degrades the report's prose and
 * never breaks the document or invents a citation.
 */

export type GrokSearchErrorCode =
  | "grok_search_http_error"
  | "grok_search_invalid_response"
  | "grok_search_no_key";

export class GrokSearchError extends Error {
  constructor(
    readonly code: GrokSearchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GrokSearchError";
  }
}

/** One web source the model actually cited in its answer. */
export interface GrokCitation {
  url: string;
  title?: string;
}

/** One search the model ran, and what it got back. Kept separate from
 * citations: a search that returned results the model did not use is not
 * evidence for anything, and conflating the two would let an uncited claim
 * borrow authority from a URL nobody wrote a sentence from. */
export interface GrokSearchCall {
  query: string;
  sources: ReadonlyArray<string>;
}

export interface GrokSearchResult {
  text: string;
  citations: ReadonlyArray<GrokCitation>;
  searches: ReadonlyArray<GrokSearchCall>;
  /** Raw usage block. `cost_in_usd_ticks` is carried through unconverted —
   * the tick scale is not documented anywhere we have verified, so this
   * module reports the number and refuses to turn it into dollars. */
  usage?: Record<string, unknown>;
}

export interface GrokSearchParams {
  model: string;
  /**
   * Attach the `web_search` tool. Default TRUE.
   *
   * This must gate the TOOL, not merely the prompt. Measured 2026-09-08: a
   * call whose prompt said nothing about searching still ran seven
   * `web_search_calls` and took 138s, because the tool was attached
   * unconditionally. The caller believed search was off, paid for it, threw
   * the citations away, and left web-derived sentences in the body with no
   * label and no source — the exact failure the web/atom separation exists
   * to prevent. A flag that changes wording but not behaviour is not a
   * control.
   */
  search?: boolean;
  system?: string;
  user: string;
  maxOutputTokens?: number;
  /** At most 5, and mutually exclusive with `excludedDomains` per xAI. */
  allowedDomains?: ReadonlyArray<string>;
  excludedDomains?: ReadonlyArray<string>;
  timeoutMs?: number;
}

export interface GrokSearchClient {
  respondWithSearch(params: GrokSearchParams): Promise<GrokSearchResult>;
}

export interface CreateGrokSearchClientOptions {
  apiKey?: string;
  baseURL?: string;
  fetcher?: typeof fetch;
}

export const GROK_SEARCH_DEFAULT_MODEL = "grok-4.6";
export const GROK_SEARCH_DEFAULT_TIMEOUT_MS = 45_000;

/**
 * Pull the assistant text and its url_citations out of a Responses payload.
 *
 * Exported so the fixture test can drive it directly: the parse is the part
 * most likely to rot when the provider changes, and it should be testable
 * without a network call or a fake fetch.
 */
export function parseGrokSearchResponse(parsed: unknown): GrokSearchResult {
  const output = (parsed as { output?: unknown }).output;
  if (!Array.isArray(output)) {
    throw new GrokSearchError("grok_search_invalid_response", "response has no output[]");
  }

  const searches: GrokSearchCall[] = [];
  const citations: GrokCitation[] = [];
  const seen = new Set<string>();
  let text = "";

  for (const entry of output) {
    const node = entry as { type?: unknown };
    if (node.type === "web_search_call") {
      const action = (entry as { action?: { query?: unknown; sources?: unknown } }).action;
      const sources = Array.isArray(action?.sources)
        ? action!.sources
            .map((s) => (s as { url?: unknown }).url)
            .filter((u): u is string => typeof u === "string" && u.length > 0)
        : [];
      searches.push({
        query: typeof action?.query === "string" ? action.query : "",
        sources,
      });
      continue;
    }
    if (node.type !== "message") continue;
    const content = (entry as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as {
        type?: unknown;
        text?: unknown;
        annotations?: unknown;
      };
      if (p.type !== "output_text") continue;
      // LAST message wins, never a concatenation of all of them.
      //
      // A search-backed run emits several `message` entries: the model
      // narrates what it is about to look up ("I'll search for historic
      // status...", "The THC atlas lists this address as..."), then writes
      // the real answer. Concatenating them glued that tool chatter onto the
      // front of the narrative — and worse, it put WEB-DERIVED sentences in
      // the report body, which is precisely the separation this feature
      // exists to maintain. Observed on a live grok-4.6 call, 2026-09-08.
      if (typeof p.text === "string" && p.text.trim().length > 0) text = p.text;
      if (!Array.isArray(p.annotations)) continue;
      for (const a of p.annotations) {
        const ann = a as { type?: unknown; url?: unknown; title?: unknown };
        if (ann.type !== "url_citation") continue;
        if (typeof ann.url !== "string" || ann.url.length === 0) continue;
        if (seen.has(ann.url)) continue;
        seen.add(ann.url);
        citations.push({
          url: ann.url,
          // xAI echoes the URL as the title when it has no real one. A title
          // identical to its own href tells a reader nothing, so it is
          // dropped rather than printed twice.
          ...(typeof ann.title === "string" && ann.title.length > 0 && ann.title !== ann.url
            ? { title: ann.title }
            : {}),
        });
      }
    }
  }

  if (text.trim().length === 0) {
    throw new GrokSearchError(
      "grok_search_invalid_response",
      "response carried no output_text content",
    );
  }

  const usage = (parsed as { usage?: unknown }).usage;
  return {
    text,
    citations,
    searches,
    ...(usage && typeof usage === "object" ? { usage: usage as Record<string, unknown> } : {}),
  };
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/$/, "");
}

export function createGrokSearchClient(
  opts: CreateGrokSearchClientOptions = {},
): GrokSearchClient {
  const apiKey = opts.apiKey ?? process.env.XAI_API_KEY;
  const baseURL = normalizeBaseUrl(
    opts.baseURL ?? process.env.XAI_BASE_URL ?? "https://api.x.ai/v1",
  );
  const fetcher = opts.fetcher ?? fetch;

  return {
    async respondWithSearch(params) {
      if (!apiKey) {
        throw new GrokSearchError("grok_search_no_key", "XAI_API_KEY is not set");
      }
      if (params.allowedDomains?.length && params.excludedDomains?.length) {
        // xAI rejects both together; refusing here names the caller's mistake
        // instead of surfacing it as an opaque 400.
        throw new GrokSearchError(
          "grok_search_invalid_response",
          "allowedDomains and excludedDomains cannot both be set",
        );
      }

      const search = params.search !== false;
      const tools: Array<Record<string, unknown>> = [];
      if (search) {
        const tool: Record<string, unknown> = { type: "web_search" };
        if (params.allowedDomains?.length) {
          tool.filters = { allowed_domains: params.allowedDomains.slice(0, 5) };
        } else if (params.excludedDomains?.length) {
          tool.filters = { excluded_domains: params.excludedDomains.slice(0, 5) };
        }
        tools.push(tool);
      }

      const input: Array<{ role: string; content: string }> = [];
      if (params.system) input.push({ role: "system", content: params.system });
      input.push({ role: "user", content: params.user });

      let res: Response;
      try {
        res = await fetcher(`${baseURL}/responses`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: params.model,
            input,
            // Omitted entirely when search is off. An empty array is not the
            // same as no tool block on every provider, and this one is not
            // worth guessing about.
            ...(tools.length > 0 ? { tools } : {}),
            ...(params.maxOutputTokens ? { max_output_tokens: params.maxOutputTokens } : {}),
          }),
          signal: AbortSignal.timeout(params.timeoutMs ?? GROK_SEARCH_DEFAULT_TIMEOUT_MS),
        });
      } catch (error) {
        throw new GrokSearchError(
          "grok_search_http_error",
          `xAI responses request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const bodyText = await res.text();
      if (!res.ok) {
        throw new GrokSearchError(
          "grok_search_http_error",
          `xAI HTTP ${res.status}: ${bodyText.slice(0, 400)}`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch (error) {
        throw new GrokSearchError(
          "grok_search_invalid_response",
          `xAI response is not JSON: ${(error as Error).message}`,
        );
      }
      return parseGrokSearchResponse(parsed);
    },
  };
}
