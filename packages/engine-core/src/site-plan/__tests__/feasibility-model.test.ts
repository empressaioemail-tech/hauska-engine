import { describe, expect, it } from "vitest";
import type { PropertyAtomInstance } from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import { boundaryEdgesForRing } from "./boundary-edge-fixture.js";
import { composeFeasibilityModel } from "../feasibility-model.js";
import { composeSitePlanModel } from "../site-model.js";

// ─── fixtures (mirrors dossier.test.ts / render.test.ts) ─────────────────
const bbox = { westLng: -98.5, southLat: 29.4, eastLng: -98.4995, northLat: 29.4004 };
const dem = {
  width: 4,
  height: 4,
  values: new Float32Array([
    200, 200.5, 201, 201.2, 199.8, 200.2, 200.7, 201.0, 199.5, 200.0, 200.4, 200.8, 199.2, 199.7, 200.1, 200.5,
  ]),
  minElevation: 199.2,
  maxElevation: 201.2,
  nodataCount: 0,
};
const ringWgs84: Array<[number, number]> = [
  [-98.4998, 29.4001],
  [-98.4996, 29.4001],
  [-98.4996, 29.4003],
  [-98.4998, 29.4003],
  [-98.4998, 29.4001],
];
const setback = {
  front: 10,
  side: 5,
  rear: 20,
  sourceCodeAtomRef: { atomDid: "san_antonio_tx/udc/35-310.01/35-310.01", role: "rule", entityType: "code-section" },
};
const boundaryEdges = boundaryEdgesForRing(ringWgs84, [
  { role: "front", feet: 10 },
  { role: "side", feet: 5 },
  { role: "rear", feet: 20 },
  { role: "side", feet: 5 },
]);

function buildSitePlanModel() {
  return composeSitePlanModel({
    parcelNodeId: "48029:105129",
    bbox,
    ringWgs84,
    dem,
    contourIntervalMeters: 0.5,
    setback,
    boundaryEdges,
    descriptor: { address: "1127 N PINE ST, SAN ANTONIO, TX 78202", countyName: "Bexar County" },
    zoning: { district: "R-6" },
    floodZone: { honestUnavailable: true, reason: "sandbox has no network egress" },
    geometrySourceRef: "txgio-parcel:48029:105129:stratmap25-landparcels_48029_2025",
  });
}

function fakeStorage(atoms: PropertyAtomInstance[]): StoragePort {
  return {
    listPropertyAtomsByParcelNodeId: async () => atoms,
  } as unknown as StoragePort;
}

const zoningFactAtomFixture = {
  entityType: "cad-parcel-roll" as const,
  atomDid: "cad_1",
  parcelNodeId: "48029:105129",
  taxYear: 2025,
  countyFips: "48029",
  propId: "105129",
  keyKind: "prop_id" as const,
  joinPassedOwnerMatchGate: true,
  reasoningChain: { reasoningKind: "observed" as const },
  sourceTier: "county-cad" as const,
  legalDescription: "LOT 4 BLK 2 SAMPLE SUB",
  marketValue: 250000,
  assessedValue: 220000,
  situsAddress: "1127 N PINE ST",
  accessPolicy: "public-free" as const,
  sourceCitation: "Bexar CAD 2025 roll",
  extractedAt: "2026-08-01T00:00:00Z",
  verificationStatus: "machine" as const,
  sourceAdapter: "cad-roll:bexar",
  evaluatedAt: "2026-08-01T00:00:00Z",
  atomTier: "data" as const,
  entityId: "48029:105129",
  jurisdictionTenant: "property-spine",
  fetchedAt: "2026-08-01T00:00:00Z",
  sourceUrl: "",
  contentHash: "",
  status: "active" as const,
};

describe("composeFeasibilityModel", () => {
  it("produces honest absence for every section with no atom on file", async () => {
    const sitePlan = buildSitePlanModel();
    const model = await composeFeasibilityModel({
      parcelNodeId: "48029:105129",
      storage: fakeStorage([]),
      sitePlan,
    });

    expect(model.parcelOwnership.status).toBe("absent");
    expect(model.flood.status).toBe("absent");
    expect(model.specialDistricts.status).toBe("absent");
    expect(model.wellsPipelines.status).toBe("absent");
    expect(model.utilities.status).toBe("absent");
    expect(model.footprint.status).toBe("absent");
    expect(model.hoa.searchStatus).toBe("not-searched");
    expect(model.jurisdiction.cityLimitsStatus).toBe("unresolved");
    // Never a zero or empty string standing in for unknown.
    if (model.parcelOwnership.status === "absent") {
      expect(model.parcelOwnership.reason.length).toBeGreaterThan(0);
    }
  });

  it("generates exactly one open item per absent section, plus HOA and jurisdiction always", async () => {
    const sitePlan = buildSitePlanModel();
    const model = await composeFeasibilityModel({
      parcelNodeId: "48029:105129",
      storage: fakeStorage([]),
      sitePlan,
    });
    // absent: parcelOwnership, flood, specialDistricts, wellsPipelines, utilities, footprint = 6
    // always: jurisdiction, hoa = 2
    expect(model.openItems.length).toBe(8);
    expect(model.openItems.map((i) => i.section)).toContain("hoa");
    expect(model.openItems.map((i) => i.section)).toContain("jurisdiction");
  });

  it("reads a present cad-parcel-roll atom into parcelOwnership, never fabricating a value it lacks", async () => {
    const sitePlan = buildSitePlanModel();
    const model = await composeFeasibilityModel({
      parcelNodeId: "48029:105129",
      storage: fakeStorage([zoningFactAtomFixture as unknown as PropertyAtomInstance]),
      sitePlan,
    });
    expect(model.parcelOwnership.status).toBe("present");
    if (model.parcelOwnership.status === "present") {
      expect(model.parcelOwnership.legalDescription).toBe("LOT 4 BLK 2 SAMPLE SUB");
      expect(model.parcelOwnership.marketValue).toBe(250000);
      // ownerName was never on this fixture atom — must stay undefined, not "".
      expect(model.parcelOwnership.ownerName).toBeUndefined();
    }
    // Fewer open items now that parcelOwnership resolved.
    expect(model.openItems.map((i) => i.section)).not.toContain("parcelOwnership");
  });

  it("does not block on a failing who-serves resolver — degrades to honest absence", async () => {
    const sitePlan = buildSitePlanModel();
    const model = await composeFeasibilityModel({
      parcelNodeId: "48029:105129",
      storage: fakeStorage([]),
      sitePlan,
      centroid: { latitude: 29.4, longitude: -98.5 },
      whoServes: {
        resolve: async () => {
          throw new Error("network unreachable");
        },
      },
    });
    expect(model.utilities.status).toBe("absent");
    if (model.utilities.status === "absent") {
      expect(model.utilities.reason).toContain("network unreachable");
    }
  });

  it("who-serves measured result reconciles into a present utilities section with the mandatory residual", async () => {
    const sitePlan = buildSitePlanModel();
    const model = await composeFeasibilityModel({
      parcelNodeId: "48029:105129",
      storage: fakeStorage([]),
      sitePlan,
      centroid: { latitude: 29.4, longitude: -98.5 },
      whoServes: {
        resolve: async () => ({
          status: "measured",
          holders: [{ serviceKind: "water", territoryName: "Sample Water SUD" }],
          residual: "SERVICE-LETTER-REQUIRED — territory is not tap/capacity/extension commitment.",
          asOf: "2026-09-01T00:00:00Z",
        }),
      },
    });
    expect(model.utilities.status).toBe("present");
    if (model.utilities.status === "present") {
      expect(model.utilities.holders[0]?.territoryName).toBe("Sample Water SUD");
      expect(model.utilities.residual).toContain("SERVICE-LETTER-REQUIRED");
    }
  });

  it("item 5: a persisted flood study supersedes the screening fact rather than appending a second finding", async () => {
    const sitePlan = buildSitePlanModel();
    const floodAtom = {
      entityType: "flood-hazard-fact" as const,
      atomDid: "flood_1",
      parcelNodeId: "48029:105129",
      reasoningChain: { reasoningKind: "observed" as const },
      sourceTier: "fema-nfhl" as const,
      inSpecialFloodHazardArea: false,
      floodZone: "X",
      accessPolicy: "public-free" as const,
      sourceCitation: "FEMA NFHL",
      extractedAt: "2026-08-01T00:00:00Z",
      verificationStatus: "machine" as const,
      sourceAdapter: "fema-nfhl",
      evaluatedAt: "2026-08-01T00:00:00Z",
      atomTier: "data" as const,
      entityId: "48029:105129",
      jurisdictionTenant: "property-spine",
      fetchedAt: "2026-08-01T00:00:00Z",
      sourceUrl: "",
      contentHash: "",
      status: "active" as const,
    };
    const model = await composeFeasibilityModel({
      parcelNodeId: "48029:105129",
      storage: fakeStorage([floodAtom as unknown as PropertyAtomInstance]),
      sitePlan,
      floodStudyAvailable: true,
    });
    expect(model.flood.status).toBe("present");
    if (model.flood.status === "present") {
      expect(model.flood.supersedesScreeningFact).toBe(true);
    }
    expect(model.dataQuality.supersededNotes.length).toBe(1);
    expect(model.dataQuality.supersededNotes[0]).toContain("supersedes");
  });

  // item 14, defect 9: well-fact (and the sibling list-composed atom types —
  // special-district-fact, rrc-pipeline-fact, building-footprint) persist an
  // honest "checked, found nothing" row as a real atom carrying an `absence`
  // field, rather than having no row at all. Filtering on entityType alone
  // read that row as a present fact and rendered "Well 1: on file" for a
  // parcel with no well on record — a real fabrication, not a detail gap.
  it("an absence-shaped well-fact atom (no well on or near the parcel) reads as absent, never a fabricated present well", async () => {
    const sitePlan = buildSitePlanModel();
    const absentWellAtom = {
      entityType: "well-fact" as const,
      atomDid: "wlfact_1",
      parcelNodeId: "48029:105129",
      wellKey: "none",
      absence: { kind: "no-well-on-or-near", reason: "no Texas RRC surface well on or within 152 m of parcel geometry" },
      reasoningChain: { reasoningKind: "observed" as const },
      sourceTier: "texas-rrc-gis" as const,
      accessPolicy: "public-free" as const,
      sourceCitation: "Texas RRC surface wells staged in tx_rrc_well (first-party statewide)",
      extractedAt: "2026-08-31T19:55:57.048Z",
      verificationStatus: "machine" as const,
      sourceAdapter: "tx-rrc-well-staged-v1",
      evaluatedAt: "2026-08-31T19:55:57.048Z",
      atomTier: "data" as const,
      entityId: "48029:105129:none",
      jurisdictionTenant: "tx_48029",
      fetchedAt: "2026-08-31T19:55:57.048Z",
      sourceUrl: "tx_rrc_well",
      contentHash: "",
      status: "active" as const,
    };
    const model = await composeFeasibilityModel({
      parcelNodeId: "48029:105129",
      storage: fakeStorage([absentWellAtom as unknown as PropertyAtomInstance]),
      sitePlan,
    });
    expect(model.wellsPipelines.status).toBe("absent");
    expect(model.openItems.map((i) => i.section)).toContain("wellsPipelines");
  });

  // item 19: named downstream discharge point — a comprehensiveness section,
  // independent of flood-hazard-fact presence and never auto-generating an
  // open item (a coverage limitation, not something the customer can fix).
  it("item 19: absent (no open item) when no exit point or resolver was supplied", async () => {
    const sitePlan = buildSitePlanModel();
    const model = await composeFeasibilityModel({ parcelNodeId: "48029:105129", storage: fakeStorage([]), sitePlan });
    expect(model.dischargePoint.status).toBe("absent");
    expect(model.openItems.map((i) => i.section)).not.toContain("dischargePoint");
  });

  it("item 19: present when a resolver finds a real named feature near the supplied exit point", async () => {
    const sitePlan = buildSitePlanModel();
    const model = await composeFeasibilityModel({
      parcelNodeId: "48029:105129",
      storage: fakeStorage([]),
      sitePlan,
      dischargeExitPoint: { lat: 30.1269, lng: -97.3305 },
      dischargeResolver: {
        resolve: async () => ({
          status: "present",
          point: {
            name: "Piney Creek",
            featureType: "STREAM/RIVER",
            distanceMeters: 41,
            sourceUrl: "https://maps.co.bastrop.tx.us/.../Creeks_Streams/MapServer/0",
            layerName: "Bastrop County Creeks & Streams",
          },
        }),
      },
    });
    expect(model.dischargePoint.status).toBe("present");
    if (model.dischargePoint.status === "present") {
      expect(model.dischargePoint.point.name).toBe("Piney Creek");
    }
  });

  it("item 19: does not block the report when the resolver throws", async () => {
    const sitePlan = buildSitePlanModel();
    const model = await composeFeasibilityModel({
      parcelNodeId: "48029:105129",
      storage: fakeStorage([]),
      sitePlan,
      dischargeExitPoint: { lat: 30.1269, lng: -97.3305 },
      dischargeResolver: {
        resolve: async () => {
          throw new Error("upstream timeout");
        },
      },
    });
    expect(model.dischargePoint.status).toBe("absent");
    if (model.dischargePoint.status === "absent") {
      expect(model.dischargePoint.reason).toContain("upstream timeout");
    }
  });
});
