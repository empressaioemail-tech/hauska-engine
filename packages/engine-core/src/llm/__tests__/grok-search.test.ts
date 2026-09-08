import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  GrokSearchError,
  createGrokSearchClient,
  parseGrokSearchResponse,
} from "../grok-search.js";

/**
 * The fixture is a REAL 200 from `POST https://api.x.ai/v1/responses` with
 * the `web_search` tool, captured 2026-09-08 against grok-4.6 and trimmed
 * (reasoning bodies dropped, source and annotation lists truncated) without
 * changing any field name or nesting.
 *
 * It exists because xAI's own documentation is wrong about this payload: the
 * guide says citations arrive at `response.citations`, and on a live call
 * that field is absent. Writing the parser against the docs would have
 * produced a module that returned zero citations forever and looked correct
 * in review.
 */
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/xai-responses-web-search.json", import.meta.url)),
    "utf8",
  ),
) as unknown;

describe("parseGrokSearchResponse, against a captured live payload", () => {
  it("reads the assistant text out of output[].message.content[].output_text", () => {
    const result = parseGrokSearchResponse(fixture);
    expect(result.text).toContain("National Register of Historic Places");
  });

  it("reads citations from content[].annotations, NOT from response.citations", () => {
    // The falsifier for the documentation: if `response.citations` were the
    // real field, this fixture would yield none.
    expect((fixture as { citations?: unknown }).citations).toBeUndefined();

    const result = parseGrokSearchResponse(fixture);
    expect(result.citations.length).toBeGreaterThan(0);
    for (const c of result.citations) {
      expect(c.url).toMatch(/^https?:\/\//);
    }
  });

  it("keeps the searches it ran separate from the sources it cited", () => {
    const result = parseGrokSearchResponse(fixture);
    expect(result.searches.length).toBeGreaterThan(0);
    expect(result.searches[0]!.query.length).toBeGreaterThan(0);
    // Searching is not citing. A URL that came back from a query the model
    // never wrote a sentence from must not arrive as a citation.
    expect(result.searches).not.toBe(result.citations);
  });

  it("drops a title that merely repeats its own URL", () => {
    const result = parseGrokSearchResponse(fixture);
    for (const c of result.citations) {
      expect(c.title).not.toBe(c.url);
    }
  });

  it("de-duplicates repeated citation URLs", () => {
    const doubled = {
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "text",
              annotations: [
                { type: "url_citation", url: "https://a.example/x" },
                { type: "url_citation", url: "https://a.example/x" },
              ],
            },
          ],
        },
      ],
    };
    expect(parseGrokSearchResponse(doubled).citations).toHaveLength(1);
  });

  it("takes the LAST message, so tool preamble never prefixes the answer", () => {
    // Observed live: a search-backed run narrates its intent in earlier
    // `message` entries before writing the answer. Concatenating them put
    // "I'll search for historic status..." at the top of the narrative AND
    // leaked web-derived sentences into the report body.
    const multi = {
      output: [
        { type: "message", content: [{ type: "output_text", text: "I'll search for historic status.", annotations: [] }] },
        { type: "web_search_call", action: { query: "q", sources: [] } },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "The parcel is in Bastrop County [jurisdiction].",
              annotations: [{ type: "url_citation", url: "https://a.example/x" }],
            },
          ],
        },
      ],
    };
    const result = parseGrokSearchResponse(multi);
    expect(result.text).toBe("The parcel is in Bastrop County [jurisdiction].");
    expect(result.text).not.toContain("I'll search");
    // Citations from any message still survive the last-wins rule.
    expect(result.citations.map((c) => c.url)).toContain("https://a.example/x");
  });

  it("REFUSES a response with no assistant text rather than returning empty prose", () => {
    const noText = { output: [{ type: "web_search_call", action: { query: "q", sources: [] } }] };
    expect(() => parseGrokSearchResponse(noText)).toThrow(GrokSearchError);
  });

  it("REFUSES a response with no output array", () => {
    expect(() => parseGrokSearchResponse({})).toThrow(GrokSearchError);
  });
});

describe("createGrokSearchClient request shape", () => {
  it("posts to /responses with the web_search tool, never to /chat/completions", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    const client = createGrokSearchClient({
      apiKey: "test-key",
      fetcher: (async (url: string, init: RequestInit) => {
        seenUrl = String(url);
        seenBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify(fixture), { status: 200 });
      }) as unknown as typeof fetch,
    });

    await client.respondWithSearch({ model: "grok-4.6", user: "hi" });

    expect(seenUrl).toBe("https://api.x.ai/v1/responses");
    expect(seenUrl).not.toContain("chat/completions");
    expect(seenBody.tools).toEqual([{ type: "web_search" }]);
  });

  it("refuses allowedDomains and excludedDomains together instead of sending a 400", async () => {
    const client = createGrokSearchClient({
      apiKey: "k",
      fetcher: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    await expect(
      client.respondWithSearch({
        model: "m",
        user: "u",
        allowedDomains: ["a.com"],
        excludedDomains: ["b.com"],
      }),
    ).rejects.toThrow(GrokSearchError);
  });

  it("throws without an API key rather than calling unauthenticated", async () => {
    let called = false;
    const client = createGrokSearchClient({
      apiKey: "",
      fetcher: (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    // Explicit empty key, and process.env must not rescue it into a live call.
    const prev = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    try {
      await expect(client.respondWithSearch({ model: "m", user: "u" })).rejects.toThrow(
        GrokSearchError,
      );
      expect(called).toBe(false);
    } finally {
      if (prev !== undefined) process.env.XAI_API_KEY = prev;
    }
  });

  it("turns a non-200 into a typed error carrying the status", async () => {
    const client = createGrokSearchClient({
      apiKey: "k",
      fetcher: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    });
    await expect(client.respondWithSearch({ model: "m", user: "u" })).rejects.toThrow(/503/);
  });
});
