import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import ldtSlateFixture from "../__fixtures__/ldt-parcel-record-slate-8e7218f7.json" with { type: "json" };
import parcelRecordSlateData from "../parcel-record-slate.json" with { type: "json" };

/**
 * P-152 dispatch step 2: "Port the slate as DATA ... never as a second
 * hand-typed list." This is the divergence guard for that copy.
 *
 * WHY THE HASH PIN ALONE COULD NOT BITE (P-282 finding, measured 2026-09-17).
 * A pinned hash of THIS file only answers "did anyone edit this file". It
 * cannot answer "did legacy-design-tools' slate move" — and that is the drift
 * that actually happens: the copy sat at 3f5aa5f3 / 2026-09-13 with 152 pairs
 * while LDT main went to 8e7218f7 with 158, so the engine's reader kept five
 * Hays rails plus yearBuilt on their pre-cutover path after LDT had already
 * cut them over again. Nothing in this repo reads LDT at test time, so the
 * stale copy kept passing DELIBERATELY: a test in this file even asserted the
 * six pairs were ABSENT, because when it was written (2026-09-13) LDT's
 * fix(P-177) holdback had just removed them. The pin was never wrong about
 * this file; it was blind to the other repo.
 *
 * WHAT NOW MAKES A STALE COPY FAIL. `__fixtures__/ldt-parcel-record-slate-<sha>.json`
 * is LDT's own PARCEL_RECORD_SLATE literal text at the commit this copy was
 * vendored from, byte-for-byte, with its sha256 — extracted by
 * `scripts/p299_slate_revendor.mjs` in the doc_repo, never retyped. The tests
 * below (a) re-hash that literal against a pinned digest, so an edit to the
 * vendored LDT bytes fails, and (b) compare the ENGINE's serving set against
 * the pairs parsed out of those bytes in BOTH directions, so a serving copy
 * that disagrees with LDT's actual literal fails. A resync must now move the
 * JSON, its `EXPECTED_SLATE_HASH`, this literal fixture and its digest together
 * in one commit — four places, one fact, per P-256b's lesson.
 *
 * WHAT THIS STILL CANNOT DO, named so nobody mistakes it for more than it is:
 * this still cannot detect that LDT moved an hour after the resync. That needs
 * a CI job that checks out legacy-design-tools at `sourceCommit` and re-runs
 * the extraction — hauska-engine's CI has no cross-repo checkout and no LDT
 * read token today (`.github/workflows/ci.yml` has zero references to
 * legacy-design-tools), so it is not buildable in this lane; the integration
 * seat is asked for it in this lane's close. The companion half is LDT pinning
 * the same literal digest in ITS test, so a slate change there fails there.
 *
 * P-152 lane 6 (OPS-23 A-140, 2026-09-13) resync: this copy had drifted
 * from LDT's own slate since 2026-09-11 (PR #417, never touched again) --
 * it was missing the five representative-key siblings LDT's own allowlist
 * never had either (now added to both, see the siblings coverage test
 * below) AND it still carried six 48209 (Hays) dollar/structural-rail
 * entries (marketValue/assessedValue/landValue/improvementValue/
 * livingAreaSqft/yearBuilt) that LDT's PR #671 (fix(P-177), merged
 * 2026-09-13) deliberately removed for a live CAD-account collision. Both
 * gaps are closed in this resync: LDT's current PARCEL_RECORD_SLATE and
 * this file are the same 152-entry set as of that commit (diffed directly,
 * not assumed).
 *
 * P-299/P-282 resync (OPS-24, 2026-09-17): LDT lifted that hold again —
 * 1ca3c7fe (fix(P-180): lift the P-177 Hays holdback from the six
 * PARCEL-B-SLATE2 record-overlay rails, 2026-09-13T19:30:31-05:00) — so the
 * six pairs are BACK, the set is 158 entries, and the assertion that pinned
 * their absence is inverted below rather than deleted (its history is why
 * the inversion is legible). Each added pair's `parcel_gate_verdict` read
 * `pass` in the production factory store (role `parcel_record_ro`, read-only)
 * on 2026-09-17T18:03:41Z-18:03:55Z, before this copy was written.
 */
const EXPECTED_SLATE_HASH =
  "7ce702652581b23a478f1e2e124b6babe1874bf983cca076a62e7643f1e1ba1c";

/** sha256 of LDT's PARCEL_RECORD_SLATE literal text at the vendored commit, as vendored by scripts/p299_slate_revendor.mjs. */
const LDT_SLATE_LITERAL_SHA256 =
  "def0791f82746613caf8b113534f7ed2457652905eb7ed95c7ac27290a9774cd";

const HAYS_RECORD_OVERLAY_RAILS = [
  "marketValue",
  "assessedValue",
  "landValue",
  "improvementValue",
  "livingAreaSqft",
  "yearBuilt",
] as const;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function slateHash(slate: readonly string[]): string {
  const sorted = [...slate].sort();
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

/** The pairs LDT's own literal declares, parsed from its bytes — not from a second list. */
function pairsFromLdtLiteral(literalText: string): string[] {
  return [...literalText.matchAll(/"(\d{5}:[A-Za-z][A-Za-z0-9]*)"/g)]
    .map((m) => m[1])
    .filter((pair): pair is string => typeof pair === "string");
}

describe("parcel-record-slate.json (P-152 vendored copy divergence guard)", () => {
  it("carries provenance back to the legacy-design-tools commit it was copied from", () => {
    expect(parcelRecordSlateData.sourceRepo).toBe("legacy-design-tools");
    expect(typeof parcelRecordSlateData.sourceCommit).toBe("string");
    // A named commit, not a branch or a merge base: the full 40-hex object id.
    expect(parcelRecordSlateData.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(parcelRecordSlateData.sourcePath).toBe(
      "artifacts/api-server/src/lib/parcelRecordAllowlist.ts",
    );
  });

  it("has not silently drifted from its last deliberate vendor/resync", () => {
    expect(slateHash(parcelRecordSlateData.slate)).toBe(EXPECTED_SLATE_HASH);
  });

  it("contains only well-formed {countyFips}:{railKey} entries", () => {
    for (const entry of parcelRecordSlateData.slate) {
      expect(entry).toMatch(/^\d{5}:[A-Za-z][A-Za-z0-9]*$/);
    }
  });

  /* --------- the cross-artifact half: this copy vs LDT's own bytes --------- */

  it("the vendored LDT literal is the bytes it claims to be (its digest is pinned, so an edit to the vendored LDT text fails here)", () => {
    expect(sha256(ldtSlateFixture.literalText)).toBe(LDT_SLATE_LITERAL_SHA256);
    expect(ldtSlateFixture.literalCount).toBe(pairsFromLdtLiteral(ldtSlateFixture.literalText).length);
    expect(ldtSlateFixture.literalCount).toBe(parcelRecordSlateData.slate.length);
  });

  it("the LDT literal fixture and the slate it guards name the SAME commit and path", () => {
    expect(ldtSlateFixture.sourceCommit).toBe(parcelRecordSlateData.sourceCommit);
    expect(ldtSlateFixture.sourcePath).toBe(parcelRecordSlateData.sourcePath);
    expect(ldtSlateFixture.sourceRepo).toBe(parcelRecordSlateData.sourceRepo);
  });

  it("BOTH DIRECTIONS: this serving copy equals LDT's own literal at the recorded commit -- a copy left behind by an LDT slate change fails here (this is the P-282 bite)", () => {
    const ldtPairs = pairsFromLdtLiteral(ldtSlateFixture.literalText);
    // The literal itself must be a set, or "equality" could hide a duplicate.
    expect(new Set(ldtPairs).size).toBe(ldtPairs.length);

    const engineSet = new Set(parcelRecordSlateData.slate);
    const ldtSet = new Set(ldtPairs);

    // Direction 1: everything LDT cut over is cut over here (the stale-copy failure).
    const missingHere = [...ldtSet].filter((p) => !engineSet.has(p)).sort();
    expect(missingHere).toEqual([]);
    // Direction 2: nothing is cut over here that LDT has not cut over (an invented pair fails).
    const inventedHere = [...engineSet].filter((p) => !ldtSet.has(p)).sort();
    expect(inventedHere).toEqual([]);
    expect(engineSet.size).toBe(ldtSet.size);
  });

  it("carries the six 48209 (Hays) record-overlay rails LDT's 1ca3c7fe (fix(P-180)) put back when it lifted PR #671's fix(P-177) holdback, and the engine serves them from the ledger", () => {
    // Inverted 2026-09-17 (P-299/P-282). This test previously asserted these six
    // were ABSENT, which was correct on 2026-09-13 and became the reason the
    // stale copy passed for four days. Kept as the same test, now asserting the
    // current hold state, with the hold and its lift both named.
    for (const rail of HAYS_RECORD_OVERLAY_RAILS) {
      expect(parcelRecordSlateData.slate).toContain(`48209:${rail}`);
      expect(ldtSlateFixture.literalText).toContain(`"48209:${rail}"`);
    }
  });

  /**
   * P-152 lane 6 (OPS-23 A-140): the retrieval-api reader (parcel-record-
   * reader.ts) iterates every rail key in this slate independently, with no
   * group/representative-key concept of its own -- unlike LDT's own
   * setbacksFactServeCutover.ts/zoningFactServeCutover.ts, which still gate
   * their whole group on one representative key. That makes THIS reader the
   * one place a sibling rail actually needs its own literal entry (R-9: one
   * reader). This test pins the exact expected sibling coverage so a future
   * resync that drops a sibling without a corresponding gate-verdict change
   * fails loudly here, not silently downstream in the reader.
   */
  it("the five representative-key siblings each carry their own independent entry wherever their own parcel_gate_verdict passes (Hays still excluded from the three setback siblings: an LDT slate decision this copy is not free to change)", () => {
    const siblingExpectations: Record<string, { representative: string; counties: string[] }> = {
      zoningJurisdictionKey: { representative: "zoningDistrict", counties: ["48021", "48055", "48209", "48309", "48453", "48491"] },
      zoningProvenance: { representative: "zoningDistrict", counties: ["48021", "48055", "48209", "48309", "48453", "48491"] },
      setbackSideFt: { representative: "setbackFrontFt", counties: ["48021", "48055", "48309", "48453", "48491"] },
      setbackRearFt: { representative: "setbackFrontFt", counties: ["48021", "48055", "48309", "48453", "48491"] },
      setbackCornerFt: { representative: "setbackFrontFt", counties: ["48021", "48055", "48309", "48453", "48491"] },
    };
    let total = 0;
    for (const [sibling, { representative, counties }] of Object.entries(siblingExpectations)) {
      for (const county of counties) {
        expect(parcelRecordSlateData.slate).toContain(`${county}:${sibling}`);
        // Grouping integrity: a sibling should never appear for a county whose representative is absent.
        expect(parcelRecordSlateData.slate).toContain(`${county}:${representative}`);
        total += 1;
      }
    }
    expect(total).toBe(27);
    // Hays stays out of the three setback siblings. Measured 2026-09-17: NOT
    // because its verdict refuses -- all four 48209 setback rails read `pass`
    // live (setbackSideFt/RearFt/CornerFt/FrontFt, evaluated
    // 2026-09-17T18:04:23Z-18:04:32Z, parcel_record_ro, read-only), so the
    // reason this test carried until today ("its own gate verdict is
    // 'excluded'") is measurably false now. The exclusion is LDT's own slate
    // decision, inherited from the pre-A-193 era when the verdict WAS the serve
    // switch; under A-193 an unslated pair keeps its pre-cutover path, so the
    // live consequence is that these three Hays rails still do not serve from
    // the ledger even though their cells exist and their verdict passes.
    // Slating them means editing LDT's literal, not this copy: raised in this
    // lane's close, never patched here.
    for (const rail of ["setbackSideFt", "setbackRearFt", "setbackCornerFt"]) {
      expect(parcelRecordSlateData.slate).not.toContain(`48209:${rail}`);
    }
  });
});
