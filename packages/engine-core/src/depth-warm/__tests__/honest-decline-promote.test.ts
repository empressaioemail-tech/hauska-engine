import { describe, expect, it } from "vitest";

import { BUILDABLE_ENVELOPE_SCHEMA } from "@empressaio/atom-contract/property";
import { BUILDABLE_ENVELOPE_ABSENCE_KINDS } from "@empressaio/atom-contract/property";

import {
  buildHonestVerifyDeclineAtom,
  resolveEnvelopeDeclineCode,
  resolveEnvelopeDeclineReason,
} from "../honest-decline-promote.js";
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
    expect(atom.absence?.kind).toBe("front-orientation");
    expect(atom.absence?.reason).toBe(
      "mechanical verify failed: front orientation mismatch",
    );
    expect(atom.verifiedAbsence?.evaluated).toBe(true);
    expect(atom.verifiedAbsence?.provenanceScope.length).toBeGreaterThan(0);
    // Dual-write legacy fields for pre-migration readers.
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
      declineCode: "null-inset",
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
      declineCode: "geometry",
    });
    expect(atom.warmVerifyDecline).toBe("r1; r2; r3");
    expect(atom.absence?.reason).toBe("r1; r2; r3");

    const fallback = buildHonestVerifyDeclineAtom({
      parcelNodeId: "00000:TEST-4",
      zoningFactAtomDid: "did:hauska:zoning-fact:00000:TEST-4",
      descriptor,
      verifyReasons: [],
      declineCode: "other-verify-fail",
    });
    expect(fallback.warmVerifyDecline).toBe(
      "Mechanical warm verify failed — honest decline.",
    );
  });

  it("round-trips every live decline code through the contract absence shape", () => {
    expect(BUILDABLE_ENVELOPE_ABSENCE_KINDS).toHaveLength(14);
    for (const [i, kind] of BUILDABLE_ENVELOPE_ABSENCE_KINDS.entries()) {
      const atom = buildHonestVerifyDeclineAtom({
        parcelNodeId: `48021:KIND-${kind}`,
        zoningFactAtomDid: `did:hauska:zoning-fact:48021:KIND-${kind}`,
        descriptor,
        verifyReasons: [`reason for ${kind}`],
        declineCode: kind,
        extractedAt: "2026-08-09T00:00:00.000Z",
      });
      expect(atom.absence?.kind).toBe(kind);
      expect(atom.warmVerifyDeclineCode).toBe(kind);
      // Engine persistence DIDs use did:hauska:*; contract Zod probes the
      // benvelope_<16-hex> card shape. Substitute only the identity field
      // when asserting the absence payload round-trips through the schema.
      const hex = (0xa000000000000000n + BigInt(i + 1)).toString(16).slice(0, 16);
      const contractSlice = {
        entityType: atom.entityType,
        atomDid: `benvelope_${hex}`,
        parcelNodeId: "48021:27303",
        reasoningChain: atom.reasoningChain,
        absence: atom.absence,
        verifiedAbsence: atom.verifiedAbsence,
        accessPolicy: atom.accessPolicy,
        sourceCitation: atom.sourceCitation,
        extractedAt: atom.extractedAt,
        atomTier: atom.atomTier,
        readContract: atom.readContract,
      };
      const parsed = BUILDABLE_ENVELOPE_SCHEMA.safeParse(contractSlice);
      expect(
        parsed.success,
        `contract parse failed for ${kind}: ${JSON.stringify(parsed.error?.issues)}`,
      ).toBe(true);
    }
  });

  it("maps unknown decline codes to other-verify-fail on absence.kind while dual-writing the raw code", () => {
    const atom = buildHonestVerifyDeclineAtom({
      parcelNodeId: "00000:UNKNOWN",
      zoningFactAtomDid: "did:hauska:zoning-fact:00000:UNKNOWN",
      descriptor,
      verifyReasons: ["mystery"],
      declineCode: "not-in-taxonomy",
      extractedAt: "2026-08-09T00:00:00.000Z",
    });
    expect(atom.absence?.kind).toBe("other-verify-fail");
    expect(atom.warmVerifyDeclineCode).toBe("not-in-taxonomy");
  });

  it("dual-reads: old-shaped atoms (warmVerifyDecline* only) still resolve", () => {
    const legacy = {
      warmVerifyDeclineCode: "superseded-prop-id",
      warmVerifyDecline: "prop_id absent from county cadastral",
      outcome: { kind: "no-buildable-area" as const, reason: "legacy" },
    };
    expect(resolveEnvelopeDeclineCode(legacy)).toBe("superseded-prop-id");
    expect(resolveEnvelopeDeclineReason(legacy)).toBe(
      "prop_id absent from county cadastral",
    );
  });

  it("dual-reads: new-shaped atoms prefer absence over legacy fields", () => {
    const modern = {
      absence: {
        kind: "no-setback-row" as const,
        reason: "no descriptor setback row",
      },
      verifiedAbsence: {
        evaluated: true as const,
        provenanceScope: ["depth-warm-verify"],
      },
      warmVerifyDeclineCode: "stale-should-not-win",
      warmVerifyDecline: "stale reason",
    };
    expect(resolveEnvelopeDeclineCode(modern)).toBe("no-setback-row");
    expect(resolveEnvelopeDeclineReason(modern)).toBe("no descriptor setback row");
  });
});
