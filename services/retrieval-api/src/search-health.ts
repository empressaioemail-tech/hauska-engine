/**
 * Bounded /search liveness probe — catches the failure mode where /health
 * stays 200 while every /search OOMs (silent outage ~2026-07-28).
 */

import type { HybridRetrieval } from "@hauska-engine/retrieval";

export interface SearchHealthProbeInput {
  retrieval: HybridRetrieval;
  /** Defaults: bastrop_tx / empty q / limit 3 (any atoms prove the path). */
  jurisdiction?: string;
  q?: string;
  limit?: number;
  now?: () => Date;
}

export interface SearchHealthPayload {
  status: "ok" | "fail";
  check: "search";
  service: "hauska-retrieval-api";
  ok: boolean;
  resultCount: number;
  latencyMs: number;
  probe: {
    jurisdiction: string;
    q: string;
    limit: number;
  };
  sampleAtomDids: string[];
  error?: string;
  ts: string;
}

export const DEFAULT_SEARCH_HEALTH_PROBE = {
  jurisdiction: "bastrop_tx",
  q: "",
  limit: 3,
} as const;

export async function buildSearchHealthPayload(
  input: SearchHealthProbeInput,
): Promise<SearchHealthPayload> {
  const jurisdiction =
    input.jurisdiction ?? DEFAULT_SEARCH_HEALTH_PROBE.jurisdiction;
  const q = input.q ?? DEFAULT_SEARCH_HEALTH_PROBE.q;
  const limit = input.limit ?? DEFAULT_SEARCH_HEALTH_PROBE.limit;
  const ts = (input.now ?? (() => new Date()))().toISOString();
  const started = Date.now();

  try {
    const result = await input.retrieval.search({
      q,
      jurisdiction,
      limit,
    });
    const latencyMs = Date.now() - started;
    const results = Array.isArray(result.results) ? result.results : [];
    const ok = results.length > 0;
    return {
      status: ok ? "ok" : "fail",
      check: "search",
      service: "hauska-retrieval-api",
      ok,
      resultCount: results.length,
      latencyMs,
      probe: { jurisdiction, q, limit },
      sampleAtomDids: results.slice(0, 3).map((r) => r.atomDid),
      ...(ok
        ? {}
        : {
            error:
              "bounded search returned zero results — search path empty or broken",
          }),
      ts,
    };
  } catch (err) {
    return {
      status: "fail",
      check: "search",
      service: "hauska-retrieval-api",
      ok: false,
      resultCount: 0,
      latencyMs: Date.now() - started,
      probe: { jurisdiction, q, limit },
      sampleAtomDids: [],
      error: err instanceof Error ? err.message : String(err),
      ts,
    };
  }
}

export function httpStatusForSearchHealth(
  payload: SearchHealthPayload,
): 200 | 503 {
  return payload.ok ? 200 : 503;
}

export function emitSearchHealthSignal(payload: SearchHealthPayload): void {
  console.log(
    JSON.stringify({
      hauska_health: true,
      check: "search",
      service: "hauska-retrieval-api",
      status: payload.status,
      value: `results=${payload.resultCount};latencyMs=${payload.latencyMs}`,
      threshold: "results>0",
      source: "GET /health/search",
      ts: payload.ts,
      ...(payload.error ? { error: payload.error } : {}),
    }),
  );
}
