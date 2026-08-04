import { describe, expect, it } from "vitest";

import { buildHonestVerifyDeclineAtom } from "../honest-decline-promote.js";
import { RECIPE_VERSION } from "../types.js";
import type { JurisdictionDescriptor } from "../../property-reasoning/types.js";

const descriptor: JurisdictionDescriptor = {
  key: "test_jurisdiction",
  displayName: "Test Jurisdiction",
  jurisdictionTenant: "test_tenant",
  parcelFips: "00000",
  defaultAccessPolicy: "public-free",
  sourceAdapter: "test-adapter",
  sourceUrl: "https://example.test/source",
};

describe("buildHonestVerifyDeclineAtom (extracted from promoteHonestVerifyDecline, R27 shape)", () => {
  it("builds a no-buildable-area envelope decline citing the zoning-fact and carrying the recipe version + decline code", () => {
    const atom = buildHonestVerifyDeclineAtom({
      parcelNodeId: "00000:TEST-1",
      zoningFactAtomDid: "did:hauska:zoning-fact:00000:TEST-1",
      descriptor,
      verifyReasons: ["mechanical verify failed: front orientation mismatch"],
      declineCode: "front-orientation",
      extractedAt: "2026-08-03T00:00:00.000Z",
    });

    expect(atom.entityType).toBe("buildable-envelope");
    expect(atom.outcome).toMatchObject({
      kind: "no-buildable-area",
      reason: "mechanical verify failed: front orientation mismatch",
    });
    expect(atom.recipeVersion).toBe(RECIPE_VERSION);
    expect(atom.warmVerifyDeclineCode).toBe("front-orientation");
    expect(atom.warmVerifyDecline).toBe(
      "mechanical verify failed: front orientation mismatch",
    );
    // Omits depthWarmPromotion so cert roster / warm-decline short-circuit
    // exclude it from the promoted-and-stale-residue path.
    expect((atom as Record<string, unknown>).depthWarmPromotion).toBeUndefined();
    expect(atom.contentHash).toBeTruthy();
  });

  it("is a pure builder — same inputs (incl. extractedAt) produce the same atomDid and contentHash", () => {
    const input = {
      parcelNodeId: "00000:TEST-2",
      zoningFactAtomDid: "did:hauska:zoning-fact:00000:TEST-2",
      descriptor,
      verifyReasons: ["reason-a"],
      declineCode: "code-a",
      extractedAt: "2026-08-03T00:00:00.000Z",
    };
    const a = buildHonestVerifyDeclineAtom(input);
    const b = buildHonestVerifyDeclineAtom(input);
    expect(a.atomDid).toBe(b.atomDid);
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("truncates verifyReasons to the first 3 and joins with '; ', falling back to a default reason when empty", () => {
    const atom = buildHonestVerifyDeclineAtom({
      parcelNodeId: "00000:TEST-3",
      zoningFactAtomDid: "did:hauska:zoning-fact:00000:TEST-3",
      descriptor,
      verifyReasons: ["r1", "r2", "r3", "r4"],
      declineCode: "code-b",
    });
    expect(atom.warmVerifyDecline).toBe("r1; r2; r3");

    const fallback = buildHonestVerifyDeclineAtom({
      parcelNodeId: "00000:TEST-4",
      zoningFactAtomDid: "did:hauska:zoning-fact:00000:TEST-4",
      descriptor,
      verifyReasons: [],
      declineCode: "code-c",
    });
    expect(fallback.warmVerifyDecline).toBe(
      "Mechanical warm verify failed — honest decline.",
    );
  });
});
