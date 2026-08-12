/**
 * run_zoning_discovery.mjs — resume hole fix and BOM strip (CP1, 2026-08-12).
 */
import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs has no type declarations
import { stripBom, buildSkipSet, buildQueue } from "../run-zoning-discovery-lib.mjs";

describe("run-zoning-discovery-lib — resume hole fix", () => {
  const inputQueue = [
    { cityKey: "bartonville-tx", cityName: "Bartonville" },
    { cityKey: "deer-park-tx", cityName: "Deer Park" },
    { cityKey: "houston-tx", cityName: "Houston" },
  ];

  it("halted city is NOT excluded from queue when landed is empty", () => {
    const progress = {
      landed: [],
      halted: { cityKey: "deer-park-tx", reason: "test-halt" },
    };
    const skip = buildSkipSet(progress);
    expect(skip.has("deer-park-tx")).toBe(false);

    const queue = buildQueue(inputQueue, progress);
    expect(queue.map((c) => c.cityKey)).toContain("deer-park-tx");
    expect(queue.length).toBe(3);
  });

  it("landed cityKeys are excluded from queue", () => {
    const progress = {
      landed: [{ cityKey: "bartonville-tx", status: "LAYER-FOUND" }],
      halted: null,
    };
    const queue = buildQueue(inputQueue, progress);
    expect(queue.map((c) => c.cityKey)).toEqual(["deer-park-tx", "houston-tx"]);
  });

  it("halted city moves to front when not landed", () => {
    const progress = {
      landed: [],
      halted: { cityKey: "houston-tx", reason: "apply-failed" },
    };
    const queue = buildQueue(inputQueue, progress);
    expect(queue[0]!.cityKey).toBe("houston-tx");
  });

  it("halted city that is already landed is ignored for queue ordering", () => {
    const progress = {
      landed: [{ cityKey: "houston-tx", status: "NO-EUCLIDEAN-REGIME" }],
      halted: { cityKey: "houston-tx", reason: "stale-halt" },
    };
    const queue = buildQueue(inputQueue, progress);
    expect(queue.map((c) => c.cityKey)).toEqual(["bartonville-tx", "deer-park-tx"]);
  });
});

describe("run-zoning-discovery-lib — BOM strip", () => {
  it("strips UTF-8 BOM prefix from progress JSON text", () => {
    const raw = `\uFEFF{"landed":[],"halted":null}`;
    expect(stripBom(raw)).toBe('{"landed":[],"halted":null}');
    expect(JSON.parse(stripBom(raw))).toEqual({ landed: [], halted: null });
  });
});
