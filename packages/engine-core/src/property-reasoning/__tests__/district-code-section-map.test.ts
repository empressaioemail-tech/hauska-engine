/**
 * PR-1 — zoning-fact district code-section refs.
 * Mapped jurisdiction/district asserts refs present; unmapped asserts
 * absence (identical to pre-existing emit shape).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { lookupDistrictCodeSectionRefs } from "../district-code-section-map.js";
import { emitZoningFact } from "../emit-zoning-fact.js";
import type { JurisdictionDescriptor } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

describe("lookupDistrictCodeSectionRefs — elgin_tx (2026-08-03 onboarding, per-district permitted-use citations)", () => {
  const EXPECTED = {
    "R-1": { req: "46-233", use: "46-231" },
    "R-2": { req: "46-265", use: "46-263" },
    "R-3": { req: "46-303", use: "46-301" },
    "R-4": { req: "46-333", use: "46-332" },
    "C-1": { req: "46-363", use: "46-362" },
    "C-2": { req: "46-391", use: "46-390" },
    "C-3": { req: "46-417", use: "46-416" },
    I: { req: "46-441", use: "46-440" },
  } as const;

  it("resolves every seeded elgin_tx district to its OWN district-requirements and permitted-use sections (structural divergence from bastrop_tx's single shared permitted-use table)", () => {
    for (const [code, { req, use }] of Object.entries(EXPECTED)) {
      const refs = lookupDistrictCodeSectionRefs("elgin_tx", code);
      expect(refs).toBeDefined();
      expect(refs?.districtRequirements).toMatchObject({
        atomDid: `did:hauska:code-section:elgin_tx/elgin-code-of-ordinances-current-supplement/${req}`,
        role: "rule",
        entityType: "code-section",
      });
      expect(refs?.permittedUseTable).toMatchObject({
        atomDid: `did:hauska:code-section:elgin_tx/elgin-code-of-ordinances-current-supplement/${use}`,
        role: "rule",
        entityType: "code-section",
      });
      // Structural divergence check: unlike bastrop_tx, each district's
      // permitted-use ref must be DISTINCT from every other district's.
      expect(refs?.permittedUseTable.atomDid).not.toBe(refs?.districtRequirements.atomDid);
    }
  });

  it("every elgin_tx district has a distinct permittedUseTable ref (per-district, not shared)", () => {
    const useRefs = Object.keys(EXPECTED).map(
      (code) => lookupDistrictCodeSectionRefs("elgin_tx", code)?.permittedUseTable.atomDid,
    );
    expect(new Set(useRefs).size).toBe(useRefs.length);
  });

  it("returns undefined for an unmapped district within elgin_tx", () => {
    expect(lookupDistrictCodeSectionRefs("elgin_tx", "PDD")).toBeUndefined();
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

describe("DISTRICT_CODE_SECTION_MAP elgin_tx — every cited DID exists in the frozen corpus snapshot", () => {
  // Mechanical load test (dispatch requirement): every atom_did this map
  // produces for elgin_tx must resolve to a real code-section entityId in
  // the frozen corpus. buildAtomDid wraps entityId as
  // "did:hauska:code-section:<entityId>" — strip the DID prefix back to the
  // bare entityId to check against the snapshot.
  const snapshotPath = path.resolve(
    __dirname,
    "../../../../../services/retrieval-api/corpus/snapshot.json",
  );

  it("resolves the frozen corpus snapshot path", () => {
    expect(() => readFileSync(snapshotPath, "utf-8")).not.toThrow();
  });

  it("every elgin_tx districtRequirements and permittedUseTable atomDid exists as a code-section entityId in the corpus", () => {
    const raw = readFileSync(snapshotPath, "utf-8");
    const snapshot = JSON.parse(raw) as { atoms: ReadonlyArray<{ entityType: string; entityId: string }> };
    const codeSectionIds = new Set(
      snapshot.atoms.filter((a) => a.entityType === "code-section").map((a) => a.entityId),
    );
    expect(codeSectionIds.size).toBeGreaterThan(0);

    const districtCodes = ["R-1", "R-2", "R-3", "R-4", "C-1", "C-2", "C-3", "I"];
    const DID_PREFIX = "did:hauska:code-section:";
    for (const code of districtCodes) {
      const refs = lookupDistrictCodeSectionRefs("elgin_tx", code)!;
      expect(refs).toBeDefined();
      for (const ref of [refs.districtRequirements, refs.permittedUseTable]) {
        expect(ref.atomDid.startsWith(DID_PREFIX)).toBe(true);
        const entityId = ref.atomDid.slice(DID_PREFIX.length);
        expect(codeSectionIds.has(entityId), `missing corpus atom for ${entityId}`).toBe(true);
      }
    }
  });
});
