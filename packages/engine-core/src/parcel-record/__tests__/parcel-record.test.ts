import { describe, expect, it } from "vitest";

import {
  PARCEL_RECORD_RAIL_COUNT,
  PARCEL_RECORD_RAIL_KEYS,
  RAILS_ADDED_BEYOND_SEED,
  UNINCORPORATED_NOT_APPLICABLE_RAIL_KEYS,
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
  type CadPropertyRow,
} from "../index.js";

describe("parcel-record rail set", () => {
  it("has a closed derived set (52 rails as of 2026-09-01)", () => {
    expect(PARCEL_RECORD_RAIL_COUNT).toBe(52);
    expect(PARCEL_RECORD_RAIL_KEYS.length).toBe(PARCEL_RECORD_RAIL_COUNT);
    expect(new Set(PARCEL_RECORD_RAIL_KEYS).size).toBe(PARCEL_RECORD_RAIL_COUNT);
  });

  it("lists rails added beyond the dispatch seed", () => {
    expect(RAILS_ADDED_BEYOND_SEED).toContain("legalDescription");
    expect(RAILS_ADDED_BEYOND_SEED).toContain("parcelGeometry");
    expect(RAILS_ADDED_BEYOND_SEED).not.toContain("owner");
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

  it("stamps zoning-envelope not-applicable for unincorporated parcels only", () => {
    const uninc = instantiateParcelRecord({
      countyFips: "48021",
      propId: "1",
      incorporated: false,
    });
    expect(uninc.cells.zoningDistrict.kind).toBe("not-applicable");
    expect(uninc.cells.setbackRules.kind).toBe("not-applicable");
    expect(uninc.cells.marketValue.kind).toBe("unaccounted");
    expect(uninc.cells.wells.kind).toBe("unaccounted");

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

describe("publish gate", () => {
  it("refuses when a cell is poisoned to unaccounted", () => {
    const rec = instantiateParcelRecord({
      countyFips: "48021",
      propId: "34137",
      incorporated: true,
    });
    const clean = [rec];
    expect(evaluatePublishGate(clean).ok).toBe(false);

    const poisoned = poisonCell(rec, "apn");
    const verdict = evaluatePublishGate([poisoned]);
    expect(verdict.ok).toBe(false);
    expect(verdict.unaccountedCount).toBeGreaterThan(0);
    expect(verdict.unaccountedSamples[0]?.railKey).toBe("apn");

    expect(() => assertPublishableCounty([poisoned])).toThrow(PublishGateRefusedError);
  });

  it("passes only when every cell has a non-unaccounted state", () => {
    const rec = instantiateParcelRecord({
      countyFips: "48021",
      propId: "1",
      incorporated: false,
    });
    for (const key of PARCEL_RECORD_RAIL_KEYS) {
      const cell = rec.cells[key];
      if (cell.kind === "unaccounted") {
        if ("disposition" in cell || key.endsWith("s") || key === "flood") {
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
    expect(evaluatePublishGate([rec]).ok).toBe(true);
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
  });
});
