/**
 * Respectful HTTP client shared by code-source adapters.
 *
 * Caps requests-per-second per host and serializes requests when the
 * cap is reached. Adapters that fan out across many URLs against the
 * same source can share one instance to avoid hammering the host.
 *
 * Not a full crawler: no robots.txt parsing, no recursive discovery,
 * no concurrency tuning beyond the per-host serialization. Adapter
 * implementations layer their own discovery semantics on top.
 */

import { fetch as undiciFetch, type RequestInit } from "undici";

export interface RespectfulFetchOptions {
  /** Maximum requests per second per host. Defaults to 1. */
  maxRequestsPerSecondPerHost?: number;
  /** Optional user-agent override. */
  userAgent?: string;
  /** Optional default headers (overridden by per-call headers). */
  defaultHeaders?: Record<string, string>;
}

interface HostState {
  lastRequestAt: number;
  queue: Promise<unknown>;
}

export class RespectfulFetch {
  private readonly maxRps: number;
  private readonly minIntervalMs: number;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly hostState = new Map<string, HostState>();

  constructor(opts: RespectfulFetchOptions = {}) {
    this.maxRps = opts.maxRequestsPerSecondPerHost ?? 1;
    this.minIntervalMs = Math.ceil(1000 / this.maxRps);
    this.userAgent =
      opts.userAgent ??
      "HauskaEngineIngest/0.1 (+https://hauska.dev/bots) cc-agent-E";
    this.defaultHeaders = opts.defaultHeaders ?? {};
  }

  async fetchText(url: string, init: RequestInit = {}): Promise<string> {
    const res = await this.fetch(url, init);
    if (!res.ok) {
      throw new Error(
        `RespectfulFetch: HTTP ${res.status} ${res.statusText} for ${url}`,
      );
    }
    return await res.text();
  }

  async fetch(url: string, init: RequestInit = {}) {
    const host = new URL(url).host;
    const state = this.getHostState(host);
    const wait = state.queue.then(() => this.throttle(host));
    state.queue = wait;
    await wait;
    return undiciFetch(url, {
      ...init,
      headers: {
        "User-Agent": this.userAgent,
        ...this.defaultHeaders,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  }

  private getHostState(host: string): HostState {
    const existing = this.hostState.get(host);
    if (existing) return existing;
    const fresh: HostState = {
      lastRequestAt: 0,
      queue: Promise.resolve(),
    };
    this.hostState.set(host, fresh);
    return fresh;
  }

  private async throttle(host: string): Promise<void> {
    const state = this.getHostState(host);
    const now = Date.now();
    const elapsed = now - state.lastRequestAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, this.minIntervalMs - elapsed),
      );
    }
    state.lastRequestAt = Date.now();
  }
}
