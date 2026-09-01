import { describe, expect, it } from "vitest";
import {
  PLACEHOLDER_SETBACK_PROVENANCE,
  PLACEHOLDER_SETBACK_UNKNOWN_BASIS,
  RETIRED_ROAD_CLASS_SETBACK_BASIS,
  ROAD_CLASS_SETBACK_PROVENANCE,
  classifyBoundaryEdgeSetback,
  classifyEnvelopeServe,
  classifySetbackRuleAtom,
} from "../setback-provenance-disposition.js";

describe("classifyBoundaryEdgeSetback — both directions", () => {
  it("emits refused when the only setback source is road-class-setback-table", () => {
    const verdict = classifyBoundaryEdgeSetback({
      feet: 15,
      provenance: ROAD_CLASS_SETBACK_PROVENANCE,
      atomCitation: "bastrop_tx",
    });
    expect(verdict.disposition).toBe("refused");
    expect(verdict.basis).toBe(RETIRED_ROAD_CLASS_SETBACK_BASIS);
  });

  it("emits value when the edge is backed by a real dimensional record", () => {
    const verdict = classifyBoundaryEdgeSetback({
      feet: 30,
      provenance: "district-setback-table",
      atomCitation: "bastrop-per-parcel-record-layer-23",
    });
    expect(verdict.disposition).toBe("value");
    expect(verdict.basis).toContain("district-setback-table");
  });

  it("does not treat unmapped absence as refused or unknown", () => {
    const verdict = classifyBoundaryEdgeSetback({
      kind: "unmapped-adjacency",
      reason: "No parcel or ROW adjacency mapped for this edge.",
    });
    expect(verdict.disposition).toBe("absent");
  });
});

describe("classifySetbackRuleAtom — three populations", () => {
  it("keeps a layer-23 / Lockhart / Austin-shaped dimensional record as value", () => {
    expect(
      classifySetbackRuleAtom({
        sourceAdapter: "bastrop-per-parcel-record-layer-23",
        sourceCodeAtomRef: { atomDid: "did:hauska:code-section:bdc:14.02.003" },
      }).disposition,
    ).toBe("value");
    expect(
      classifySetbackRuleAtom({
        sourceAdapter: "cortex-tier1-snapshot-breadth-bake",
        entityId: "48055:18925",
        sourceCodeAtomRef: { atomDid: "did:hauska:code-section:lockhart-udc:4.2" },
      }).disposition,
    ).toBe("value");
    expect(
      classifySetbackRuleAtom({
        sourceAdapter: "cortex-tier1-snapshot-breadth-bake",
        entityId: "48453:1",
        sourceCodeAtomRef: { atomDid: "did:hauska:code-section:austin-lcl:25-2" },
      }).disposition,
    ).toBe("value");
  });

  it("emits unknown — not absent-verified — for storage-port-proof/phase-1a", () => {
    const verdict = classifySetbackRuleAtom({
      sourceAdapter: "property-atom-proof",
      sourceCodeAtomRef: {
        atomDid: `did:hauska:code-section:${PLACEHOLDER_SETBACK_PROVENANCE}`,
      },
    });
    expect(verdict.disposition).toBe("unknown");
    expect(verdict.basis).toBe(PLACEHOLDER_SETBACK_UNKNOWN_BASIS);
    expect(verdict.disposition).not.toBe("refused");
  });

  it("emits refused when a setback-rule cites the retired road-class derivation", () => {
    const verdict = classifySetbackRuleAtom({
      sourceAdapter: ROAD_CLASS_SETBACK_PROVENANCE,
    });
    expect(verdict.disposition).toBe("refused");
    expect(verdict.basis).toBe(RETIRED_ROAD_CLASS_SETBACK_BASIS);
  });
});

describe("classifyEnvelopeServe — McLennan shape", () => {
  it("refuses an envelope over zero setback rules and names a cited DID when present", () => {
    const named = classifyEnvelopeServe({
      setbackRule: null,
      envelope: {
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
    expect(named.disposition).toBe("refused");
    expect(named.namedRuleSource).toBe("did:hauska:setback-rule:48309:1");
    expect(named.basis).toContain("not on file");

    const unnamed = classifyEnvelopeServe({
      setbackRule: null,
      envelope: { reasoningChain: { inputAtomRefs: [] } },
    });
    expect(unnamed.disposition).toBe("refused");
    expect(unnamed.namedRuleSource).toBeNull();
    expect(unnamed.basis).toContain("no setback-rule input");
  });

  it("does not silently accept a placeholder rule as envelope input", () => {
    const verdict = classifyEnvelopeServe({
      setbackRule: {
        sourceCodeAtomRef: {
          atomDid: `did:hauska:code-section:${PLACEHOLDER_SETBACK_PROVENANCE}`,
        },
      },
      envelope: {},
    });
    expect(verdict.disposition).toBe("unknown");
    expect(verdict.basis).toBe(PLACEHOLDER_SETBACK_UNKNOWN_BASIS);
  });

  it("keeps an envelope whose setback-rule is a dimensional record", () => {
    const verdict = classifyEnvelopeServe({
      setbackRule: {
        sourceAdapter: "bastrop-per-parcel-record-layer-23",
        sourceCodeAtomRef: { atomDid: "did:hauska:code-section:bdc:14.02.003" },
      },
      envelope: {
        reasoningChain: {
          inputAtomRefs: [
            {
              atomDid: "did:hauska:setback-rule:48021:34137",
              role: "rule",
              entityType: "setback-rule",
            },
          ],
        },
      },
    });
    expect(verdict.disposition).toBe("value");
  });
});
