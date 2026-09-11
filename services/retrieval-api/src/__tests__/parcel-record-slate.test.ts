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
 */
const EXPECTED_SLATE_HASH =
  "1dc82a7e3d70aabc4a2cb06615806fe5bc36b27b776b9da21ef1b3d4b8197077";

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
});
