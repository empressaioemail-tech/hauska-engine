import { describe, it, expect } from "vitest";

import { contentHashExcludingProvenance } from "../confidence.js";

// A6 (OPS-3 I2, rewarm-determinism): the atom content hash must be independent
// of provenance timestamps, so two rewarms of the SAME content produce the SAME
// hash (persisted==recompute, R10, can hold). Different CONTENT must still hash
// differently.
describe("content hash excludes provenance (rewarm-determinism)", () => {
  it("same content, different timestamps → SAME hash", () => {
    const a = {
      district: "SF-1",
      setback: { front: 25, side: 5, rear: 25 },
      geometry: [[0, 0], [1, 0], [1, 1]],
      recipeVersion: "1.0.0",
      extractedAt: "2026-08-02T10:00:00.000Z",
      readContract: { assembledAt: "2026-08-02T10:00:00.000Z" },
      versionStamp: "48021:TEST:setback-rule:1:2026-08-02T10:00:00.000Z",
    };
    const b = {
      ...a,
      // Only the timestamps differ — a later rewarm of identical content.
      extractedAt: "2026-09-15T22:33:44.000Z",
      readContract: { assembledAt: "2026-09-15T22:33:44.000Z" },
      versionStamp: "48021:TEST:setback-rule:1:2026-09-15T22:33:44.000Z",
    };
    expect(contentHashExcludingProvenance(a)).toBe(
      contentHashExcludingProvenance(b),
    );
  });

  it("different content → DIFFERENT hash (a real change is still detected)", () => {
    const base = {
      district: "SF-1",
      setback: { front: 25, side: 5, rear: 25 },
      extractedAt: "2026-08-02T10:00:00.000Z",
    };
    const changed = {
      ...base,
      setback: { front: 20, side: 5, rear: 20 }, // GC values — real content change
    };
    expect(contentHashExcludingProvenance(base)).not.toBe(
      contentHashExcludingProvenance(changed),
    );
  });

  it("strips nested provenance keys recursively", () => {
    const withProv = {
      x: 1,
      nested: { y: 2, fetchedAt: "t1", deep: { z: 3, assertedAt: "t2" } },
    };
    const withoutProv = { x: 1, nested: { y: 2, deep: { z: 3 } } };
    expect(contentHashExcludingProvenance(withProv)).toBe(
      contentHashExcludingProvenance(withoutProv),
    );
  });
});
