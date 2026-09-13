import { describe, expect, it } from "vitest";
import type { PropertyAtomInstance } from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import { composeParcelReportFacts } from "../report-model.js";
import { composeSitePlanModel } from "../site-model.js";
import { parcelOwnershipEntitledForTier, type CallerAccessTier } from "../feasibility-model.js";
import { boundaryEdgesForRing } from "./boundary-edge-fixture.js";

/**
 * P152-ENTITLEMENT (OPS-23 wave 4, CP1 approved 2026-09-13).
 *
 * `composeParcelReportFacts`'s `parcelOwnership` section is the ONLY place
 * in either `hauska-engine` or `legacy-design-tools` where the engine
 * independently reads its own substrate/reader for dollar rails
 * (marketValue/assessedValue/landValue/improvementValue) and owner info
 * (ownerName/ownerMailingAddress/absenteeOwner) — confirmed at CP1 by
 * reading `author.ts`, `dossier-author.ts` and `flood-drainage.ts`, none of
 * which call this function. These tests are this lane's falsifier per its
 * own pre-registered claim: "If an unentitled live call returns a dollar or
 * owner value from the engine after step 2, the gate is not in the path."
 */

// ─── fixtures (mirrors report-model.test.ts's own pattern exactly) ───────
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
const parcelNodeId = "48029:105129";

function buildSitePlanModel() {
  return composeSitePlanModel({
    parcelNodeId,
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
  return { listPropertyAtomsByParcelNodeId: async () => atoms } as unknown as StoragePort;
}

const NO_DRAINAGE = { status: "absent" as const, reason: "test fixture: drainage not composed" };

const cadRollAtomFixture = {
  entityType: "cad-parcel-roll" as const,
  atomDid: "cad_1",
  parcelNodeId,
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
  landValue: 60000,
  improvementValue: 190000,
  situsAddress: "1127 N PINE ST",
  accessPolicy: "public-free" as const,
  sourceCitation: "Bexar CAD 2025 roll",
  extractedAt: "2026-08-01T00:00:00Z",
  verificationStatus: "machine" as const,
  sourceAdapter: "cad-roll:bexar",
  evaluatedAt: "2026-08-01T00:00:00Z",
  atomTier: "data" as const,
  entityId: parcelNodeId,
  jurisdictionTenant: "property-spine",
  fetchedAt: "2026-08-01T00:00:00Z",
  sourceUrl: "",
  contentHash: "",
  status: "active" as const,
};

const ownerAtomFixture = {
  entityType: "owner-fact" as const,
  atomDid: "owner_1",
  parcelNodeId,
  ownerName: "Jane Q. Landowner",
  ownerMailingAddress: "PO Box 1, Somewhere, TX",
  reasoningChain: { reasoningKind: "observed" as const },
  sourceTier: "county-cad" as const,
  accessPolicy: "public-free" as const,
  sourceCitation: "test",
  extractedAt: "2026-08-01T00:00:00Z",
  verificationStatus: "machine" as const,
  sourceAdapter: "test",
  evaluatedAt: "2026-08-01T00:00:00Z",
  atomTier: "data" as const,
  entityId: parcelNodeId,
  jurisdictionTenant: "property-spine",
  fetchedAt: "2026-08-01T00:00:00Z",
  sourceUrl: "",
  contentHash: "",
  status: "active" as const,
};

const entitledFixtureAtoms = [
  cadRollAtomFixture as unknown as PropertyAtomInstance,
  ownerAtomFixture as unknown as PropertyAtomInstance,
];

async function composeWithTier(callerTier: CallerAccessTier | undefined) {
  const sitePlan = buildSitePlanModel();
  return composeParcelReportFacts({
    parcelNodeId,
    storage: fakeStorage(entitledFixtureAtoms),
    geometry: { status: "present", model: sitePlan },
    drainage: NO_DRAINAGE,
    ...(callerTier !== undefined ? { callerTier } : {}),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Pure allowlist function
// ─────────────────────────────────────────────────────────────────────────
describe("parcelOwnershipEntitledForTier (CP1 Q2 allowlist)", () => {
  it("grants public-paid, platform-internal, tenant-private", () => {
    expect(parcelOwnershipEntitledForTier("public-paid")).toBe(true);
    expect(parcelOwnershipEntitledForTier("platform-internal")).toBe(true);
    expect(parcelOwnershipEntitledForTier("tenant-private")).toBe(true);
  });

  it("refuses public-free", () => {
    expect(parcelOwnershipEntitledForTier("public-free")).toBe(false);
  });

  it("omitted (undefined) defaults to granted — preserves every pre-gate caller/test", () => {
    expect(parcelOwnershipEntitledForTier(undefined)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// composeParcelReportFacts — the actual falsifier
// ─────────────────────────────────────────────────────────────────────────
describe("composeParcelReportFacts gates parcelOwnership on callerTier (CP1 falsifier)", () => {
  it("public-free: parcelOwnership is absent(entitlement-required); every OTHER section is unaffected", async () => {
    const granted = await composeWithTier("public-paid");
    const refused = await composeWithTier("public-free");

    expect(refused.facts.parcelOwnership.status).toBe("absent");
    if (refused.facts.parcelOwnership.status === "absent") {
      expect(refused.facts.parcelOwnership.kind).toBe("entitlement-required");
      expect(refused.facts.parcelOwnership.reason).toMatch(/studio|team|property unlock/i);
    }
    // The falsifier itself: no dollar or owner value anywhere in the
    // serialized refused section — not just the typed field, the raw
    // string, so an accidental duplicate emission elsewhere would still
    // be caught.
    const refusedSectionJson = JSON.stringify(refused.facts.parcelOwnership);
    expect(refusedSectionJson).not.toContain("250000");
    expect(refusedSectionJson).not.toContain("220000");
    expect(refusedSectionJson).not.toContain("Jane Q. Landowner");

    // No regression scoped to ONLY parcelOwnership -- every other section
    // is byte-for-byte identical between the two composes.
    const { parcelOwnership: _refusedOwnership, ...refusedRest } = refused.facts;
    const { parcelOwnership: _grantedOwnership, ...grantedRest } = granted.facts;
    expect(refusedRest).toEqual(grantedRest);
  });

  it("public-paid: parcelOwnership is present with real dollar and owner values (no regression for the entitled/legacy-default path)", async () => {
    const model = await composeWithTier("public-paid");
    expect(model.facts.parcelOwnership.status).toBe("present");
    if (model.facts.parcelOwnership.status === "present") {
      expect(model.facts.parcelOwnership.marketValue).toBe(250000);
      expect(model.facts.parcelOwnership.assessedValue).toBe(220000);
      expect(model.facts.parcelOwnership.ownerName).toBe("Jane Q. Landowner");
    }
  });

  it("platform-internal and tenant-private: present (CP1 Q2 — fixture-only, no live caller sends either value as of 2026-09-13)", async () => {
    const platformInternal = await composeWithTier("platform-internal");
    const tenantPrivate = await composeWithTier("tenant-private");
    expect(platformInternal.facts.parcelOwnership.status).toBe("present");
    expect(tenantPrivate.facts.parcelOwnership.status).toBe("present");
  });

  it("omitted callerTier (option not passed at all): present — every pre-gate caller/test that does not know about this option keeps its prior behavior", async () => {
    const model = await composeWithTier(undefined);
    expect(model.facts.parcelOwnership.status).toBe("present");
  });
});
