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

function fakeReader(record: ParcelRecordResponse): RecordReaderClient {
  return { fetchRecord: async () => ({ ok: true, record }) };
}

function failingReader(reason: string): RecordReaderClient {
  return { fetchRecord: async () => ({ ok: false, reason }) };
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
    expect(model.facts.jurisdiction.etjStatus).toBe("unresolved"); // no ETJ rail exists anywhere — never fabricated
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
