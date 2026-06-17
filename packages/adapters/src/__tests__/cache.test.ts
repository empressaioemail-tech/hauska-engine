/**
 * Cache key + runner cache integration — Task #180.
 */

import { describe, expect, it, vi } from "vitest";
import { runAdapters } from "../runner";
import {
  toCacheKey,
  type AdapterCacheHit,
  type AdapterCacheKey,
  type AdapterResultCache,
} from "../cache";
import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";

const utahCtx: AdapterContext = {
  parcel: { latitude: 38.5733012, longitude: -109.5498987 },
  jurisdiction: { stateKey: "utah", localKey: "grand-county-ut" },
};

function makeAdapter(opts: {
  key: string;
  tier?: "federal" | "state" | "local";
  result?: AdapterResult;
  throws?: AdapterRunError | Error;
  runMock?: () => Promise<AdapterResult>;
}): Adapter {
  const tier = opts.tier ?? "federal";
  const sourceKind =
    tier === "federal"
      ? "federal-adapter"
      : tier === "state"
        ? "state-adapter"
        : "local-adapter";
  return {
    adapterKey: opts.key,
    tier,
    sourceKind,
    layerKind: opts.key.replace(":", "-"),
    provider: "Test",
    jurisdictionGate: {},
    appliesTo: () => true,
    async run() {
      if (opts.runMock) return opts.runMock();
      if (opts.throws) throw opts.throws;
      return (
        opts.result ?? {
          adapterKey: opts.key,
          tier,
          layerKind: opts.key.replace(":", "-"),
          sourceKind,
          provider: "Test",
          snapshotDate: "2026-01-01T00:00:00.000Z",
          payload: { kind: "test", value: opts.key },
        }
      );
    },
  };
}

class InMemoryCache implements AdapterResultCache {
  readonly store = new Map<string, AdapterCacheHit>();
  readonly getCalls: AdapterCacheKey[] = [];
  readonly putCalls: AdapterCacheKey[] = [];
  async get(key: AdapterCacheKey): Promise<AdapterCacheHit | null> {
    this.getCalls.push(key);
    return this.store.get(this.k(key)) ?? null;
  }
  async put(key: AdapterCacheKey, result: AdapterResult): Promise<void> {
    this.putCalls.push(key);
    this.store.set(this.k(key), { result, cachedAt: new Date() });
  }
  private k(key: AdapterCacheKey): string {
    return `${key.adapterKey}|${key.latRounded}|${key.lngRounded}`;
  }
}

describe("toCacheKey", () => {
  it("rounds latitude and longitude to 5 decimal places", () => {
    const key = toCacheKey("fema:nfhl-flood-zone", 38.5733012, -109.5498987);
    expect(key).toEqual({
      adapterKey: "fema:nfhl-flood-zone",
      latRounded: 38.5733,
      lngRounded: -109.5499,
    });
  });

  it("returns the same key for coordinates that round to the same 5-decimal value", () => {
    const a = toCacheKey("fema:nfhl-flood-zone", 38.5733212, -109.5498987);
    const b = toCacheKey("fema:nfhl-flood-zone", 38.5733189, -109.5499011);
    expect(a).toEqual(b);
  });

  it("returns null for non-finite coordinates", () => {
    expect(toCacheKey("k", NaN, -109)).toBeNull();
    expect(toCacheKey("k", 38, Infinity)).toBeNull();
  });
});

describe("runAdapters with cache", () => {
  it("returns the cached result without running the adapter on a hit", async () => {
    const cache = new InMemoryCache();
    const cachedResult: AdapterResult = {
      adapterKey: "fema:nfhl-flood-zone",
      tier: "federal",
      layerKind: "fema-nfhl-flood-zone",
      sourceKind: "federal-adapter",
      provider: "FEMA",
      snapshotDate: "2025-12-01T00:00:00.000Z",
      payload: { kind: "flood-zone", floodZone: "AE" },
    };
    const cachedAt = new Date("2026-04-30T12:00:00.000Z");
    cache.store.set(
      `fema:nfhl-flood-zone|38.5733|-109.5499`,
      { result: cachedResult, cachedAt },
    );
    const runMock = vi.fn(async () => {
      throw new Error("should not run on cache hit");
    });
    const adapter = makeAdapter({
      key: "fema:nfhl-flood-zone",
      tier: "federal",
      runMock,
    });
    const outcomes = await runAdapters({
      adapters: [adapter],
      context: utahCtx,
      cache,
    });
    expect(outcomes[0].status).toBe("ok");
    expect(outcomes[0].result).toEqual(cachedResult);
    expect(outcomes[0].fromCache).toBe(true);
    expect(outcomes[0].cachedAt).toBe(cachedAt.toISOString());
    expect(runMock).not.toHaveBeenCalled();
    expect(cache.putCalls).toHaveLength(0);
  });

  it("marks live runs with fromCache=false and a null cachedAt", async () => {
    const cache = new InMemoryCache();
    const adapter = makeAdapter({
      key: "fema:nfhl-flood-zone",
      tier: "federal",
    });
    const outcomes = await runAdapters({
      adapters: [adapter],
      context: utahCtx,
      cache,
    });
    expect(outcomes[0].status).toBe("ok");
    expect(outcomes[0].fromCache).toBe(false);
    expect(outcomes[0].cachedAt).toBeNull();
  });

  it("forceRefresh skips the cache.get but still writes the fresh result through", async () => {
    const cache = new InMemoryCache();
    const cachedResult: AdapterResult = {
      adapterKey: "fema:nfhl-flood-zone",
      tier: "federal",
      layerKind: "fema-nfhl-flood-zone",
      sourceKind: "federal-adapter",
      provider: "FEMA",
      snapshotDate: "2025-12-01T00:00:00.000Z",
      payload: { kind: "flood-zone", floodZone: "AE-stale" },
    };
    cache.store.set(`fema:nfhl-flood-zone|38.5733|-109.5499`, {
      result: cachedResult,
      cachedAt: new Date("2026-04-30T12:00:00.000Z"),
    });
    const runMock = vi.fn(async () => ({
      adapterKey: "fema:nfhl-flood-zone",
      tier: "federal" as const,
      layerKind: "fema-nfhl-flood-zone",
      sourceKind: "federal-adapter" as const,
      provider: "FEMA",
      snapshotDate: "2026-05-01T00:00:00.000Z",
      payload: { kind: "flood-zone", floodZone: "X-fresh" },
    }));
    const adapter = makeAdapter({
      key: "fema:nfhl-flood-zone",
      tier: "federal",
      runMock,
    });
    const outcomes = await runAdapters({
      adapters: [adapter],
      context: utahCtx,
      cache,
      forceRefresh: true,
    });
    expect(cache.getCalls).toHaveLength(0);
    expect(runMock).toHaveBeenCalledOnce();
    expect(outcomes[0].fromCache).toBe(false);
    expect(outcomes[0].result?.payload).toEqual({
      kind: "flood-zone",
      floodZone: "X-fresh",
    });
    // Fresh result is still written through so the next non-forced run hits.
    expect(cache.putCalls).toHaveLength(1);
  });

  it("writes a successful result through to the cache", async () => {
    const cache = new InMemoryCache();
    const adapter = makeAdapter({
      key: "fema:nfhl-flood-zone",
      tier: "federal",
    });
    const outcomes = await runAdapters({
      adapters: [adapter],
      context: utahCtx,
      cache,
    });
    expect(outcomes[0].status).toBe("ok");
    expect(cache.putCalls).toHaveLength(1);
    expect(cache.putCalls[0]).toEqual({
      adapterKey: "fema:nfhl-flood-zone",
      latRounded: 38.5733,
      lngRounded: -109.5499,
    });
    expect(cache.store.size).toBe(1);
  });

  it("does not write to the cache when the adapter fails", async () => {
    const cache = new InMemoryCache();
    const adapter = makeAdapter({
      key: "fema:nfhl-flood-zone",
      tier: "federal",
      throws: new AdapterRunError("upstream-error", "503"),
    });
    const outcomes = await runAdapters({
      adapters: [adapter],
      context: utahCtx,
      cache,
    });
    expect(outcomes[0].status).toBe("failed");
    expect(cache.putCalls).toHaveLength(0);
    expect(cache.store.size).toBe(0);
  });

  it("only caches federal-tier adapters by default", async () => {
    const cache = new InMemoryCache();
    const fed = makeAdapter({ key: "fema:nfhl", tier: "federal" });
    const state = makeAdapter({ key: "ugrc:dem", tier: "state" });
    const local = makeAdapter({ key: "grand:zoning", tier: "local" });
    await runAdapters({
      adapters: [fed, state, local],
      context: utahCtx,
      cache,
    });
    expect(cache.getCalls.map((k) => k.adapterKey)).toEqual(["fema:nfhl"]);
    expect(cache.putCalls.map((k) => k.adapterKey)).toEqual(["fema:nfhl"]);
  });

  it("respects a custom cachePredicate", async () => {
    const cache = new InMemoryCache();
    const fed = makeAdapter({ key: "fema:nfhl", tier: "federal" });
    const state = makeAdapter({ key: "ugrc:dem", tier: "state" });
    await runAdapters({
      adapters: [fed, state],
      context: utahCtx,
      cache,
      cachePredicate: (a) => a.tier === "state",
    });
    expect(cache.getCalls.map((k) => k.adapterKey)).toEqual(["ugrc:dem"]);
    expect(cache.putCalls.map((k) => k.adapterKey)).toEqual(["ugrc:dem"]);
  });

  it("falls through to a live run when the cache throws on get", async () => {
    const failingCache: AdapterResultCache = {
      get: vi.fn(async () => {
        throw new Error("DB connection refused");
      }),
      put: vi.fn(async () => undefined),
    };
    const adapter = makeAdapter({
      key: "fema:nfhl",
      tier: "federal",
    });
    const outcomes = await runAdapters({
      adapters: [adapter],
      context: utahCtx,
      cache: failingCache,
    });
    expect(outcomes[0].status).toBe("ok");
    expect(failingCache.put).toHaveBeenCalledOnce();
  });

  it("does not surface a cache.put failure to the caller", async () => {
    const failingCache: AdapterResultCache = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => {
        throw new Error("DB write failed");
      }),
    };
    const adapter = makeAdapter({
      key: "fema:nfhl",
      tier: "federal",
    });
    const outcomes = await runAdapters({
      adapters: [adapter],
      context: utahCtx,
      cache: failingCache,
    });
    expect(outcomes[0].status).toBe("ok");
    expect(outcomes[0].result?.payload).toEqual({
      kind: "test",
      value: "fema:nfhl",
    });
  });

  it("attaches a fresh upstream-freshness verdict from the adapter on a cache hit (Task #227)", async () => {
    const cache = new InMemoryCache();
    const cachedResult: AdapterResult = {
      adapterKey: "fema:nfhl-flood-zone",
      tier: "federal",
      layerKind: "fema-nfhl-flood-zone",
      sourceKind: "federal-adapter",
      provider: "FEMA",
      snapshotDate: "2025-12-01T00:00:00.000Z",
      payload: { kind: "flood-zone", floodZone: "AE" },
    };
    const cachedAt = new Date("2026-04-30T12:00:00.000Z");
    cache.store.set("fema:nfhl-flood-zone|38.5733|-109.5499", {
      result: cachedResult,
      cachedAt,
    });
    const freshnessHook = vi.fn(async () => ({
      status: "fresh" as const,
      reason: "Upstream layer matches the cached snapshot.",
    }));
    const adapter: Adapter = {
      ...makeAdapter({ key: "fema:nfhl-flood-zone", tier: "federal" }),
      getUpstreamFreshness: freshnessHook,
    };
    const outcomes = await runAdapters({
      adapters: [adapter],
      context: utahCtx,
      cache,
    });
    expect(outcomes[0].fromCache).toBe(true);
    expect(outcomes[0].upstreamFreshness).toEqual({
      status: "fresh",
      reason: "Upstream layer matches the cached snapshot.",
    });
    expect(freshnessHook).toHaveBeenCalledOnce();
    const callArg = freshnessHook.mock.calls[0][0] as {
      ctx: AdapterContext;
      cachedAt: Date;
    };
    expect(callArg.cachedAt.toISOString()).toBe(cachedAt.toISOString());
  });

  it("attaches a stale upstream-freshness verdict on a cache hit when the adapter says the feed has moved (Task #227)", async () => {
    const cache = new InMemoryCache();
    const cachedResult: AdapterResult = {
      adapterKey: "fema:nfhl-flood-zone",
      tier: "federal",
      layerKind: "fema-nfhl-flood-zone",
      sourceKind: "federal-adapter",
      provider: "FEMA",
      snapshotDate: "2025-12-01T00:00:00.000Z",
      payload: { kind: "flood-zone", floodZone: "AE" },
    };
    cache.store.set("fema:nfhl-flood-zone|38.5733|-109.5499", {
      result: cachedResult,
      cachedAt: new Date("2026-04-30T12:00:00.000Z"),
    });
    const adapter: Adapter = {
      ...makeAdapter({ key: "fema:nfhl-flood-zone", tier: "federal" }),
      getUpstreamFreshness: async () => ({
        status: "stale" as const,
        reason: "Upstream published a newer revision at 2026-05-01T00:00:00Z.",
      }),
    };
    const outcomes = await runAdapters({
      adapters: [adapter],
      context: utahCtx,
      cache,
    });
    expect(outcomes[0].fromCache).toBe(true);
    expect(outcomes[0].upstreamFreshness?.status).toBe("stale");
    expect(outcomes[0].upstreamFreshness?.reason).toContain("newer revision");
  });

  it("collapses a thrown freshness hook into an unknown verdict without breaking the cache hit (Task #227)", async () => {
    const cache = new InMemoryCache();
    cache.store.set("fema:nfhl-flood-zone|38.5733|-109.5499", {
      result: {
        adapterKey: "fema:nfhl-flood-zone",
        tier: "federal",
        layerKind: "fema-nfhl-flood-zone",
        sourceKind: "federal-adapter",
        provider: "FEMA",
        snapshotDate: "2025-12-01T00:00:00.000Z",
        payload: { kind: "flood-zone" },
      },
      cachedAt: new Date("2026-04-30T12:00:00.000Z"),
    });
    const adapter: Adapter = {
      ...makeAdapter({ key: "fema:nfhl-flood-zone", tier: "federal" }),
      getUpstreamFreshness: async () => {
        throw new Error("metadata endpoint timed out");
      },
    };
    const outcomes = await runAdapters({
      adapters: [adapter],
      context: utahCtx,
      cache,
    });
    expect(outcomes[0].status).toBe("ok");
    expect(outcomes[0].fromCache).toBe(true);
    expect(outcomes[0].upstreamFreshness?.status).toBe("unknown");
    expect(outcomes[0].upstreamFreshness?.reason).toContain("metadata endpoint timed out");
  });

  it("leaves upstreamFreshness null on cache hits whose adapter does not implement the hook (Task #227)", async () => {
    const cache = new InMemoryCache();
    cache.store.set("fema:nfhl-flood-zone|38.5733|-109.5499", {
      result: {
        adapterKey: "fema:nfhl-flood-zone",
        tier: "federal",
        layerKind: "fema-nfhl-flood-zone",
        sourceKind: "federal-adapter",
        provider: "FEMA",
        snapshotDate: "2025-12-01T00:00:00.000Z",
        payload: { kind: "flood-zone" },
      },
      cachedAt: new Date("2026-04-30T12:00:00.000Z"),
    });
    const adapter = makeAdapter({
      key: "fema:nfhl-flood-zone",
      tier: "federal",
    });
    const outcomes = await runAdapters({
      adapters: [adapter],
      context: utahCtx,
      cache,
    });
    expect(outcomes[0].fromCache).toBe(true);
    expect(outcomes[0].upstreamFreshness).toBeNull();
  });

  it("leaves upstreamFreshness null on live (non-cached) runs (Task #227)", async () => {
    const cache = new InMemoryCache();
    const adapter: Adapter = {
      ...makeAdapter({ key: "fema:nfhl-flood-zone", tier: "federal" }),
      getUpstreamFreshness: async () => ({ status: "fresh" as const }),
    };
    const outcomes = await runAdapters({
      adapters: [adapter],
      context: utahCtx,
      cache,
    });
    expect(outcomes[0].fromCache).toBe(false);
    expect(outcomes[0].upstreamFreshness).toBeNull();
  });

  it("skips the cache when the parcel coordinates are not finite", async () => {
    const cache = new InMemoryCache();
    const runMock = vi.fn(async () => ({
      adapterKey: "fema:nfhl",
      tier: "federal" as const,
      layerKind: "fema-nfhl",
      sourceKind: "federal-adapter" as const,
      provider: "FEMA",
      snapshotDate: "2026-01-01T00:00:00.000Z",
      payload: { kind: "test" },
    }));
    const adapter = makeAdapter({
      key: "fema:nfhl",
      tier: "federal",
      runMock,
    });
    await runAdapters({
      adapters: [adapter],
      context: {
        parcel: { latitude: NaN, longitude: NaN },
        jurisdiction: { stateKey: "utah", localKey: null },
      },
      cache,
    });
    expect(cache.getCalls).toHaveLength(0);
    expect(cache.putCalls).toHaveLength(0);
    expect(runMock).toHaveBeenCalledOnce();
  });
});
