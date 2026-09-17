/**
 * P-260 falsifier 2 — "editing one side of the setback pair alone makes the
 * divergence test fail".
 *
 * The pair is (corpus key universe, engine policy). Before this lane the engine
 * kept a hand-written 15-key list beside a 43-key corpus and nothing compared
 * them, so a corpus merge could add a jurisdiction that no engine surface would
 * ever serve, or say why. These cases are the comparison: every corpus key must
 * have a policy row, no policy row may name a key the corpus does not carry, a
 * served key must resolve a real table, and an unserved key must state its
 * reason. Edit either side alone and one of them fails.
 */
import { describe, expect, it } from "vitest";
import {
  SETBACK_JURISDICTION_KEYS as CORPUS_JURISDICTION_KEYS,
} from "@empressaio/setback-corpus";

import {
  getSetbackTable,
  listNotServedSetbackJurisdictions,
  SERVED_JURISDICTION_KEYS,
  SETBACK_ENGINE_REGISTRY,
  SETBACK_LOOKUP_KEYS,
} from "../index.js";

describe("P-260 — the engine's setback registry is total over the corpus's key universe", () => {
  it("gives every corpus key a policy row (a corpus addition alone fails here)", () => {
    const rows = new Set(SETBACK_ENGINE_REGISTRY.map((r) => r.key));
    const missing = CORPUS_JURISDICTION_KEYS.filter((k) => !rows.has(k));
    expect(
      missing,
      "the corpus carries keys this engine has NO policy for — add a served row " +
        "with its routing arm or an unserved row with its reason",
    ).toEqual([]);
    // Count form of the same claim: no row is a duplicate masking a gap.
    expect(SETBACK_ENGINE_REGISTRY.length).toBe(CORPUS_JURISDICTION_KEYS.length);
  });

  it("names no key the corpus does not carry (an engine edit alone fails here)", () => {
    const corpus = new Set(CORPUS_JURISDICTION_KEYS);
    const extra = SETBACK_ENGINE_REGISTRY.filter((r) => !corpus.has(r.key)).map(
      (r) => r.key,
    );
    expect(
      extra,
      "the engine's registry names keys the corpus does not carry — the engine " +
        "would throw at module load on one of these",
    ).toEqual([]);
  });

  it("serves exactly the keys it declares served, and each resolves a real table", () => {
    const declared = SETBACK_ENGINE_REGISTRY.filter((r) => r.served).map((r) => r.key);
    expect([...SERVED_JURISDICTION_KEYS].sort()).toEqual([...declared].sort());
    expect(SERVED_JURISDICTION_KEYS.length).toBeGreaterThan(0);
    for (const key of SETBACK_LOOKUP_KEYS) {
      const table = getSetbackTable(key);
      expect(table, `${key} is declared served but resolves no table`).not.toBeNull();
      expect(table!.districts.length).toBeGreaterThan(0);
    }
  });

  it("states a reason for every unserved key — a city with no ruled table is never silent", () => {
    const unserved = listNotServedSetbackJurisdictions();
    expect(unserved.length).toBeGreaterThan(0);
    for (const row of unserved) {
      expect(row.reason.trim().length, `${row.key} has an empty reason`).toBeGreaterThan(20);
    }
    // The withheld pair is named, not merely counted: these two were withheld by
    // ruling before this lane and must not silently become "notWired".
    const withheld = unserved.filter((r) => /withheld/.test(r.reason)).map((r) => r.key);
    expect(withheld.sort()).toEqual(["georgetown-tx", "san-marcos-tx"]);
  });

  it("carries the corpus's 1.4.0 growth (the 78 districts P-299 measured) in the registry", () => {
    // Lakeway is the corpus's own 1.4.0 addition and one of the largest lane-e
    // gaps; if it is absent from the corpus this lane's premise moved.
    expect(CORPUS_JURISDICTION_KEYS).toContain("lakeway-tx");
    expect(SETBACK_ENGINE_REGISTRY.map((r) => r.key)).toContain("lakeway-tx");
    expect(SERVED_JURISDICTION_KEYS).not.toContain("lakeway-tx");
  });
});
