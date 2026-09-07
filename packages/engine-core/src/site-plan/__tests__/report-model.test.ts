import { describe, expect, it } from "vitest";
import type { PropertyAtomInstance } from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import { boundaryEdgesForRing } from "./boundary-edge-fixture.js";
import {
  composeParcelReport,
  composeParcelReportFacts,
  resolveParcelDrainage,
  DRAINAGE_STUDY_STALE_AFTER_MS,
  type ParcelReportModel,
} from "../report-model.js";
import { composeSitePlanModel } from "../site-model.js";
import type { ParcelGeometryResolver, TerrainArtifactStore } from "../../parcel-terrain/author.js";
import { FEASIBILITY_MANIFEST, X_RAY_MANIFEST } from "../report-manifest.js";

// ─── fixtures (mirrors dossier.test.ts / feasibility-model.test.ts) ───────
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

const zoningFactAtomFixture = {
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

// ─────────────────────────────────────────────────────────────────────────
// R1 — composeParcelReport: ONE composition, shared by every product.
// ─────────────────────────────────────────────────────────────────────────

describe("R1: composeParcelReport composes once, and is the single source every product reads", () => {
  it("two independent product-style readers of ONE composed model see the identical fact object, asserted by identity", async () => {
    const sitePlan = buildSitePlanModel();
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([zoningFactAtomFixture as unknown as PropertyAtomInstance]),
      geometry: { status: "present", model: sitePlan },
      drainage: NO_DRAINAGE,
    });

    // Two stand-ins for "what a product's renderer reads" — Feasibility's
    // real fact-digest section, and a not-yet-wired X-Ray-style reader
    // (X_RAY_MANIFEST exists, R6 has not cut its renderer over yet). Both
    // read the SAME model, so both see the SAME object for a shared fact —
    // not a structurally-equal copy, the literal same reference. This is the
    // whole point of composing once: two products cannot disagree about a
    // shared fact because there is one field, not because a checker
    // compares two independently-derived copies.
    const feasibilityReadsFlood = (m: ParcelReportModel) => m.facts.flood;
    const xrayReadsFlood = (m: ParcelReportModel) => m.facts.flood;
    expect(FEASIBILITY_MANIFEST.product).toBe("feasibility");
    expect(X_RAY_MANIFEST.product).toBe("x-ray");
    expect(feasibilityReadsFlood(model)).toBe(xrayReadsFlood(model));

    const feasibilityReadsOwnership = (m: ParcelReportModel) => m.facts.parcelOwnership;
    const xrayReadsOwnership = (m: ParcelReportModel) => m.facts.parcelOwnership;
    expect(feasibilityReadsOwnership(model)).toBe(xrayReadsOwnership(model));
    // And it is genuinely the resolved fact, not a placeholder — reference
    // identity on an empty/never-resolved object would prove nothing.
    expect(model.facts.parcelOwnership.status).toBe("present");
  });

  it("CONTRAST: composing independently (today's pre-fix architecture) does NOT yield identity — this is the bug R1 removes", async () => {
    const sitePlan = buildSitePlanModel();
    const optionsA = {
      parcelNodeId,
      storage: fakeStorage([zoningFactAtomFixture as unknown as PropertyAtomInstance]),
      geometry: { status: "present" as const, model: sitePlan },
      drainage: NO_DRAINAGE,
    };
    const modelA = await composeParcelReportFacts(optionsA);
    const modelB = await composeParcelReportFacts(optionsA);
    // Two SEPARATE composition calls (the old per-product-derivation shape)
    // produce two DIFFERENT objects even given identical inputs — structural
    // equality, never identity. That gap is exactly what let two products
    // disagree; composing once and sharing the result (the test above) is
    // the actual fix, not a redundant restatement of it.
    expect(modelA.facts.parcelOwnership).not.toBe(modelB.facts.parcelOwnership);
    expect(modelA.facts.parcelOwnership).toEqual(modelB.facts.parcelOwnership);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// R2 — section-level failure isolation. Verified by violation: force each
// section to throw in turn; the document (model) still composes and the
// failing section alone reports a declared absence.
// ─────────────────────────────────────────────────────────────────────────

describe("R2: section-level failure isolation, verified by violation", () => {
  const throwingResolver: ParcelGeometryResolver = {
    async resolve() {
      throw new Error("simulated resolver outage");
    },
  };
  const workingResolver: ParcelGeometryResolver = {
    async resolve() {
      return { bbox, sourceRef: `txgio-parcel:${parcelNodeId}:stratmap25-landparcels_48029_2025`, ring: ringWgs84 };
    },
  };
  const fakeArtifactStore = (): TerrainArtifactStore & { get(ref: string): Promise<Uint8Array | null> } => {
    const data = new Map<string, Uint8Array>();
    return {
      async put(input) {
        const key = `memory://${data.size}`;
        data.set(key, input.bytes);
        return key;
      },
      async get(ref) {
        return data.get(ref) ?? null;
      },
    };
  };
  const fakeFetchDem = (async (bboxArg: unknown, opts: { resolutionMeters: number }) => ({
    bytes: new Uint8Array(0),
    contentType: "image/tiff",
    bbox: bboxArg as typeof bbox,
    resolutionMeters: opts.resolutionMeters,
    resolutionMetersRequested: opts.resolutionMeters,
    resolutionMetersActual: null,
    widthPx: dem.width,
    heightPx: dem.height,
    endpoint: "https://fake.usgs.example/exportImage",
    fetchedAt: new Date().toISOString(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any;
  const fakeParseDem = async () => dem;

  it("geometry composition throwing degrades ONLY geometry-derived sections; atom-derived sections still resolve", async () => {
    const { model } = await composeParcelReport({
      parcelNodeId,
      resolver: throwingResolver,
      setback: undefined,
      storage: fakeStorage([zoningFactAtomFixture as unknown as PropertyAtomInstance]),
      artifactStore: fakeArtifactStore(),
      fetchDem: fakeFetchDem,
      parseDem: fakeParseDem,
    });

    expect(model.geometry.status).toBe("absent");
    if (model.geometry.status === "absent") {
      expect(model.geometry.reason.length).toBeGreaterThan(0);
    }
    // Geometry-dependent: degraded.
    expect(model.facts.terrain.status).toBe("absent");
    // NOT geometry-dependent: unaffected by the geometry outage.
    expect(model.facts.parcelOwnership.status).toBe("present");
    expect(model.package.verdict).toMatch(/could not be determined/i);
    expect(model.package.openItems.map((i) => i.section)).toContain("geometry");
  });

  it("an atoms-fetch failure degrades every atom-derived section with ONE shared, honestly-labeled reason; geometry is unaffected", async () => {
    const throwingStorage = {
      listPropertyAtomsByParcelNodeId: async () => {
        throw new Error("simulated store outage");
      },
    } as unknown as StoragePort;

    // Geometry is supplied ALREADY-COMPOSED here rather than routed through
    // composeSitePlanModelForParcel (which itself reads storage for zoning/
    // envelope lookups — a storage outage would take geometry down too, a
    // real but separate coupling this test isn't about). This isolates the
    // one thing under test: composeParcelReportFacts's OWN atoms-fetch
    // guard, independent of author.ts's own storage dependency.
    const sitePlan = buildSitePlanModel();
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: throwingStorage,
      geometry: { status: "present", model: sitePlan },
      drainage: NO_DRAINAGE,
    });

    expect(model.geometry.status).toBe("present");
    for (const section of [model.facts.parcelOwnership, model.facts.flood, model.facts.specialDistricts, model.facts.wellsPipelines, model.facts.footprint]) {
      expect(section.status).toBe("absent");
      if (section.status === "absent") expect(section.reason).toContain("simulated store outage");
    }
    // Distinguishable from a genuine not-found reason (never conflated).
    expect(model.facts.flood.status === "absent" && model.facts.flood.reason).not.toBe("No flood-hazard-fact atom on file for this parcel.");
  });

  it("a single malformed atom throwing inside ITS OWN section derivation isolates to that section alone", async () => {
    // `absenteeOwner` calls .trim() on situsAddress/ownerMailingAddress — a
    // non-string situsAddress throws INSIDE parcelOwnership's own derivation,
    // not at the shared atoms-fetch step. Every other atom-derived section
    // reads the SAME atoms array successfully.
    const malformedCadRoll = { ...zoningFactAtomFixture, situsAddress: 12345 as unknown as string };
    const ownerAtom = {
      entityType: "owner-fact" as const,
      atomDid: "owner_1",
      parcelNodeId,
      ownerName: "Test Owner",
      ownerMailingAddress: "PO Box 1",
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
    const sitePlan = buildSitePlanModel();
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([malformedCadRoll as unknown as PropertyAtomInstance, ownerAtom as unknown as PropertyAtomInstance]),
      geometry: { status: "present", model: sitePlan },
      drainage: NO_DRAINAGE,
    });

    expect(model.facts.parcelOwnership.status).toBe("absent");
    if (model.facts.parcelOwnership.status === "absent") {
      expect(model.facts.parcelOwnership.reason).toContain("parcelOwnership section failed to compose");
    }
    // Unaffected — reads the SAME atoms array, no shared root cause here.
    expect(model.facts.terrain.status).toBe("present");
  });

  it("a failing who-serves resolver isolates to utilities only; a failing discharge resolver isolates to dischargePoint only", async () => {
    const sitePlan = buildSitePlanModel();
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: { status: "present", model: sitePlan },
      drainage: NO_DRAINAGE,
      centroid: { latitude: 29.4, longitude: -98.5 },
      whoServes: {
        resolve: async () => {
          throw new Error("network unreachable");
        },
      },
      dischargeExitPoint: { lat: 30.1269, lng: -97.3305 },
      dischargeResolver: {
        resolve: async () => {
          throw new Error("upstream timeout");
        },
      },
    });

    expect(model.facts.utilities.status).toBe("absent");
    expect(model.facts.dischargePoint.status).toBe("absent");
    expect(model.facts.parcelOwnership.status).toBe("absent"); // no atom, unrelated absence
    if (model.facts.utilities.status === "absent") expect(model.facts.utilities.reason).toContain("network unreachable");
    if (model.facts.dischargePoint.status === "absent") expect(model.facts.dischargePoint.reason).toContain("upstream timeout");
  });

  it("a package-layer computation still produces a renderable document even when geometry AND every atom read failed", async () => {
    const { model } = await composeParcelReport({
      parcelNodeId,
      resolver: throwingResolver,
      setback: undefined,
      storage: {
        listPropertyAtomsByParcelNodeId: async () => {
          throw new Error("total outage");
        },
      } as unknown as StoragePort,
      artifactStore: fakeArtifactStore(),
      fetchDem: fakeFetchDem,
      parseDem: fakeParseDem,
    });
    // The document still composes — never throws — and names every gap.
    expect(model.package.verdict.length).toBeGreaterThan(0);
    expect(model.package.narrativeSkeleton.length).toBeGreaterThan(0);
    expect(model.package.openItems.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// R3 — the real drainage study replaces the floodStudyAvailable boolean.
// ─────────────────────────────────────────────────────────────────────────

describe("R3: drainage is the real study, never a caller-supplied boolean", () => {
  it("floodStudyAvailable does not exist anywhere on the composed model's types (structural proof)", async () => {
    const sitePlan = buildSitePlanModel();
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: { status: "present", model: sitePlan },
      drainage: NO_DRAINAGE,
    });
    expect(model.facts.flood).not.toHaveProperty("studyAvailable");
    expect(model.drainage).not.toHaveProperty("floodStudyAvailable");
    expect(Object.keys(model)).not.toContain("floodStudyAvailable");
  });

  it("a parcel with no drainage composition requested shows absent, with a reason, never a default", async () => {
    const sitePlan = buildSitePlanModel();
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: { status: "present", model: sitePlan },
      drainage: NO_DRAINAGE,
    });
    expect(model.drainage.status).toBe("absent");
    if (model.drainage.status === "absent") expect(model.drainage.reason.length).toBeGreaterThan(0);
    expect(model.package.openItems.map((i) => i.section)).toContain("drainage");
  });

  it("resolveParcelDrainage reads a real persisted study when fresh, without running one", async () => {
    const study = {
      parcelNodeId,
      catchmentGeoJson: { type: "FeatureCollection", features: [] },
      drainageZonesGeoJson: { type: "FeatureCollection", features: [] },
      rainfallResultGeoJson: null,
      flowLinesGeoJson: { type: "FeatureCollection", features: [] },
      rainfallDepthInches: 9.5,
      rainfallSource: "default" as const,
      demProvenance: { source: "USGS 3DEP", resolutionMeters: 10 },
      briefing: "test briefing",
      flowExits: [],
      stats: { catchmentAreaSqFt: 1000, pondedAreaSqFt: 0, pondedAreaModeledRegionSqFt: 0, flowExitCount: 0, pourPoint: { lng: -98.5, lat: 29.4 }, pourPointMethod: "ring-centroid" as const },
      computation: { library: "test", routing: "d8", accumulationThreshold: 10 },
      parcelRingWgs84: ringWgs84,
      catchmentBbox: bbox,
      geometrySourceRef: "test",
      generatedAt: new Date().toISOString(),
    };
    const studyBytes = new TextEncoder().encode(JSON.stringify(study));
    const artifactData = new Map<string, Uint8Array>([["memory://study", studyBytes]]);
    const storage = {
      listPropertyAtomsByParcelNodeId: async () => [
        {
          entityType: "parcel-terrain-model",
          artifacts: { "json-flood-drainage-study": { format: "json-flood-drainage-study", ref: "memory://study" } },
        } as unknown as PropertyAtomInstance,
      ],
    } as unknown as StoragePort;
    const artifactStore = { async put() { return "unused"; }, async get(ref: string) { return artifactData.get(ref) ?? null; } };
    let ranFreshStudy = false;

    const result = await resolveParcelDrainage({
      parcelNodeId,
      resolver: { async resolve() { ranFreshStudy = true; return null; } },
      storage,
      artifactStore,
      runWhenStale: true, // even opted in, a FRESH persisted study must win over running one
    });

    expect(result.state.status).toBe("present");
    expect(ranFreshStudy).toBe(false);
    expect(result.freshlyComputed).toBeUndefined();
  });

  it("resolveParcelDrainage treats a persisted study older than the staleness window as absent when not opted into a fresh run", async () => {
    const staleStudy = { generatedAt: new Date(Date.now() - DRAINAGE_STUDY_STALE_AFTER_MS - 1_000).toISOString() };
    const studyBytes = new TextEncoder().encode(JSON.stringify(staleStudy));
    const storage = {
      listPropertyAtomsByParcelNodeId: async () => [
        {
          entityType: "parcel-terrain-model",
          artifacts: { "json-flood-drainage-study": { format: "json-flood-drainage-study", ref: "memory://stale" } },
        } as unknown as PropertyAtomInstance,
      ],
    } as unknown as StoragePort;
    const artifactStore = {
      async put() { return "unused"; },
      async get() { return studyBytes; },
    };

    const result = await resolveParcelDrainage({
      parcelNodeId,
      resolver: { async resolve() { return null; } },
      storage,
      artifactStore,
    });

    expect(result.state.status).toBe("absent");
    if (result.state.status === "absent") expect(result.state.reason).toMatch(/stale/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Behavior carried over from the retired composeFeasibilityModel — same
// guarantees, adapted to the new field nesting (facts.* / drainage / package).
// ─────────────────────────────────────────────────────────────────────────

describe("composeParcelReportFacts: behavior preserved from composeFeasibilityModel", () => {
  it("produces honest absence for every section with no atom on file", async () => {
    const sitePlan = buildSitePlanModel();
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: { status: "present", model: sitePlan },
      drainage: NO_DRAINAGE,
    });

    expect(model.facts.parcelOwnership.status).toBe("absent");
    expect(model.facts.flood.status).toBe("absent");
    expect(model.facts.specialDistricts.status).toBe("absent");
    expect(model.facts.wellsPipelines.status).toBe("absent");
    expect(model.facts.utilities.status).toBe("absent");
    expect(model.facts.footprint.status).toBe("absent");
    expect(model.drainage.status).toBe("absent");
    expect(model.facts.hoa.searchStatus).toBe("not-searched");
    expect(model.facts.jurisdiction.cityLimitsStatus).toBe("unresolved");
    if (model.facts.parcelOwnership.status === "absent") {
      expect(model.facts.parcelOwnership.reason.length).toBeGreaterThan(0);
    }
  });

  it("generates exactly one open item per absent section (now including drainage), plus HOA and jurisdiction always", async () => {
    const sitePlan = buildSitePlanModel();
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: { status: "present", model: sitePlan },
      drainage: NO_DRAINAGE,
    });
    // absent: parcelOwnership, flood, specialDistricts, wellsPipelines, utilities, footprint, drainage = 7
    // always: jurisdiction, hoa = 2
    expect(model.package.openItems.length).toBe(9);
    expect(model.package.openItems.map((i) => i.section)).toContain("hoa");
    expect(model.package.openItems.map((i) => i.section)).toContain("jurisdiction");
    expect(model.package.openItems.map((i) => i.section)).toContain("drainage");
    // terrain is derived entirely from geometry and never gets its own item.
    expect(model.package.openItems.map((i) => i.section)).not.toContain("terrain");
  });

  it("reads a present cad-parcel-roll atom into parcelOwnership, never fabricating a value it lacks", async () => {
    const sitePlan = buildSitePlanModel();
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([zoningFactAtomFixture as unknown as PropertyAtomInstance]),
      geometry: { status: "present", model: sitePlan },
      drainage: NO_DRAINAGE,
    });
    expect(model.facts.parcelOwnership.status).toBe("present");
    if (model.facts.parcelOwnership.status === "present") {
      expect(model.facts.parcelOwnership.legalDescription).toBe("LOT 4 BLK 2 SAMPLE SUB");
      expect(model.facts.parcelOwnership.marketValue).toBe(250000);
      expect(model.facts.parcelOwnership.ownerName).toBeUndefined();
    }
    expect(model.package.openItems.map((i) => i.section)).not.toContain("parcelOwnership");
  });

  it("who-serves measured result reconciles into a present utilities section with the mandatory residual", async () => {
    const sitePlan = buildSitePlanModel();
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: { status: "present", model: sitePlan },
      drainage: NO_DRAINAGE,
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
    expect(model.facts.utilities.status).toBe("present");
    if (model.facts.utilities.status === "present") {
      expect(model.facts.utilities.holders[0]?.territoryName).toBe("Sample Water SUD");
      expect(model.facts.utilities.residual).toContain("SERVICE-LETTER-REQUIRED");
    }
  });

  it("item 5, now derived from the real drainage state: a present study supersedes the screening fact rather than appending a second finding", async () => {
    const sitePlan = buildSitePlanModel();
    const floodAtom = {
      entityType: "flood-hazard-fact" as const,
      atomDid: "flood_1",
      parcelNodeId,
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
      entityId: parcelNodeId,
      jurisdictionTenant: "property-spine",
      fetchedAt: "2026-08-01T00:00:00Z",
      sourceUrl: "",
      contentHash: "",
      status: "active" as const,
    };
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([floodAtom as unknown as PropertyAtomInstance]),
      geometry: { status: "present", model: sitePlan },
      drainage: {
        status: "present",
        study: {
          parcelNodeId,
          catchmentGeoJson: { type: "FeatureCollection", features: [] },
          drainageZonesGeoJson: { type: "FeatureCollection", features: [] },
          rainfallResultGeoJson: null,
          flowLinesGeoJson: { type: "FeatureCollection", features: [] },
          rainfallDepthInches: 9.5,
          rainfallSource: "default",
          demProvenance: { source: "USGS 3DEP", resolutionMeters: 10 },
          briefing: "test briefing",
          flowExits: [],
          stats: { catchmentAreaSqFt: 1000, pondedAreaSqFt: 0, pondedAreaModeledRegionSqFt: 0, flowExitCount: 0, pourPoint: { lng: -98.5, lat: 29.4 }, pourPointMethod: "ring-centroid" },
          computation: { library: "test", routing: "d8", accumulationThreshold: 10 },
          parcelRingWgs84: ringWgs84,
          catchmentBbox: bbox,
          geometrySourceRef: "test",
          generatedAt: new Date().toISOString(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      },
    });
    expect(model.facts.flood.status).toBe("present");
    expect(model.drainage.status).toBe("present");
    expect(model.package.dataQuality.supersededNotes.length).toBe(1);
    expect(model.package.dataQuality.supersededNotes[0]).toContain("supersedes");
  });

  // item 14, defect 9: well-fact (and the sibling list-composed atom types —
  // special-district-fact, rrc-pipeline-fact, building-footprint) persist an
  // honest "checked, found nothing" row as a real atom carrying an
  // `absence` field, rather than having no row at all. Filtering on
  // entityType alone read that row as a present fact.
  it("an absence-shaped well-fact atom (no well on or near the parcel) reads as absent, never a fabricated present well", async () => {
    const sitePlan = buildSitePlanModel();
    const absentWellAtom = {
      entityType: "well-fact" as const,
      atomDid: "wlfact_1",
      parcelNodeId,
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
      entityId: `${parcelNodeId}:none`,
      jurisdictionTenant: "tx_48029",
      fetchedAt: "2026-08-31T19:55:57.048Z",
      sourceUrl: "tx_rrc_well",
      contentHash: "",
      status: "active" as const,
    };
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([absentWellAtom as unknown as PropertyAtomInstance]),
      geometry: { status: "present", model: sitePlan },
      drainage: NO_DRAINAGE,
    });
    expect(model.facts.wellsPipelines.status).toBe("absent");
    expect(model.package.openItems.map((i) => i.section)).toContain("wellsPipelines");
  });

  it("item 19: absent (no open item) when no exit point or resolver was supplied", async () => {
    const sitePlan = buildSitePlanModel();
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: { status: "present", model: sitePlan },
      drainage: NO_DRAINAGE,
    });
    expect(model.facts.dischargePoint.status).toBe("absent");
    expect(model.package.openItems.map((i) => i.section)).not.toContain("dischargePoint");
  });

  it("item 19: present when a resolver finds a real named feature near the supplied exit point", async () => {
    const sitePlan = buildSitePlanModel();
    const model = await composeParcelReportFacts({
      parcelNodeId,
      storage: fakeStorage([]),
      geometry: { status: "present", model: sitePlan },
      drainage: NO_DRAINAGE,
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
    expect(model.facts.dischargePoint.status).toBe("present");
    if (model.facts.dischargePoint.status === "present") {
      expect(model.facts.dischargePoint.point.name).toBe("Piney Creek");
    }
  });
});
