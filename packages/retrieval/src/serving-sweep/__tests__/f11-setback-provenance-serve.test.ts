import { describe, expect, it } from "vitest";
import { adaptAtomChainToBakedFacets } from "../vendor/atom-chain-to-facets.js";

describe("F-11 adaptAtomChainToBakedFacets provenance dispositions", () => {
  it("placeholder setback-rule emits unknown decline, not absent-verified and not table fallback", () => {
    const out = adaptAtomChainToBakedFacets({
      parcelNodeId: "48209:156346",
      zoningFact: {
        district: "RS",
        sourceAdapter: "txgio-zoning-stamp:san-marcos-tx",
      },
      setbackRule: {
        front: 25,
        side: 5,
        rear: 10,
        sourceAdapter: "property-atom-proof",
        sourceCodeAtomRef: {
          atomDid: "did:hauska:code-section:storage-port-proof/phase-1a",
        },
      },
      buildableEnvelope: {
        outcome: { kind: "buildable", areaSqFt: 5000 },
      },
    });
    expect(out?.facets.envelope?.status).toBe("declined");
    expect(out?.facets.envelope?.declineReason).toBe("setback-provenance-unknown");
    expect(out?.facets.envelope?.disclosure).toMatch(/storage-port-proof\/phase-1a/);
    expect(out?.facets.envelope?.setbacks).toBeUndefined();
  });

  it("McLennan-shaped envelope over zero rules is refused and names the cited DID", () => {
    const out = adaptAtomChainToBakedFacets({
      parcelNodeId: "48309:1",
      zoningFact: {
        district: "R-1",
        sourceAdapter: "txgio-zoning-stamp:waco-tx",
      },
      setbackRule: null,
      buildableEnvelope: {
        outcome: { kind: "buildable", areaSqFt: 8000 },
        reasoningChain: {
          inputAtomRefs: [
            {
              atomDid: "did:hauska:setback-rule:48309:1",
              role: "rule",
              entityType: "setback-rule",
            },
          ],
        },
      },
    });
    expect(out?.facets.envelope?.status).toBe("declined");
    expect(out?.facets.envelope?.declineReason).toBe("envelope-no-setback-rule");
    expect(out?.facets.envelope?.disclosure).toContain(
      "did:hauska:setback-rule:48309:1",
    );
    expect(out?.facets.envelope?.buildableAreaSqFt).toBeUndefined();
  });

  it("layer-23 dimensional record still emits value setbacks", () => {
    const out = adaptAtomChainToBakedFacets({
      parcelNodeId: "48021:34137",
      zoningFact: {
        district: "SF-1",
        sourceAdapter: "txgio-zoning-stamp:bastrop-city-tx",
      },
      setbackRule: {
        front: 30,
        side: 10,
        rear: 30,
        sourceAdapter: "bastrop-per-parcel-record-layer-23",
        sourceCodeAtomRef: { atomDid: "did:hauska:code-section:bdc:14.02.003" },
      },
      buildableEnvelope: {
        outcome: { kind: "buildable", areaSqFt: 9350 },
      },
    });
    expect(out?.facets.envelope?.status).toBe("ok");
    expect(out?.facets.envelope?.setbacks).toMatchObject({
      front_ft: 30,
      side_ft: 10,
      rear_ft: 30,
    });
  });
});
