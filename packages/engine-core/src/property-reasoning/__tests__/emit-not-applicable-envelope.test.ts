import { describe, it, expect } from "vitest";
import {
  emitUnincorporatedBuildableEnvelope,
  notApplicableBoundaryEdgeSetback,
  UNINCORPORATED_NO_ZONING_REASON,
} from "../emit-not-applicable-envelope.js";

describe("emitUnincorporatedBuildableEnvelope", () => {
  it("emits a not-applicable outcome, never a buildable/no-buildable-area claim", () => {
    const atom = emitUnincorporatedBuildableEnvelope({
      parcelNodeId: "48055:12345",
      jurisdictionTenant: "caldwell_county_tx_unincorporated",
      sourceCitation: "Caldwell County (unincorporated) — zoningRegime: unzoned",
      extractedAt: "2026-09-06T00:00:00.000Z",
    });
    expect(atom.outcome).toEqual({
      kind: "not-applicable",
      reason: UNINCORPORATED_NO_ZONING_REASON,
    });
    expect(atom.entityType).toBe("buildable-envelope");
    expect(atom.parcelNodeId).toBe("48055:12345");
    expect(atom.status).toBe("active");
  });

  it("never references a zoning-fact or setback-rule input (there are none)", () => {
    const atom = emitUnincorporatedBuildableEnvelope({
      parcelNodeId: "48055:12345",
      jurisdictionTenant: "caldwell_county_tx_unincorporated",
      sourceCitation: "test",
      extractedAt: "2026-09-06T00:00:00.000Z",
    });
    const refs = atom.reasoningChain.inputAtomRefs;
    expect(refs).toEqual([]);
    expect(refs.some((r) => r.entityType === "zoning-fact")).toBe(false);
  });

  it("is deterministic: same inputs produce the same contentHash", () => {
    const inputs = {
      parcelNodeId: "48055:99999",
      jurisdictionTenant: "caldwell_county_tx_unincorporated",
      sourceCitation: "test",
      extractedAt: "2026-09-06T00:00:00.000Z",
    };
    const a = emitUnincorporatedBuildableEnvelope(inputs);
    const b = emitUnincorporatedBuildableEnvelope(inputs);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).not.toBe("");
  });

  it("versions the entityId (v2+) when a non-default version is supplied", () => {
    const atom = emitUnincorporatedBuildableEnvelope({
      parcelNodeId: "48055:12345",
      jurisdictionTenant: "caldwell_county_tx_unincorporated",
      sourceCitation: "test",
      extractedAt: "2026-09-06T00:00:00.000Z",
      version: 2,
    });
    expect(atom.entityId).toBe("48055:12345/v2");
  });
});

describe("notApplicableBoundaryEdgeSetback", () => {
  it("is distinct from no-setback-row / unmapped-adjacency", () => {
    const disposition = notApplicableBoundaryEdgeSetback();
    expect(disposition.kind).toBe("not-applicable");
    expect(disposition.kind).not.toBe("no-setback-row");
    expect(disposition.kind).not.toBe("unmapped-adjacency");
    expect(disposition.reason).toBe(UNINCORPORATED_NO_ZONING_REASON);
  });
});
