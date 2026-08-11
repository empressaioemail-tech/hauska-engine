/**
 * run_sweep.mjs — resume hole fix and BOM strip (CP1, 2026-08-11).
 *
 * Imports pure helpers from run-sweep-lib.mjs only; the main runner is not
 * imported (top-level side effects would require out-dir/sizing.json).
 */
import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs has no type declarations
import { stripBom, buildSkipSet, buildQueue } from "../run-sweep-lib.mjs";

describe("run-sweep-lib — resume hole fix", () => {
  const sizingQueue = [
    { countyFips: "48001", features: 100, rows: 120 },
    { countyFips: "48457", features: 200, rows: 240 },
    { countyFips: "48141", features: 150, rows: 180 },
  ];

  it("halted county is NOT excluded from queue when landed is empty (resume hole fix)", () => {
    const progress = {
      landed: [],
      halted: { countyFips: "48457", stage: "dry-apply-mismatch", reason: "test" },
    };
    const skip = buildSkipSet(progress);
    expect(skip.has("48457")).toBe(false);

    const queue = buildQueue(sizingQueue, progress);
    const fipsInQueue = queue.map((c) => c.countyFips);
    expect(fipsInQueue).toContain("48457");
    expect(fipsInQueue.length).toBe(3);
  });

  it("landed counties are excluded from queue", () => {
    const progress = {
      landed: [{ countyFips: "48001" }],
      halted: null,
    };
    const queue = buildQueue(sizingQueue, progress);
    expect(queue.map((c) => c.countyFips)).toEqual(["48457", "48141"]);
  });

  it("halted county moves to front when not landed (resume pointer)", () => {
    const progress = {
      landed: [],
      halted: { countyFips: "48141", stage: "apply-failed" },
    };
    const queue = buildQueue(sizingQueue, progress);
    expect(queue[0]!.countyFips).toBe("48141");
    expect(queue.map((c) => c.countyFips)).toEqual(["48141", "48001", "48457"]);
  });

  it("halted county that is already landed is ignored for queue ordering", () => {
    const progress = {
      landed: [{ countyFips: "48141" }],
      halted: { countyFips: "48141", stage: "apply-failed" },
    };
    const queue = buildQueue(sizingQueue, progress);
    expect(queue.map((c) => c.countyFips)).toEqual(["48001", "48457"]);
  });
});

describe("run-sweep-lib — BOM strip", () => {
  it("strips UTF-8 BOM prefix from progress JSON text", () => {
    const bom = "\uFEFF";
    const raw = `${bom}{"landed":[],"halted":null}`;
    expect(stripBom(raw)).toBe('{"landed":[],"halted":null}');
    expect(JSON.parse(stripBom(raw))).toEqual({ landed: [], halted: null });
  });

  it("passes through text without BOM unchanged", () => {
    const raw = '{"landed":[{"countyFips":"48021"}]}';
    expect(stripBom(raw)).toBe(raw);
  });
});
