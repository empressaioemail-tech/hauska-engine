import { describe, expect, it } from "vitest";
import type { PropertyAtomInstance } from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import {
  composeParcelReportFacts,
  footprintContradictsAppraisal,
  footprintContradictionConsequence,
} from "../report-model.js";
import type { RecordReaderClient, ParcelRecordResponse, ParcelRecordRail } from "../parcel-record-reader-client.js";

// P152-RAILS (OPS-23 P-152 lane 3): the feasibility report composer's FIRST
// consumption of the Hauska retrieval reader. These tests exercise items 4,
// 6 and 7 against composeParcelReportFacts directly (no live network, no
// live engine-api deploy — the reader client is a hand-built fake).

const parcelNodeId = "48453:474034"; // the F-48453-474034 probe parcel

function fakeStorage(atoms: PropertyAtomInstance[]): StoragePort {
  return { listPropertyAtomsByParcelNodeId: async () => atoms } as unknown as StoragePort;
}

function rail(serve: ParcelRecordRail["serve"], cell: Record<string, unknown> | null, companions: unknown[] = []): ParcelRecordRail {
  return { cell, gate: { verdict: null, evaluatedAt: null }, serve, atom: null, atomBacked: false, rendering: null, companions };
}

/**
 * A REAL macrotask delay (setTimeout), not a bare `async () => value` that
 * resolves on the next microtask. This is deliberate: a fake reader that
 * resolves instantly can mask a real bug in how the caller races/bounds the
 * fetch, because an instant resolution wins a Promise.race by MICROTASK
 * REGISTRATION ORDER regardless of whether the "loser" branch is even
 * correct. This exact class of masking hid a real production defect (a
 * temporal-dead-zone reference inside the bounded-timeout branch,
 * synchronously rejected at Promise-construction time — see
 * report-model.ts's own comment at the `readBudgetMs` declaration) that
 * every OTHER test in this file, using an instant fake reader, did not
 * catch. Any test asserting composeParcelReportFacts actually USES the
 * reader's result should go through this helper, not a bare async arrow.
 */
function delayed<T>(value: T, ms = 5): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function fakeReader(record: ParcelRecordResponse): RecordReaderClient {
  return { fetchRecord: () => delayed({ ok: true, record }) };
}

function failingReader(reason: string): RecordReaderClient {
  return { fetchRecord: () => delayed({ ok: false, reason }) };
}

const ABSENT_GEOMETRY = { status: "absent" as const, reason: "not needed for this fixture" };
const NO_DRAINAGE = { status: "absent" as const, reason: "test fixture: drainage not composed" };

describe("P152-RAILS item 4: composeParcelReportFacts composes cityLimits/ETJ from the reader", () => {
  it("cityLimitsStatus becomes 'incorporated' with a cityName when the reader's cityLimits rail serves 'record' — replacing the 'unresolved' constant", async () => {
    const record: ParcelRecordResponse = {
      parcelNodeId,
      placeKey: parcelNodeId,
      countyFips: "48453",
      railRegistrySha: "sha",
      readAt: "2026-09-12T00:00:00.000Z",
      rails: {
        cityLimits: rail("record", { kind: "value", value: "Austin", source: "landing_parcel_jurisdiction", vintage: "2026-09-01T00:00:00.000Z" }),
      },
      refused: null,
    };
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(record),
    });

    expect(model.facts.jurisdiction.cityLimitsStatus).toBe("incorporated");
    expect(model.facts.jurisdiction.cityName).toBe("Austin");
    expect(model.facts.jurisdiction.cityLimitsSourceCitation).toContain("parcel_record");
    expect(model.facts.jurisdiction.etjStatus).toBe("unresolved"); // P-358: no etjStatus rail in this fixture, so the honest default — never fabricated
  });

  it("stays 'unresolved' (unchanged) when no recordReader option is supplied — the pre-existing test contract", async () => {
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
    });
    expect(model.facts.jurisdiction.cityLimitsStatus).toBe("unresolved");
    expect(model.facts.jurisdiction.cityName).toBeUndefined();
  });

  it("stays 'unresolved' when the reader fetch fails — declared engine-side fallback, never a crash", async () => {
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: failingReader("record HTTP 503"),
    });
    expect(model.facts.jurisdiction.cityLimitsStatus).toBe("unresolved");
  });
});

describe("P152-RAILS item 4: composeParcelReportFacts composes the four dollar rails + structural fields from the reader", () => {
  it("FS-48453-474034: parcelOwnership becomes PRESENT from the reader alone when the substrate has no cad-parcel-roll atom — this is the fix for 'values UNAVAILABLE beside the card's dollars'", async () => {
    const record: ParcelRecordResponse = {
      parcelNodeId,
      placeKey: parcelNodeId,
      countyFips: "48453",
      railRegistrySha: "sha",
      readAt: "2026-09-12T00:00:00.000Z",
      rails: {
        marketValue: rail("record", { kind: "value", value: 412000 }),
        assessedValue: rail("record", { kind: "value", value: 398000 }),
      },
      refused: null,
    };
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]), // NO cad-parcel-roll atom — the exact FS-48453-474034 condition
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(record),
    });

    expect(model.facts.parcelOwnership.status).toBe("present");
    if (model.facts.parcelOwnership.status === "present") {
      expect(model.facts.parcelOwnership.marketValue).toBe(412000);
      expect(model.facts.parcelOwnership.assessedValue).toBe(398000);
      expect(model.facts.parcelOwnership.sourceCitation).toContain("parcel_record");
    }
  });

  it("P152-RAILS follow-up (live finding): a dollar rail whose cell.value arrives as a NUMERIC STRING (not a JS number) still composes -- yearBuilt/livingAreaSqft worked on the first live deploy, marketValue/assessedValue did not, and this is the one difference between them this composer can control for without a confirmed raw payload dump", async () => {
    const record: ParcelRecordResponse = {
      parcelNodeId,
      placeKey: parcelNodeId,
      countyFips: "48453",
      railRegistrySha: "sha",
      readAt: "2026-09-12T00:00:00.000Z",
      rails: {
        // Exact live values from the dispatch planner's direct retrieval-api
        // curl for 48453:474034, deliberately encoded as strings here since
        // this composer cannot yet confirm which primitive the real /record
        // response actually used for these two fields.
        marketValue: rail("record", { kind: "value", value: "969365" }),
        assessedValue: rail("record", { kind: "value", value: "969365.00" }),
        landValue: rail("record", { kind: "value", value: "$111,628" }),
        improvementValue: rail("record", { kind: "value", value: 857737 }), // a plain number must still work too
        yearBuilt: rail("record", { kind: "value", value: 2001 }),
        livingAreaSqft: rail("record", { kind: "value", value: 4168 }),
      },
      refused: null,
    };
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(record),
    });

    expect(model.facts.parcelOwnership.status).toBe("present");
    if (model.facts.parcelOwnership.status === "present") {
      expect(model.facts.parcelOwnership.marketValue).toBe(969365);
      expect(model.facts.parcelOwnership.assessedValue).toBe(969365);
      expect(model.facts.parcelOwnership.landValue).toBe(111628);
      expect(model.facts.parcelOwnership.improvementValue).toBe(857737);
      expect(model.facts.parcelOwnership.yearBuilt).toBe(2001);
      expect(model.facts.parcelOwnership.livingAreaSqft).toBe(4168);
    }
  });

  it("never fabricates a number from a non-numeric string -- a genuinely absent/garbage cell value stays undefined", async () => {
    const record: ParcelRecordResponse = {
      parcelNodeId,
      placeKey: parcelNodeId,
      countyFips: "48453",
      railRegistrySha: "sha",
      readAt: "2026-09-12T00:00:00.000Z",
      rails: {
        marketValue: rail("record", { kind: "value", value: "N/A" }),
        assessedValue: rail("record", { kind: "value", value: "" }),
      },
      refused: null,
    };
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(record),
    });
    // Neither rail supplied a usable number, and there is no substrate cad
    // atom either -- the section stays absent rather than "present" with
    // every field undefined.
    expect(model.facts.parcelOwnership.status).toBe("absent");
  });

  it("the reader wins per-field over the substrate cad-parcel-roll atom for exactly the rails it slates 'record'; a legacy-transitional rail keeps the substrate value", async () => {
    const cadRoll = {
      entityType: "cad-parcel-roll" as const,
      atomDid: "cad_1",
      parcelNodeId,
      taxYear: 2025,
      countyFips: "48453",
      propId: "474034",
      keyKind: "prop_id" as const,
      joinPassedOwnerMatchGate: true,
      reasoningChain: { reasoningKind: "observed" as const },
      sourceTier: "county-cad" as const,
      marketValue: 100000, // stale substrate value — reader below should win
      assessedValue: 95000, // NOT slated in this fixture — substrate value survives
      accessPolicy: "public-free" as const,
      sourceCitation: "Travis CAD 2025 roll",
      extractedAt: "2026-08-01T00:00:00Z",
      verificationStatus: "machine" as const,
      sourceAdapter: "cad-roll:travis",
      evaluatedAt: "2026-08-01T00:00:00Z",
      atomTier: "data" as const,
      entityId: parcelNodeId,
      jurisdictionTenant: "property-spine",
      fetchedAt: "2026-08-01T00:00:00Z",
      sourceUrl: "",
      contentHash: "",
      status: "active" as const,
    } as unknown as PropertyAtomInstance;

    const record: ParcelRecordResponse = {
      parcelNodeId,
      placeKey: parcelNodeId,
      countyFips: "48453",
      railRegistrySha: "sha",
      readAt: "2026-09-12T00:00:00.000Z",
      rails: {
        marketValue: rail("record", { kind: "value", value: 412000 }),
        assessedValue: rail("legacy-transitional", null),
      },
      refused: null,
    };
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([cadRoll]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(record),
    });

    expect(model.facts.parcelOwnership.status).toBe("present");
    if (model.facts.parcelOwnership.status === "present") {
      expect(model.facts.parcelOwnership.marketValue).toBe(412000); // reader (record)
      expect(model.facts.parcelOwnership.assessedValue).toBe(95000); // substrate (legacy-transitional)
    }
  });
});

describe("P152-RAILS item 6: the vacancy guard sees the reader-composed roll", () => {
  it("footprintContradictsAppraisal fires for a parcel whose roll comes ONLY from the reader (no substrate cad-parcel-roll atom) — the exact FS-48453-474034 condition that starved the guard before this lane", async () => {
    const record: ParcelRecordResponse = {
      parcelNodeId,
      placeKey: parcelNodeId,
      countyFips: "48453",
      railRegistrySha: "sha",
      readAt: "2026-09-12T00:00:00.000Z",
      rails: {
        improvementValue: rail("record", { kind: "value", value: 185000 }),
        yearBuilt: rail("record", { kind: "value", value: 1998 }),
        livingAreaSqft: rail("record", { kind: "value", value: 2100 }),
      },
      refused: null,
    };
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]), // no cad-parcel-roll atom at all
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(record),
    });
    // footprint stays honest-absent (no footprint atom in this fixture) —
    // safeSection default when the entity isn't in storage at all.
    expect(model.facts.footprint.status).toBe("absent");
    expect(model.facts.parcelOwnership.status).toBe("present");

    expect(footprintContradictsAppraisal(model)).toBe(true);
    const consequence = footprintContradictionConsequence(model);
    expect(consequence).toMatch(/1998/);
    expect(consequence).toMatch(/2,100 sq ft|2100 sq ft/);
  });

  it("does NOT fire when parcelOwnership stays absent (no reader, no substrate) — proves the guard is reading the real composed section, not a fixed true", async () => {
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
    });
    expect(model.facts.parcelOwnership.status).toBe("absent");
    expect(footprintContradictsAppraisal(model)).toBe(false);
  });
});

describe("P152-RAILS item 7: two special-district stores are reconciled, not silently resolved", () => {
  it("F17-style disagreement: the reader names one district, the substrate TCEQ atoms name a DIFFERENT one — both are reported, neither is discarded", async () => {
    const substrateDistrict = {
      entityType: "special-district-fact" as const,
      atomDid: "sdf_1",
      parcelNodeId,
      districtId: "west-travis-mud-3",
      districtName: "West Travis County MUD 3",
      districtType: "MUD",
      reasoningChain: { reasoningKind: "observed" as const },
      sourceTier: "tceq" as const,
      accessPolicy: "public-free" as const,
      sourceCitation: "TCEQ water-district membership (postgis-zone-major-st-intersects-true-geom)",
      extractedAt: "2026-08-01T00:00:00Z",
      verificationStatus: "machine" as const,
      sourceAdapter: "tceq-special-district",
      evaluatedAt: "2026-08-01T00:00:00Z",
      atomTier: "data" as const,
      entityId: parcelNodeId,
      jurisdictionTenant: "property-spine",
      fetchedAt: "2026-08-01T00:00:00Z",
      sourceUrl: "",
      contentHash: "",
      status: "active" as const,
    } as unknown as PropertyAtomInstance;

    const record: ParcelRecordResponse = {
      parcelNodeId,
      placeKey: parcelNodeId,
      countyFips: "48453",
      railRegistrySha: "sha",
      readAt: "2026-09-12T00:00:00.000Z",
      rails: {
        specialDistricts: rail("record", { kind: "value" }, [{ payload: { districtName: "Lake Pointe MUD" } }]),
      },
      refused: null,
    };
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([substrateDistrict]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(record),
    });

    expect(model.facts.specialDistricts.status).toBe("present");
    if (model.facts.specialDistricts.status === "present") {
      expect(model.facts.specialDistricts.districts.map((d) => d.districtName)).toEqual(["Lake Pointe MUD"]);
      expect(model.facts.specialDistricts.substrateOnlyDistricts).toEqual(["West Travis County MUD 3"]);
    }
    // Reported in dataQuality too (composeParcelReport's own package layer —
    // not exercised by composeParcelReportFacts directly, so re-derive the
    // same check this lane added to composeParcelReport's dataQuality block
    // is covered by report-model.test.ts's existing package-layer tests
    // reading model.facts directly; asserting the raw fact here is the unit
    // of behavior this lane owns).
  });

  it("no disagreement (both stores agree) carries no substrateOnlyDistricts", async () => {
    const substrateDistrict = {
      entityType: "special-district-fact" as const,
      atomDid: "sdf_1",
      parcelNodeId,
      districtId: "lake-pointe-mud",
      districtName: "Lake Pointe MUD",
      districtType: "MUD",
      reasoningChain: { reasoningKind: "observed" as const },
      sourceTier: "tceq" as const,
      accessPolicy: "public-free" as const,
      sourceCitation: "TCEQ",
      extractedAt: "2026-08-01T00:00:00Z",
      verificationStatus: "machine" as const,
      sourceAdapter: "tceq-special-district",
      evaluatedAt: "2026-08-01T00:00:00Z",
      atomTier: "data" as const,
      entityId: parcelNodeId,
      jurisdictionTenant: "property-spine",
      fetchedAt: "2026-08-01T00:00:00Z",
      sourceUrl: "",
      contentHash: "",
      status: "active" as const,
    } as unknown as PropertyAtomInstance;

    const record: ParcelRecordResponse = {
      parcelNodeId,
      placeKey: parcelNodeId,
      countyFips: "48453",
      railRegistrySha: "sha",
      readAt: "2026-09-12T00:00:00.000Z",
      rails: {
        specialDistricts: rail("record", { kind: "value" }, [{ payload: { districtName: "Lake Pointe MUD" } }]),
      },
      refused: null,
    };
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([substrateDistrict]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(record),
    });
    expect(model.facts.specialDistricts.status).toBe("present");
    if (model.facts.specialDistricts.status === "present") {
      expect(model.facts.specialDistricts.substrateOnlyDistricts).toBeUndefined();
    }
  });
});

// P-222 D7: live-verified against the deployed Smart Site product for parcel
// 48021:31622 (1306 FAYETTE ST, Bastrop) — the reader's `utilityService` rail
// genuinely serves sewer CCN 20466 (City of Bastrop) and electric CCN 1324,
// while this composer's `utilities` section only ever asked the HIFLD
// electric-only resolver. These tests are the regression guard for that fix.
describe("P-222 D7: composeParcelReportFacts composes utilities from the reader's utilityService rail", () => {
  it("uses the reader's CCN holders for water/sewer/electric when the rail serves 'record'", async () => {
    const record: ParcelRecordResponse = {
      parcelNodeId,
      placeKey: parcelNodeId,
      countyFips: "48021",
      railRegistrySha: "sha",
      readAt: "2026-09-15T00:00:00.000Z",
      rails: {
        utilityService: rail("record", {
          kind: "value",
          value: {
            water: null,
            sewer: { ccnNo: "20466", utility: "CITY OF BASTROP", status: "Commission Approved", ccnType: "Bounded Service Area" },
            electric: { ccnNo: "1324", utility: "CITY OF BASTROP - (TX)", status: "NOT AVAILABLE", ccnType: "MUNICIPAL" },
          },
        }),
      },
      refused: null,
    };
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(record),
    });

    expect(model.facts.utilities.status).toBe("present");
    if (model.facts.utilities.status !== "present") throw new Error("unreachable");
    const sewer = model.facts.utilities.holders.find((h) => h.serviceKind === "sewer");
    const electric = model.facts.utilities.holders.find((h) => h.serviceKind === "electric");
    expect(sewer).toMatchObject({ territoryName: "CITY OF BASTROP", ccnNo: "20466", ccnStatus: "Commission Approved" });
    expect(electric).toMatchObject({ territoryName: "CITY OF BASTROP - (TX)", ccnNo: "1324", ccnStatus: "NOT AVAILABLE" });
    // water is genuinely null on the reader's own answer -- named, not silently omitted.
    expect(model.facts.utilities.residual).toContain("water");
  });

  it("falls back to the HIFLD electric-only resolver only for the electric slot when the reader's own electric holder is null", async () => {
    const record: ParcelRecordResponse = {
      parcelNodeId,
      placeKey: parcelNodeId,
      countyFips: "48021",
      railRegistrySha: "sha",
      readAt: "2026-09-15T00:00:00.000Z",
      rails: {
        utilityService: rail("record", {
          kind: "value",
          value: {
            water: null,
            sewer: { ccnNo: "20466", utility: "CITY OF BASTROP" },
            electric: null,
          },
        }),
      },
      refused: null,
    };
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(record),
      centroid: { latitude: 30.11, longitude: -97.31 },
      whoServes: {
        resolve: async () => ({
          status: "measured",
          holders: [{ serviceKind: "electric", territoryName: "Bluebonnet Electric Coop" }],
          residual: "HIFLD residual text",
          asOf: "2026-09-15T00:00:00.000Z",
        }),
      },
    });

    expect(model.facts.utilities.status).toBe("present");
    if (model.facts.utilities.status !== "present") throw new Error("unreachable");
    expect(model.facts.utilities.holders.find((h) => h.serviceKind === "electric")).toMatchObject({
      territoryName: "Bluebonnet Electric Coop",
    });
    expect(model.facts.utilities.holders.find((h) => h.serviceKind === "sewer")).toMatchObject({ ccnNo: "20466" });
  });

  it("stays on the pre-existing HIFLD-only behavior, byte-for-byte, when the reader has no utilityService rail at all", async () => {
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      centroid: { latitude: 30.11, longitude: -97.31 },
      whoServes: {
        resolve: async () => ({
          status: "measured",
          holders: [{ serviceKind: "electric", territoryName: "Bluebonnet Electric Coop" }],
          residual: "HIFLD residual text",
          asOf: "2026-09-15T00:00:00.000Z",
        }),
      },
    });
    expect(model.facts.utilities).toMatchObject({
      status: "present",
      residual: "HIFLD residual text",
      holders: [{ serviceKind: "electric", territoryName: "Bluebonnet Electric Coop" }],
    });
  });

  it("never calls the HIFLD resolver at all when the reader's own electric holder already answers -- a HIFLD outage cannot sink an already-resolved section", async () => {
    const record: ParcelRecordResponse = {
      parcelNodeId,
      placeKey: parcelNodeId,
      countyFips: "48021",
      railRegistrySha: "sha",
      readAt: "2026-09-15T00:00:00.000Z",
      rails: {
        utilityService: rail("record", {
          kind: "value",
          value: {
            water: null,
            sewer: { ccnNo: "20466", utility: "CITY OF BASTROP" },
            electric: { ccnNo: "1324", utility: "CITY OF BASTROP - (TX)" },
          },
        }),
      },
      refused: null,
    };
    let hifldCalled = false;
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(record),
      centroid: { latitude: 30.11, longitude: -97.31 },
      whoServes: {
        resolve: async () => {
          hifldCalled = true;
          throw new Error("HIFLD outage -- must never be reached when the reader fully answers");
        },
      },
    });
    expect(hifldCalled).toBe(false);
    expect(model.facts.utilities.status).toBe("present");
  });

  it("a malformed sewer holder is treated as uncovered for sewer only, never discarding valid water/electric siblings", async () => {
    const record: ParcelRecordResponse = {
      parcelNodeId,
      placeKey: parcelNodeId,
      countyFips: "48021",
      railRegistrySha: "sha",
      readAt: "2026-09-15T00:00:00.000Z",
      rails: {
        utilityService: rail("record", {
          kind: "value",
          value: {
            water: { ccnNo: "111", utility: "CITY OF BASTROP WATER" },
            sewer: { ccnNo: "222" }, // malformed: missing required `utility`
            electric: { ccnNo: "1324", utility: "CITY OF BASTROP - (TX)" },
          },
        }),
      },
      refused: null,
    };
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(record),
    });
    expect(model.facts.utilities.status).toBe("present");
    if (model.facts.utilities.status !== "present") throw new Error("unreachable");
    expect(model.facts.utilities.holders.find((h) => h.serviceKind === "water")).toMatchObject({ ccnNo: "111" });
    expect(model.facts.utilities.holders.find((h) => h.serviceKind === "electric")).toMatchObject({ ccnNo: "1324" });
    expect(model.facts.utilities.holders.find((h) => h.serviceKind === "sewer")).toBeUndefined();
    expect(model.facts.utilities.residual).toContain("sewer");
  });
});

// P-222 D8: live-verified against the deployed Smart Site product for the
// same parcel — the reader's `overlayDistricts` rail genuinely serves a
// Cultural Arts / TND overlay district with full ordinance text, while this
// composer had no field for it at all before this lane.
describe("P-222 D8: composeParcelReportFacts composes overlayDistricts from the reader", () => {
  it("reads a real overlay district (name, city, description, development pattern) from the companion payload", async () => {
    const record: ParcelRecordResponse = {
      parcelNodeId,
      placeKey: parcelNodeId,
      countyFips: "48021",
      railRegistrySha: "sha",
      readAt: "2026-09-15T00:00:00.000Z",
      rails: {
        overlayDistricts: rail("record", { kind: "value" }, [
          {
            payload: {
              city: "Bastrop",
              attributes: {
                CD_Name: "Cultural Arts",
                CD_Desc: "Arts and culture are the centerpiece of this district.",
                CD_DevelopmentPatterns: "TND",
              },
            },
          },
        ]),
      },
      refused: null,
    };
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(record),
    });

    expect(model.facts.overlayDistricts.status).toBe("present");
    if (model.facts.overlayDistricts.status !== "present") throw new Error("unreachable");
    expect(model.facts.overlayDistricts.districts).toEqual([
      {
        name: "Cultural Arts",
        cityName: "Bastrop",
        description: "Arts and culture are the centerpiece of this district.",
        developmentPattern: "TND",
      },
    ]);
  });

  it("is absent (blocked-at-source), never a crash, when the reader has no overlayDistricts rail", async () => {
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
    });
    expect(model.facts.overlayDistricts).toMatchObject({ status: "absent", kind: "blocked-at-source" });
  });

  it("D5-consistency: a rail that RAN and confirmed zero districts is `clear`, never the same `blocked-at-source` as a rail that never ran", async () => {
    const record: ParcelRecordResponse = {
      parcelNodeId,
      placeKey: parcelNodeId,
      countyFips: "48021",
      railRegistrySha: "sha",
      readAt: "2026-09-15T00:00:00.000Z",
      rails: {
        overlayDistricts: rail("record", { kind: "absent-verified" }, []),
      },
      refused: null,
    };
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(record),
    });
    expect(model.facts.overlayDistricts).toMatchObject({ status: "absent", kind: "clear" });
  });
});

// P-222 D11: live-verified against the same parcel — the reader's own
// ST_Area(geography) parcel-area figure (25,001.79 sq ft) genuinely disagrees
// with this report's own ring-shoelace figure (25,085.758 sq ft printed).
// composeParcelReportFacts carries the reader's figure as a SEPARATE fact
// (readerParcelArea); the reconciliation note itself is composePackageLayer's
// job (composeParcelReport, not composeParcelReportFacts) and is covered in
// report-model.test.ts.
describe("P-222 D11: composeParcelReportFacts composes readerParcelArea from the reader's parcelAreaSqFt rail", () => {
  it("reads the reader's ST_Area-derived figure as a scalar", async () => {
    const record: ParcelRecordResponse = {
      parcelNodeId,
      placeKey: parcelNodeId,
      countyFips: "48021",
      railRegistrySha: "sha",
      readAt: "2026-09-15T00:00:00.000Z",
      rails: {
        parcelAreaSqFt: rail("record", { kind: "value", value: 25001.79 }),
      },
      refused: null,
    };
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(record),
    });
    expect(model.facts.readerParcelArea).toMatchObject({ status: "present", sqFt: 25001.79 });
  });

  it("is absent (out-of-scope), never a crash, when the reader has no parcelAreaSqFt rail", async () => {
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
    });
    expect(model.facts.readerParcelArea).toMatchObject({ status: "absent", kind: "out-of-scope" });
  });
});
