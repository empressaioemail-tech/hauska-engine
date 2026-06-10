import { describe, expect, it } from "vitest";
import { runAdapters } from "../runner";
import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
} from "../types";

const ctx: AdapterContext = {
  parcel: { latitude: 38.5733, longitude: -109.5498 },
  jurisdiction: { stateKey: "utah", localKey: "grand-county-ut" },
};

function makeAdapter(opts: {
  key: string;
  applies?: boolean;
  throws?: AdapterRunError | Error;
  delayMs?: number;
  timeoutMs?: number;
}): Adapter {
  return {
    adapterKey: opts.key,
    tier: "state",
    sourceKind: "state-adapter",
    layerKind: opts.key.replace(":", "-"),
    provider: "Test",
    jurisdictionGate: { state: "utah" },
    timeoutMs: opts.timeoutMs,
    appliesTo: () => opts.applies ?? true,
    async run(runCtx) {
      if (opts.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, opts.delayMs);
          // React to the abort signal the runner forwards in so the
          // timeout test exercises the runner's cancellation path.
          runCtx.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }
      if (opts.throws) throw opts.throws;
      return {
        adapterKey: opts.key,
        tier: "state",
        layerKind: opts.key.replace(":", "-"),
        sourceKind: "state-adapter",
        provider: "Test",
        snapshotDate: new Date().toISOString(),
        payload: { kind: "test", value: opts.key },
      };
    },
  };
}

describe("runAdapters", () => {
  it("emits one outcome per adapter — success path", async () => {
    const outcomes = await runAdapters({
      adapters: [makeAdapter({ key: "ugrc:dem" }), makeAdapter({ key: "ugrc:parcels" })],
      context: ctx,
    });
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.status === "ok")).toBe(true);
    expect(outcomes.map((o) => o.adapterKey).sort()).toEqual([
      "ugrc:dem",
      "ugrc:parcels",
    ]);
  });

  it("isolates a single adapter failure from the rest of the batch", async () => {
    const outcomes = await runAdapters({
      adapters: [
        makeAdapter({ key: "ugrc:dem" }),
        makeAdapter({
          key: "ugrc:parcels",
          throws: new AdapterRunError("upstream-error", "503 Service Unavailable"),
        }),
        makeAdapter({ key: "ugrc:address-points" }),
      ],
      context: ctx,
    });
    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    expect(byKey["ugrc:dem"].status).toBe("ok");
    expect(byKey["ugrc:parcels"].status).toBe("failed");
    expect(byKey["ugrc:parcels"].error?.code).toBe("upstream-error");
    expect(byKey["ugrc:parcels"].error?.message).toContain("503");
    expect(byKey["ugrc:address-points"].status).toBe("ok");
  });

  it("records adapters that don't apply as no-coverage rather than dropping them", async () => {
    const outcomes = await runAdapters({
      adapters: [
        makeAdapter({ key: "ugrc:dem" }),
        makeAdapter({ key: "tceq:edwards-aquifer", applies: false }),
      ],
      context: ctx,
    });
    expect(outcomes).toHaveLength(2);
    const skipped = outcomes.find((o) => o.adapterKey === "tceq:edwards-aquifer");
    expect(skipped?.status).toBe("no-coverage");
    expect(skipped?.error?.code).toBe("no-coverage");
  });

  it("translates an unknown throw into an `unknown` error code", async () => {
    const outcomes = await runAdapters({
      adapters: [
        makeAdapter({ key: "ugrc:dem", throws: new Error("boom") }),
      ],
      context: ctx,
    });
    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[0].error?.code).toBe("unknown");
    expect(outcomes[0].error?.message).toBe("boom");
  });

  it("converts AbortError into a `timeout` outcome when the per-adapter deadline fires", async () => {
    const outcomes = await runAdapters({
      adapters: [makeAdapter({ key: "ugrc:dem", delayMs: 100 })],
      context: { ...ctx, timeoutMs: 10 },
    });
    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[0].error?.code).toBe("timeout");
  });

  it("a per-adapter `timeoutMs` widens only that adapter's budget — a sibling without the floor still times out (QA-22)", async () => {
    // The context budget is deliberately tight (10ms). The first
    // adapter carries a 500ms `timeoutMs` floor (mirroring the QA-22
    // slow-upstream adapters), so the runner's
    // `max(adapter.timeoutMs, context.timeoutMs)` gives it room to
    // finish its 60ms of work. The sibling has no floor, so it stays
    // capped at the 10ms context budget and times out — proving the
    // widening is per-adapter, not a global escape hatch.
    const outcomes = await runAdapters({
      adapters: [
        makeAdapter({ key: "epa:ejscreen", delayMs: 60, timeoutMs: 500 }),
        makeAdapter({ key: "ugrc:dem", delayMs: 60 }),
      ],
      context: { ...ctx, timeoutMs: 10 },
    });
    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    expect(byKey["epa:ejscreen"].status).toBe("ok");
    expect(byKey["ugrc:dem"].status).toBe("failed");
    expect(byKey["ugrc:dem"].error?.code).toBe("timeout");
  });
});
