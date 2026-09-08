import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";

import { composeParcelReportFacts } from "../report-model.js";

/**
 * P-120 R-04 latency fix.
 *
 * The 2026-09-08 canary measured 82.9s against production's 6.4s on the same
 * parcel: three live outbound reads running one after another on a path a
 * customer waits on synchronously. Correct reads, undeployable shape.
 *
 * Two properties are asserted here rather than assumed. The reads run
 * CONCURRENTLY, so the wall clock is the slowest read rather than their sum.
 * And each is BOUNDED, so a hanging source costs one family rather than the
 * whole document -- and reports `failed-this-run`, which is true, ours, and
 * never mistakable for a finding about the parcel.
 */

const geometry = { status: "absent" as const, reason: "not needed for this fixture" };
const drainage = { status: "absent" as const, reason: "not needed for this fixture" };
const centroid = { latitude: 30.1105, longitude: -97.3153 };
const ring: Array<[number, number]> = [
  [-97.3156, 30.1103],
  [-97.3151, 30.1103],
  [-97.3151, 30.1107],
  [-97.3156, 30.1107],
  [-97.3156, 30.1103],
];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function compose(resolvers: Record<string, unknown>, timeoutMs?: number) {
  return composeParcelReportFacts({
    parcelNodeId: "48021:52726",
    storage: new InMemoryStorage(),
    geometry,
    drainage,
    centroid,
    ringWgs84: ring,
    factResolvers: resolvers,
    ...(timeoutMs ? { factReadTimeoutMs: timeoutMs } : {}),
  } as never);
}

describe("fact-read budget", () => {
  it("runs the three reads CONCURRENTLY, not serially", async () => {
    // Each takes 300ms. Serial would be ~900ms; concurrent ~300ms. The
    // threshold sits between the two so it cannot pass by being merely fast.
    const slow = async <T>(value: T) => {
      await sleep(300);
      return value;
    };
    const started = Date.now();
    await compose({
      floodplain: () =>
        slow({
          acreage: { status: "absent", kind: "blocked-at-source", reason: "fixture" },
          firmPanel: { status: "absent", kind: "blocked-at-source", reason: "fixture" },
        }),
      soil: () => slow({ status: "absent", kind: "blocked-at-source", reason: "fixture" }),
      electricProvider: () =>
        slow({ status: "absent", kind: "blocked-at-source", reason: "fixture" }),
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(700);
  });

  it("VERIFIED BY VIOLATION: a hanging source costs ONE family, not the document", async () => {
    // Soil never resolves. Under the old serial-and-unbounded shape this
    // hung the whole report. It must now bound, and the OTHER families must
    // still compose.
    const started = Date.now();
    const model = await compose(
      {
        floodplain: async () => ({
          acreage: { status: "absent", kind: "clear", reason: "fixture" },
          firmPanel: { status: "absent", kind: "clear", reason: "fixture" },
        }),
        soil: () => new Promise(() => {}),
        electricProvider: async () => ({
          status: "absent",
          kind: "blocked-at-source",
          reason: "fixture",
        }),
      },
      250,
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2_000);
    expect(model.facts.soil).toMatchObject({ status: "absent", kind: "failed-this-run" });
    expect((model.facts.soil as { reason: string }).reason).toMatch(/read budget/);
    // The neighbours are unharmed, which is the point of bounding per-read.
    expect(model.facts.electricProvider).toMatchObject({ kind: "blocked-at-source" });
    expect(model.facts.floodplainAcreage).toMatchObject({ kind: "clear" });
  });

  it("a timeout is OUR failure, never a finding about the parcel", async () => {
    const model = await compose({ soil: () => new Promise(() => {}) }, 100);
    // failed-this-run is the only honest kind here. `clear` would assert the
    // parcel has no soil data; `blocked-at-source` would blame USDA for our
    // budget. Both would be false.
    expect(model.facts.soil).toMatchObject({ status: "absent", kind: "failed-this-run" });
  });

  it("unconfigured resolvers stay out-of-scope and cost no time", async () => {
    const started = Date.now();
    const model = await compose({});
    expect(Date.now() - started).toBeLessThan(500);
    for (const f of ["floodplainAcreage", "soil", "electricProvider"] as const) {
      expect(model.facts[f]).toMatchObject({ status: "absent", kind: "out-of-scope" });
    }
  });
});
