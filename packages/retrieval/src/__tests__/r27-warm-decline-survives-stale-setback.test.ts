import { describe, expect, it } from "vitest";
import type {
  PropertyAtomInstance,
  StoredAtomInstance,
} from "@hauska-engine/atoms";
import { InMemoryStorage } from "@hauska-engine/storage";

import { HybridRetrieval } from "../index.js";
import { envelopeServeIndependentOfStaleSetback } from "../envelope-serve-independent.js";

const PARCEL = "48021:141364";

function writeAtom(storage: InMemoryStorage, body: Record<string, unknown>) {
  return storage.writePropertyAtom(body as unknown as PropertyAtomInstance);
}

function asStoredAtom(body: Record<string, unknown>): StoredAtomInstance {
  return body as unknown as StoredAtomInstance;
}

describe("envelopeServeIndependentOfStaleSetback", () => {
  it("returns true for warm-verify decline envelopes", () => {
    expect(
      envelopeServeIndependentOfStaleSetback(
        asStoredAtom({
          entityType: "buildable-envelope",
          entityId: PARCEL,
          warmVerifyDeclineCode: "superseded-prop-id",
          warmVerifyDecline: "prop_id absent from county cadastral",
        }),
      ),
    ).toBe(true);
  });

  it("returns false for breadth-bake dependent envelopes", () => {
    expect(
      envelopeServeIndependentOfStaleSetback(
        asStoredAtom({
          entityType: "buildable-envelope",
          entityId: PARCEL,
          sourceCitation: "breadth tier1 bake",
        }),
      ),
    ).toBe(false);
  });

  // Consumer-compat pin (REASON-OVERSTATES fix, 2026-08-04): this check is a
  // generic non-empty-string test on warmVerifyDeclineCode, so BOTH cascade
  // decline codes — the pre-existing unincorporated-cohort code and the new
  // in-city-but-unonboarded code — must be treated as an honest, serve-
  // independent decline with no code-string branching required here.
  it("returns true for both unzoned-county cascade decline codes (additive, no branching needed)", () => {
    expect(
      envelopeServeIndependentOfStaleSetback(
        asStoredAtom({
          entityType: "buildable-envelope",
          entityId: PARCEL,
          warmVerifyDeclineCode: "unzoned-no-district-basis",
          warmVerifyDecline:
            "unzoned jurisdiction — no district basis for setbacks or envelope",
        }),
      ),
    ).toBe(true);
    expect(
      envelopeServeIndependentOfStaleSetback(
        asStoredAtom({
          entityType: "buildable-envelope",
          entityId: PARCEL,
          warmVerifyDeclineCode: "no-district-on-record",
          warmVerifyDecline: "no district on record — jurisdiction not yet onboarded",
        }),
      ),
    ).toBe(true);
  });
});

describe("getPropertyAtomChain — R27 warm decline survives stale setback suppression", () => {
  it("keeps warmVerifyDecline envelope when descriptor-fixture setback is suppressed", async () => {
    const storage = new InMemoryStorage();
    await writeAtom(storage, {
      entityType: "zoning-fact",
      entityId: PARCEL,
      parcelNodeId: PARCEL,
      district: "MU",
      sourceAdapter: "txgio-zoning-stamp:bastrop-city-tx",
      accessPolicy: "public-free",
    });
    await writeAtom(storage, {
      entityType: "setback-rule",
      entityId: PARCEL,
      parcelNodeId: PARCEL,
      sourceAdapter: "descriptor-fixture",
      front: 15,
      side: 5,
      rear: 15,
      accessPolicy: "public-free",
    });
    await writeAtom(storage, {
      entityType: "buildable-envelope",
      entityId: PARCEL,
      parcelNodeId: PARCEL,
      recipeVersion: "1.0.0",
      sourceCitation: "depth-warm-verify-decline",
      warmVerifyDeclineCode: "superseded-prop-id",
      warmVerifyDecline: "prop_id 141364 absent from county cadastral — superseded",
      outcome: { kind: "no-buildable-area", reason: "superseded" },
      extractedAt: "2026-08-03T15:11:03.320Z",
      accessPolicy: "public-free",
    });

    const retrieval = new HybridRetrieval(storage);
    const chain = await retrieval.getPropertyAtomChain(PARCEL);

    expect(chain.setbackRule).toBeNull();
    expect(chain.buildableEnvelope).not.toBeNull();
    const buildableEnvelope = chain.buildableEnvelope as
      | (StoredAtomInstance & { warmVerifyDeclineCode?: string })
      | null;
    expect(buildableEnvelope?.warmVerifyDeclineCode).toBe("superseded-prop-id");
    expect(chain.atoms.some((a) => a.type === "buildable-envelope")).toBe(true);
    expect(chain.atoms.some((a) => a.type === "setback-rule")).toBe(false);
  });
});
