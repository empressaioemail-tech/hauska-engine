import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import parcelRecordSlateData from "../parcel-record-slate.json" with { type: "json" };

/**
 * P-152 dispatch step 2: "Port the slate as DATA ... never as a second
 * hand-typed list." This is the divergence guard for that copy.
 *
 * This test does not reach across the repo boundary to diff against
 * legacy-design-tools' live `PARCEL_RECORD_SLATE` directly (no CI job here
 * can read another repo's working tree) — it guards against SILENT drift
 * of THIS copy by pinning a content hash. When resyncing this file from
 * LDT's current slate: update `slate`, `sourceCommit`, and `vendoredAt` in
 * parcel-record-slate.json AND `EXPECTED_SLATE_HASH` below together, in the
 * same commit that records the LDT commit it was copied from. A hash
 * change with no corresponding LDT-side resync note is itself a review flag.
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
 * this file are byte-for-byte the same 152-entry set as of this commit
 * (diffed directly, not assumed).
 */
const EXPECTED_SLATE_HASH =
  "89afce1401f978998ad68703b2f85ad933253713922754456b5f5f0e35076adc";

function slateHash(slate: readonly string[]): string {
  const sorted = [...slate].sort();
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

describe("parcel-record-slate.json (P-152 vendored copy divergence guard)", () => {
  it("carries provenance back to the legacy-design-tools commit it was copied from", () => {
    expect(parcelRecordSlateData.sourceRepo).toBe("legacy-design-tools");
    expect(typeof parcelRecordSlateData.sourceCommit).toBe("string");
    expect(parcelRecordSlateData.sourceCommit.length).toBeGreaterThan(0);
  });

  it("has not silently drifted from its last deliberate vendor/resync", () => {
    expect(slateHash(parcelRecordSlateData.slate)).toBe(EXPECTED_SLATE_HASH);
  });

  it("contains only well-formed {countyFips}:{railKey} entries", () => {
    for (const entry of parcelRecordSlateData.slate) {
      expect(entry).toMatch(/^\d{5}:[A-Za-z][A-Za-z0-9]*$/);
    }
  });

  it("does not carry the six stale 48209 (Hays) dollar/structural-rail entries LDT's PR #671 (fix(P-177)) removed for a live CAD-account collision -- regression guard for the 2026-09-13 P-152 lane 6 resync finding", () => {
    for (const rail of ["marketValue", "assessedValue", "landValue", "improvementValue", "livingAreaSqft", "yearBuilt"]) {
      expect(parcelRecordSlateData.slate).not.toContain(`48209:${rail}`);
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
  it("the five representative-key siblings each carry their own independent entry wherever their own parcel_gate_verdict passes (Hays excluded from the three setback siblings, matching its own 'excluded' verdict)", () => {
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
    // Hays stays out of the three setback siblings -- its own gate verdict is 'excluded', not an oversight.
    for (const rail of ["setbackSideFt", "setbackRearFt", "setbackCornerFt"]) {
      expect(parcelRecordSlateData.slate).not.toContain(`48209:${rail}`);
    }
  });
});
