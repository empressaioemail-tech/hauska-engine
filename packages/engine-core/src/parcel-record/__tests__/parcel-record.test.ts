import { describe, expect, it } from "vitest";

import {
  PARCEL_RECORD_RAIL_COUNT,
  PARCEL_RECORD_RAIL_KEYS,
  PARCEL_RECORD_RAIL_META,
  RAILS_ADDED_BEYOND_SEED,
  RAILS_V2_DECLARED_AHEAD,
  ZONING_VERDICT_FIELDS_RULED_OUT,
  UNINCORPORATED_NOT_APPLICABLE_RAIL_KEYS,
  ZONING_ENVELOPE_RAIL_KEYS,
  OWNER_RAIL_ACCESS,
  PUBLIC_RAIL_ACCESS,
  TENANT_PRIVATE_ACCESS,
  accessForPublicRecordRef,
  railAccess,
  instantiateParcelRecord,
  summarizeCountyRecords,
  assertFullRecordCells,
  deleteCellForViolationTest,
  auditNotApplicableCells,
  evaluatePublishGate,
  poisonCell,
  PublishGateRefusedError,
  assertPublishableCounty,
  ingestCadOntoRecords,
  isCompanionRail,
  deriveLiveRailKeys,
  deriveDeclaredAheadRailKeys,
  RAIL_LIVENESS_SQL,
  type CadPropertyRow,
  type FloodCompanionRow,
  type ParcelRecordRailKey,
  type ParcelRecordRow,
  type PublicRecordRefRow,
  type SalesHistoryRow,
  type PublishGateVerdict,
} from "../index.js";

function accountUnaccounted(rec: ParcelRecordRow, except: readonly ParcelRecordRailKey[] = []): void {
  const skip = new Set<string>(except);
  for (const key of PARCEL_RECORD_RAIL_KEYS) {
    if (skip.has(key)) continue;
    const cell = rec.cells[key];
    if (cell.kind !== "unaccounted") continue;
    if (isCompanionRail(key)) {
      (rec.cells as Record<string, unknown>)[key] = {
        kind: "value",
        disposition: "empty-set",
        rowCount: 0,
        source: "test",
        vintage: "test",
      };
    } else {
      (rec.cells as Record<string, unknown>)[key] = {
        kind: "absent-verified",
        basis: "test fixture",
      };
    }
  }
}

describe("parcel-record rail set", () => {
  it("has a closed derived set (65 rails as of 2026-09-01 v2)", () => {
    expect(PARCEL_RECORD_RAIL_COUNT).toBe(65);
    expect(PARCEL_RECORD_RAIL_KEYS.length).toBe(PARCEL_RECORD_RAIL_COUNT);
    expect(new Set(PARCEL_RECORD_RAIL_KEYS).size).toBe(PARCEL_RECORD_RAIL_COUNT);
  });

  it("lists rails added beyond the v1 dispatch seed", () => {
    expect(RAILS_ADDED_BEYOND_SEED).toContain("legalDescription");
    expect(RAILS_ADDED_BEYOND_SEED).toContain("parcelGeometry");
    expect(RAILS_ADDED_BEYOND_SEED).not.toContain("owner");
  });

  it("declares exactly the 13 v2 rails ahead", () => {
    expect(RAILS_V2_DECLARED_AHEAD).toHaveLength(13);
    expect(new Set(RAILS_V2_DECLARED_AHEAD).size).toBe(13);
    for (const key of RAILS_V2_DECLARED_AHEAD) {
      expect(PARCEL_RECORD_RAIL_KEYS).toContain(key);
    }
  });

  it("names the three zoning-verdict fields ruled out as rails (CP2 decision, not silently dropped)", () => {
    expect(ZONING_VERDICT_FIELDS_RULED_OUT).toEqual([
      "zoning.verdict",
      "zoning.authority",
      "zoning.derivation.cityLimitsStatus",
    ]);
  });
});

describe("access pair on rail metadata", () => {
  it("writes an access pair on every rail; owner is paid-tier explicitly", () => {
    for (const row of PARCEL_RECORD_RAIL_META) {
      expect(row.access).toBeDefined();
      expect(row.access.discoverability).toBeTruthy();
      expect(row.access.entitlement).toBeTruthy();
    }
    expect(railAccess("owner")).toBe(OWNER_RAIL_ACCESS);
    expect(railAccess("owner")).toEqual({
      discoverability: "catalog-listed",
      entitlement: "anyone-paid",
    });
    expect(railAccess("owner")).not.toBe(PUBLIC_RAIL_ACCESS);
    expect(railAccess("apn")).toBe(PUBLIC_RAIL_ACCESS);
    expect(railAccess("publicRecordRefs")).toBe(PUBLIC_RAIL_ACCESS);
  });

  it("derives publicRecordRefs row access from acquiredBy", () => {
    expect(accessForPublicRecordRef("public-ingest")).toBe(PUBLIC_RAIL_ACCESS);
    expect(accessForPublicRecordRef("user-request")).toBe(TENANT_PRIVATE_ACCESS);
  });
});

describe("instantiateParcelRecord", () => {
  it("instantiates every rail — missing column fails assertFullRecordCells", () => {
    const rec = instantiateParcelRecord({
      countyFips: "48021",
      propId: "34137",
      incorporated: true,
    });
    expect(Object.keys(rec.cells).length).toBe(PARCEL_RECORD_RAIL_COUNT);
    assertFullRecordCells(rec.cells);

    const partial = deleteCellForViolationTest(rec.cells, "marketValue");
    expect(() => assertFullRecordCells(partial)).toThrow(/missing rail column: marketValue/);
  });

  it("stamps v1 NA list only; new zoning-envelope scalars stay unaccounted", () => {
    const uninc = instantiateParcelRecord({
      countyFips: "48021",
      propId: "1",
      incorporated: false,
    });
    expect(uninc.cells.zoningDistrict.kind).toBe("not-applicable");
    expect(uninc.cells.setbackRules.kind).toBe("not-applicable");
    expect(uninc.cells.marketValue.kind).toBe("unaccounted");
    expect(uninc.cells.wells.kind).toBe("unaccounted");
    expect(uninc.cells.maxImperviousCoverPct.kind).toBe("unaccounted");
    expect(uninc.cells.treeProtection.kind).toBe("unaccounted");
    expect(uninc.cells.schoolDistrict.kind).toBe("unaccounted");
    expect(uninc.cells.owner.kind).toBe("unaccounted");

    expect(UNINCORPORATED_NOT_APPLICABLE_RAIL_KEYS).toHaveLength(18);
    expect(UNINCORPORATED_NOT_APPLICABLE_RAIL_KEYS).not.toContain("maxImperviousCoverPct");
    expect(UNINCORPORATED_NOT_APPLICABLE_RAIL_KEYS).not.toContain("treeProtection");
    expect(ZONING_ENVELOPE_RAIL_KEYS).toContain("maxImperviousCoverPct");
    expect(ZONING_ENVELOPE_RAIL_KEYS).toContain("treeProtection");
    expect(ZONING_ENVELOPE_RAIL_KEYS.length).toBe(19);

    const audit = auditNotApplicableCells([uninc]);
    expect(audit.totalNotApplicable).toBe(UNINCORPORATED_NOT_APPLICABLE_RAIL_KEYS.length);
    expect(audit.integerMultipleCheck.passes).toBe(true);

    const inc = instantiateParcelRecord({
      countyFips: "48021",
      propId: "2",
      incorporated: true,
    });
    expect(inc.cells.zoningDistrict.kind).toBe("unaccounted");
  });

  it("countyFips is structural value at instantiate", () => {
    const rec = instantiateParcelRecord({
      countyFips: "48021",
      propId: "99",
      incorporated: null,
    });
    expect(rec.cells.countyFips).toMatchObject({
      kind: "value",
      value: "48021",
    });
  });
});

describe("publish gate + derived liveness", () => {
  it("passes when live rails are accounted and prints the 13 declared-ahead", () => {
    const rec = instantiateParcelRecord({
      countyFips: "48021",
      propId: "34137",
      incorporated: true,
    });
    accountUnaccounted(rec, RAILS_V2_DECLARED_AHEAD);
    const verdict = evaluatePublishGate([rec]);
    expect(verdict.ok).toBe(true);
    expect(verdict.unaccountedCount).toBe(0);
    expect([...verdict.excludedDeclaredAhead].sort()).toEqual(
      [...RAILS_V2_DECLARED_AHEAD].sort(),
    );
    expect(verdict.excludedDeclaredAhead).toHaveLength(13);
    assertPublishableCounty([rec]);
  });

  it("refuses when one LIVE rail cell is poisoned", () => {
    // Two parcels so apn stays live after one cell is poisoned. Poisoning the
    // last earned cell of a rail demotes it to declared-ahead and the gate
    // would pass — that is the known derivation limit, not this test.
    const a = instantiateParcelRecord({
      countyFips: "48021",
      propId: "34137",
      incorporated: true,
    });
    const b = instantiateParcelRecord({
      countyFips: "48021",
      propId: "20500",
      incorporated: true,
    });
    accountUnaccounted(a, RAILS_V2_DECLARED_AHEAD);
    accountUnaccounted(b, RAILS_V2_DECLARED_AHEAD);
    const poisoned = poisonCell(a, "apn");
    const verdict = evaluatePublishGate([poisoned, b]);
    expect(verdict.ok).toBe(false);
    expect(verdict.unaccountedCount).toBe(1);
    expect(verdict.unaccountedSamples[0]?.railKey).toBe("apn");
    expect(verdict.unaccountedSamples[0]?.placeKey).toBe("48021:34137");
    expect([...verdict.excludedDeclaredAhead].sort()).toEqual(
      [...RAILS_V2_DECLARED_AHEAD].sort(),
    );
    expect(() => assertPublishableCounty([poisoned, b])).toThrow(PublishGateRefusedError);
  });

  it("poisoning the last earned cell of a rail demotes it (known limit)", () => {
    const rec = instantiateParcelRecord({
      countyFips: "48021",
      propId: "34137",
      incorporated: true,
    });
    accountUnaccounted(rec, RAILS_V2_DECLARED_AHEAD);
    const poisoned = poisonCell(rec, "apn");
    const verdict = evaluatePublishGate([poisoned]);
    expect(verdict.ok).toBe(true);
    expect(verdict.excludedDeclaredAhead).toContain("apn");
  });

  it("full-rail poison stays silent without prior-state info (opt-in only, no regression)", () => {
    const rec = instantiateParcelRecord({
      countyFips: "48021",
      propId: "34137",
      incorporated: true,
    });
    accountUnaccounted(rec, RAILS_V2_DECLARED_AHEAD);
    const poisoned = poisonCell(rec, "apn");
    const verdict = evaluatePublishGate([poisoned]); // no priorLiveRailKeys given
    expect(verdict.excludedDeclaredAhead).toContain("apn");
    expect(verdict.warnings).toHaveLength(0);
  });

  it("warns when a rail goes from live to fully poisoned, given prior liveness (WARN cross-check)", () => {
    // Two parcels, both carrying an earned "apn" cell, so the rail is live
    // in the first evaluation.
    const a = instantiateParcelRecord({
      countyFips: "48021",
      propId: "34137",
      incorporated: true,
    });
    const b = instantiateParcelRecord({
      countyFips: "48021",
      propId: "20500",
      incorporated: true,
    });
    accountUnaccounted(a, RAILS_V2_DECLARED_AHEAD);
    accountUnaccounted(b, RAILS_V2_DECLARED_AHEAD);

    const before = evaluatePublishGate([a, b]);
    expect(before.excludedDeclaredAhead).not.toContain("apn");
    expect(before.warnings).toHaveLength(0);

    // Every earned "apn" cell in the record set is poisoned — the rail goes
    // from live to fully unaccounted, not "never attempted".
    const priorLiveRailKeys = PARCEL_RECORD_RAIL_KEYS.filter(
      (k) => !before.excludedDeclaredAhead.includes(k),
    );
    const poisonedA = poisonCell(a, "apn");
    const poisonedB = poisonCell(b, "apn");
    const after = evaluatePublishGate([poisonedA, poisonedB], { priorLiveRailKeys });

    expect(after.ok).toBe(true); // WARN, not a refusal — same accept-and-warn decision as declared-ahead
    expect(after.excludedDeclaredAhead).toContain("apn");
    expect(after.warnings).toContainEqual({
      kind: "full-rail-poison",
      railKey: "apn",
      detail: expect.stringContaining('rail "apn"'),
    });
    // A rail that really was never attempted (a declared-ahead rail) must
    // NOT warn just because it is also in priorLiveRailKeys' complement —
    // only rails present in priorLiveRailKeys can warn.
    expect(after.warnings.map((w) => w.railKey)).not.toContain("owner");
  });

  it("flips a rail live on its first earned cell with no code change", () => {
    const rec = instantiateParcelRecord({
      countyFips: "48021",
      propId: "1",
      incorporated: true,
    });
    accountUnaccounted(rec, RAILS_V2_DECLARED_AHEAD);
    expect(deriveLiveRailKeys([rec])).not.toContain("owner");
    expect(deriveDeclaredAheadRailKeys([rec])).toContain("owner");

    rec.cells.owner = {
      kind: "value",
      disposition: "rows",
      rowCount: 1,
      source: "test",
      vintage: "test",
    };

    expect(deriveLiveRailKeys([rec])).toContain("owner");
    expect(deriveDeclaredAheadRailKeys([rec])).not.toContain("owner");
    const verdict = evaluatePublishGate([rec]);
    expect(verdict.excludedDeclaredAhead).not.toContain("owner");
    expect(verdict.excludedDeclaredAhead).toHaveLength(12);
  });

  it("SQL contract names the same earned kinds as the typed derivation", () => {
    expect(RAIL_LIVENESS_SQL).toContain("parcel_record_cell");
    expect(RAIL_LIVENESS_SQL).toContain("'value'");
    expect(RAIL_LIVENESS_SQL).toContain("'absent-verified'");
    expect(RAIL_LIVENESS_SQL).toContain("'refused'");
    expect(RAIL_LIVENESS_SQL).not.toContain("not-applicable");
    expect(RAIL_LIVENESS_SQL).not.toContain("unaccounted");
  });

  it("a verdict omitting excludedDeclaredAhead does not typecheck", () => {
    const rec = instantiateParcelRecord({
      countyFips: "48021",
      propId: "1",
      incorporated: true,
    });
    const verdict: PublishGateVerdict = evaluatePublishGate([rec]);
    expect(Array.isArray(verdict.excludedDeclaredAhead)).toBe(true);
    const _required: PublishGateVerdict["excludedDeclaredAhead"] =
      verdict.excludedDeclaredAhead;
    expect(_required.length).toBeGreaterThan(0);
    // Compile-time guard: drop this field and tsc must fail.
    // @ts-expect-error excludedDeclaredAhead is required on PublishGateVerdict
    const _omit: PublishGateVerdict = {
      ok: true,
      unaccountedCount: 0,
      unaccountedSamples: [],
    };
    expect(_omit).toBeDefined();
  });
});

describe("companion row shapes", () => {
  it("salesHistory price and flood BFE represent absent-verified", () => {
    const sale: SalesHistoryRow = {
      transactionDate: "2024-06-01",
      price: { representation: "absent-verified", basis: "Texas non-disclosure" },
    };
    expect(sale.price.representation).toBe("absent-verified");

    const flood: FloodCompanionRow = {
      zone: "AE",
      floodwayVsFloodplain: "floodplain",
      baseFloodElevation: { representation: "absent-verified", basis: "panel carries no BFE" },
      femaPanelId: "48021C0250F",
      panelEffectiveDate: "2012-09-26",
    };
    expect(flood.femaPanelId).toBeTruthy();
    expect(flood.panelEffectiveDate).toBeTruthy();
    expect(flood.floodwayVsFloodplain).toBe("floodplain");
  });

  it("publicRecordRefs points at P-85 columns only", () => {
    const row: PublicRecordRefRow = {
      countyFips: "48021",
      documentId: "2024-001234",
      recordKind: "easement",
      storeRef: {
        store: "records_request_artifacts",
        jobId: "00000000-0000-0000-0000-000000000001",
        artifactId: "00000000-0000-0000-0000-000000000002",
      },
      acquiredBy: "user-request",
      access: accessForPublicRecordRef("user-request"),
    };
    expect(row.storeRef.store).toBe("records_request_artifacts");
    expect(row.access).toBe(TENANT_PRIVATE_ACCESS);
  });
});

describe("ingest existing CAD", () => {
  it("moves cells from unaccounted to value on existing cad_property fields", () => {
    const rec = instantiateParcelRecord({
      countyFips: "48021",
      propId: "34137",
      incorporated: true,
    });
    const before = summarizeCountyRecords([rec]);
    expect(before.byState.unaccounted).toBeGreaterThan(0);

    const cad: CadPropertyRow = {
      prop_id: "34137",
      tax_year: 2025,
      situs_address: "908 PINE",
      situs_city: "BASTROP",
      situs_zip: "78602",
      legal_description: "LOT 1",
      exemption_codes: null,
      land_value: 100_000,
      improvement_value: 200_000,
      market_value: 300_000,
      assessed_value: 250_000,
      year_built: 1980,
      living_area_sqft: 1800,
      land_acres: 0.25,
      property_use_code: "A1",
    };
    const { cellsMoved } = ingestCadOntoRecords([rec], new Map([["34137", cad]]), "2025");
    expect(cellsMoved).toBeGreaterThan(5);

    const after = summarizeCountyRecords([rec]);
    expect(after.byState.value).toBeGreaterThan(before.byState.value ?? 0);
    expect(after.byState.unaccounted).toBeLessThan(before.byState.unaccounted ?? Infinity);
    expect(rec.cells.marketValue).toMatchObject({ kind: "value", value: 300_000 });
    expect(rec.cells.exemptionCodes).toMatchObject({
      kind: "absent-verified",
      basis: {
        source: "cad_property",
        countyFips: "48021",
        propId: "34137",
        taxYear: 2025,
        vintage: "2025",
      },
    });
  });

  function mclennanNullCad(overrides: Partial<CadPropertyRow> = {}): CadPropertyRow {
    return {
      prop_id: "1",
      tax_year: 2025,
      situs_address: "100 MAIN",
      situs_city: "WACO",
      situs_zip: "76701",
      legal_description: "LOT 1",
      exemption_codes: null,
      land_value: 50_000,
      improvement_value: 80_000,
      market_value: 130_000,
      assessed_value: null,
      year_built: null,
      living_area_sqft: null,
      land_acres: null,
      property_use_code: "A1",
      ...overrides,
    };
  }

  it("(a) matched row + null field -> absent-verified with the full basis", () => {
    const rec = instantiateParcelRecord({
      countyFips: "48309",
      propId: "1",
      incorporated: true,
    });
    ingestCadOntoRecords([rec], new Map([["1", mclennanNullCad()]]), "2025-ingest");
    const expectedBasis = {
      source: "cad_property",
      countyFips: "48309",
      propId: "1",
      taxYear: 2025,
      vintage: "2025-ingest",
    };
    expect(rec.cells.assessedValue).toEqual({ kind: "absent-verified", basis: expectedBasis });
    expect(rec.cells.livingAreaSqft).toEqual({ kind: "absent-verified", basis: expectedBasis });
    expect(rec.cells.yearBuilt).toEqual({ kind: "absent-verified", basis: expectedBasis });
    expect(rec.cells.acreageAcres).toEqual({ kind: "absent-verified", basis: expectedBasis });
    expect(rec.cells.marketValue).toMatchObject({ kind: "value", value: 130_000 });
  });

  it("(b) join miss stays unaccounted even when a value exists under a different key", () => {
    const rec = instantiateParcelRecord({
      countyFips: "48491",
      propId: "R123456",
      incorporated: true,
    });
    const numericCad = mclennanNullCad({
      prop_id: "123456",
      improvement_value: 220_000,
      living_area_sqft: 2100,
      assessed_value: 200_000,
      year_built: 1998,
      land_acres: 0.3,
    });
    ingestCadOntoRecords([rec], new Map([["123456", numericCad]]), "2025");
    expect(rec.cells.improvementValue.kind).toBe("unaccounted");
    expect(rec.cells.livingAreaSqft.kind).toBe("unaccounted");
    expect(rec.cells.assessedValue.kind).toBe("unaccounted");
    expect(rec.cells.apn.kind).toBe("unaccounted");
    expect(rec.cells.marketValue.kind).toBe("unaccounted");
  });

  it("(b2) matched R-prefix row with null improvement DOES emit (live Williamson shape)", () => {
    // Gap ledger section 7: identity join hits R-prefix; dollars live on numeric.
    // The card fixture is (b). Live store is this. R6B must not read a moved
    // improvement cell as proof the join-miss scope leaked.
    const rec = instantiateParcelRecord({
      countyFips: "48491",
      propId: "R123456",
      incorporated: true,
    });
    const rPrefix = mclennanNullCad({
      prop_id: "R123456",
      improvement_value: null,
      living_area_sqft: null,
      assessed_value: null,
      market_value: 130_000,
      land_acres: 0.3,
    });
    const numeric = mclennanNullCad({
      prop_id: "123456",
      improvement_value: 220_000,
      living_area_sqft: 2100,
      assessed_value: 200_000,
    });
    ingestCadOntoRecords(
      [rec],
      new Map([
        ["R123456", rPrefix],
        ["123456", numeric],
      ]),
      "2025",
    );
    expect(rec.cells.improvementValue.kind).toBe("absent-verified");
    expect(rec.cells.livingAreaSqft.kind).toBe("absent-verified");
    expect(rec.cells.marketValue).toMatchObject({ kind: "value", value: 130_000 });
    expect(rec.cells.apn).toMatchObject({ kind: "value", value: "R123456" });
  });

  it("(c) blank-string field behaves as null", () => {
    const rec = instantiateParcelRecord({
      countyFips: "48309",
      propId: "1",
      incorporated: true,
    });
    ingestCadOntoRecords(
      [rec],
      new Map([
        [
          "1",
          mclennanNullCad({
            situs_address: "   ",
            assessed_value: "" as unknown as number,
            living_area_sqft: "" as unknown as number,
          }),
        ],
      ]),
      "2025",
    );
    expect(rec.cells.situsAddress.kind).toBe("absent-verified");
    expect(rec.cells.assessedValue.kind).toBe("absent-verified");
    expect(rec.cells.livingAreaSqft.kind).toBe("absent-verified");
  });

  it("(d) re-ingest is idempotent: value stays value, absent-verified stays absent-verified", () => {
    const rec = instantiateParcelRecord({
      countyFips: "48309",
      propId: "1",
      incorporated: true,
    });
    const cad = mclennanNullCad();
    const first = ingestCadOntoRecords([rec], new Map([["1", cad]]), "2025");
    expect(first.cellsMoved).toBeGreaterThan(0);
    const assessed = rec.cells.assessedValue;
    const market = rec.cells.marketValue;
    const second = ingestCadOntoRecords([rec], new Map([["1", cad]]), "2025");
    expect(second.cellsMoved).toBe(0);
    expect(rec.cells.assessedValue).toEqual(assessed);
    expect(rec.cells.marketValue).toEqual(market);
    expect(rec.cells.assessedValue.kind).toBe("absent-verified");
    expect(rec.cells.marketValue).toMatchObject({ kind: "value", value: 130_000 });
  });

  it("living_area 0 stays unaccounted; $0 stays value 0", () => {
    const rec = instantiateParcelRecord({
      countyFips: "48055",
      propId: "1",
      incorporated: true,
    });
    ingestCadOntoRecords(
      [rec],
      new Map([
        [
          "1",
          mclennanNullCad({
            improvement_value: 0,
            living_area_sqft: 0,
            assessed_value: 90_000,
            year_built: 1970,
            land_acres: 0,
          }),
        ],
      ]),
      "2025",
    );
    expect(rec.cells.improvementValue).toMatchObject({ kind: "value", value: 0 });
    expect(rec.cells.acreageAcres).toMatchObject({ kind: "value", value: 0 });
    expect(rec.cells.livingAreaSqft.kind).toBe("unaccounted");
  });

  it("missing tax_year refuses the emission (cell stays unaccounted)", () => {
    const rec = instantiateParcelRecord({
      countyFips: "48309",
      propId: "1",
      incorporated: true,
    });
    ingestCadOntoRecords([rec], new Map([["1", mclennanNullCad({ tax_year: null })]]), "2025");
    expect(rec.cells.assessedValue.kind).toBe("unaccounted");
    expect(rec.cells.livingAreaSqft.kind).toBe("unaccounted");
    expect(rec.cells.marketValue).toMatchObject({ kind: "value", value: 130_000 });
  });

  it("does not export applyCadScalar or cadNullVerified (structural scoping)", async () => {
    const mod = await import("../ingest-existing.js");
    expect(mod.applyCadScalar).toBeUndefined();
    expect(mod.cadNullVerified).toBeUndefined();
    expect(typeof mod.ingestCadOntoRecords).toBe("function");
  });

  it("unexpected exemption_codes type stays unaccounted (not a CAD null)", () => {
    const rec = instantiateParcelRecord({
      countyFips: "48021",
      propId: "1",
      incorporated: true,
    });
    ingestCadOntoRecords(
      [rec],
      new Map([
        [
          "1",
          mclennanNullCad({
            exemption_codes: ["HS"] as unknown as string,
            assessed_value: 90_000,
            living_area_sqft: 1200,
            year_built: 1980,
            land_acres: 0.2,
          }),
        ],
      ]),
      "2025",
    );
    expect(rec.cells.exemptionCodes.kind).toBe("unaccounted");
    expect(rec.cells.assessedValue).toMatchObject({ kind: "value", value: 90_000 });
  });
});
