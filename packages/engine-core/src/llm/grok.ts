/**
 * xAI Grok HTTP client (OpenAI-compatible chat completions).
 * Lifted from legacy-design-tools `../llm/grok.js`.
 */

export class GrokApiError extends Error {
  constructor(
    public readonly code: "grok_http_error" | "grok_invalid_response",
    message: string,
  ) {
    super(message);
    this.name = "GrokApiError";
  }
}

export interface GrokChatCompletionParams {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
}

export interface GrokClient {
  completeChat(params: GrokChatCompletionParams): Promise<string>;
}

export interface CreateGrokClientOptions {
  apiKey?: string;
  baseURL?: string;
  fetcher?: typeof fetch;
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/$/, "");
}

export function createGrokClient(
  opts: CreateGrokClientOptions = {},
): GrokClient {
  const apiKey = opts.apiKey ?? process.env.XAI_API_KEY;
  const baseURL = normalizeBaseUrl(
    opts.baseURL ?? process.env.XAI_BASE_URL ?? "https://api.x.ai/v1",
  );
  const fetcher = opts.fetcher ?? fetch;

  return {
    async completeChat(params) {
      if (!apiKey) {
        throw new GrokApiError("grok_http_error", "XAI_API_KEY is not set");
      }
      const res = await fetcher(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: params.model,
          max_tokens: params.maxTokens,
          temperature: 0.2,
          messages: [
            { role: "system", content: params.system },
            { role: "user", content: params.user },
          ],
        }),
      });
      const bodyText = await res.text();
      if (!res.ok) {
        throw new GrokApiError(
          "grok_http_error",
          `xAI HTTP ${res.status}: ${bodyText.slice(0, 400)}`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch (err) {
        throw new GrokApiError(
          "grok_invalid_response",
          `xAI response is not JSON: ${(err as Error).message}`,
        );
      }
      const choices = (parsed as { choices?: unknown }).choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        throw new GrokApiError(
          "grok_invalid_response",
          "xAI response missing choices[]",
        );
      }
      const message = (choices[0] as { message?: { content?: unknown } })
        .message;
      const content = message?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new GrokApiError(
          "grok_invalid_response",
          "xAI response had no message content",
        );
      }
      return content;
    },
  };
}
