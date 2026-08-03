/**
 * PR-1 — zoning-fact district code-section refs.
 * Mapped jurisdiction/district asserts refs present; unmapped asserts
 * absence (identical to pre-existing emit shape).
 */

import { describe, expect, it } from "vitest";

import { lookupDistrictCodeSectionRefs } from "../district-code-section-map.js";
import { emitZoningFact } from "../emit-zoning-fact.js";
import type { JurisdictionDescriptor } from "../types.js";

const bastropTxDescriptor: JurisdictionDescriptor = {
  key: "bastrop_tx",
  displayName: "Bastrop, TX (test descriptor)",
  jurisdictionTenant: "bastrop_tx",
  parcelFips: "48021",
  defaultAccessPolicy: "public-free",
  sourceAdapter: "descriptor-fixture",
  sourceUrl: "https://example.invalid/bastrop-tx-test",
};

const cookStubDescriptor: JurisdictionDescriptor = {
  key: "cook_county_il_stub",
  displayName: "Cook County IL (stub)",
  jurisdictionTenant: "cook_county_il_stub",
  parcelFips: "17031",
  defaultAccessPolicy: "public-free",
  sourceAdapter: "descriptor-fixture",
  sourceUrl: "https://example.invalid/cook-county-il-stub",
};

describe("lookupDistrictCodeSectionRefs", () => {
  it("resolves every seeded bastrop_tx district to the district-requirements and permitted-use sections", () => {
    for (const code of ["P/OS", "RR", "SF-1", "SF-2", "SF-3", "MU", "GC", "PI", "IND", "PDD"]) {
      const refs = lookupDistrictCodeSectionRefs("bastrop_tx", code);
      expect(refs).toBeDefined();
      expect(refs?.districtRequirements).toMatchObject({
        atomDid: "did:hauska:code-section:bastrop_tx-bdc-2026-adopted/14-02-003",
        role: "rule",
        entityType: "code-section",
      });
      expect(refs?.permittedUseTable).toMatchObject({
        atomDid: "did:hauska:code-section:bastrop_tx-bdc-2026-adopted/14-02-008",
        role: "rule",
        entityType: "code-section",
      });
    }
  });

  it("returns undefined for an unmapped jurisdiction", () => {
    expect(lookupDistrictCodeSectionRefs("cook_county_il_stub", "RS-1")).toBeUndefined();
  });

  it("returns undefined for an unmapped district within a mapped jurisdiction", () => {
    expect(lookupDistrictCodeSectionRefs("bastrop_tx", "NOT-A-REAL-DISTRICT")).toBeUndefined();
  });
});

describe("emitZoningFact — district code-section refs (additive)", () => {
  it("mapped jurisdiction + district: zoning-fact carries sourceCodeAtomRef and codeSectionRefs", () => {
    const result = emitZoningFact(bastropTxDescriptor, {
      parcelNodeId: "48021:TEST-001",
      districtCode: "SF-1",
      matchBasis: "exact",
      sourceCitation: "Test GIS zoning layer",
      extractedAt: "2026-08-03T12:00:00.000Z",
    });
    expect(result.absence).toBeUndefined();
    expect(result.sourceCodeAtomRef).toMatchObject({
      atomDid: "did:hauska:code-section:bastrop_tx-bdc-2026-adopted/14-02-003",
      role: "rule",
      entityType: "code-section",
    });
    expect(result.codeSectionRefs).toMatchObject({
      districtRequirements: {
        atomDid: "did:hauska:code-section:bastrop_tx-bdc-2026-adopted/14-02-003",
      },
      permittedUseTable: {
        atomDid: "did:hauska:code-section:bastrop_tx-bdc-2026-adopted/14-02-008",
      },
    });
  });

  it("unmapped jurisdiction: zoning-fact has no sourceCodeAtomRef or codeSectionRefs", () => {
    const result = emitZoningFact(cookStubDescriptor, {
      parcelNodeId: "17031:TEST-001",
      districtCode: "RS-1",
      matchBasis: "exact",
      sourceCitation: "Cook stub GIS zoning layer",
      extractedAt: "2026-08-03T12:00:00.000Z",
    });
    expect(result.absence).toBeUndefined();
    expect(result.sourceCodeAtomRef).toBeUndefined();
    expect(result.codeSectionRefs).toBeUndefined();
  });

  it("mapped jurisdiction, unmapped district: zoning-fact has no sourceCodeAtomRef or codeSectionRefs", () => {
    const result = emitZoningFact(bastropTxDescriptor, {
      parcelNodeId: "48021:TEST-002",
      districtCode: "NOT-A-REAL-DISTRICT",
      matchBasis: "exact",
      sourceCitation: "Test GIS zoning layer",
      extractedAt: "2026-08-03T12:00:00.000Z",
    });
    expect(result.absence).toBeUndefined();
    expect(result.sourceCodeAtomRef).toBeUndefined();
    expect(result.codeSectionRefs).toBeUndefined();
  });

  it("honest-absence path (no district): unaffected by the map, still absence-only", () => {
    const result = emitZoningFact(bastropTxDescriptor, {
      parcelNodeId: "48021:TEST-003",
      districtCode: null,
      matchBasis: "exact",
      sourceCitation: "Test GIS zoning layer — null zoning",
      extractedAt: "2026-08-03T12:00:00.000Z",
    });
    expect(result.absence?.kind).toBe("no-zoning-stamp");
    expect(result.district).toBeUndefined();
    expect(result.sourceCodeAtomRef).toBeUndefined();
    expect(result.codeSectionRefs).toBeUndefined();
  });
});
