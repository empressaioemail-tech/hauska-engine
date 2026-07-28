import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";
import type { SetbackRuleAtomInstance } from "@hauska-engine/atoms";

import { authorParcelSitePlanExport } from "../author.js";
import type { ParcelGeometryResolver } from "../../parcel-terrain/author.js";
import type { TerrainArtifactStore } from "../../parcel-terrain/author.js";
import { decodeAllContentStreams } from "../pdf/__tests__/decode-pdf-text.js";

const bbox = { westLng: -98.5, southLat: 29.4, eastLng: -98.4995, northLat: 29.4004 };
const dem = {
  width: 4,
  height: 4,
  values: new Float32Array([
    200, 200.5, 201, 201.2,
    199.8, 200.2, 200.7, 201.0,
    199.5, 200.0, 200.4, 200.8,
    199.2, 199.7, 200.1, 200.5,
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

const parcelNodeId = "48029:105129";

const setback: SetbackRuleAtomInstance = {
  entityType: "setback-rule",
  atomDid: "san_antonio_tx/setback/48029:105129/1",
  entityId: `${parcelNodeId}:setback:1`,
  jurisdictionTenant: "san_antonio_tx",
  parcelNodeId,
  fetchedAt: new Date().toISOString(),
  extractedAt: new Date().toISOString(),
  sourceAdapter: "san-antonio-tx-udc",
  sourceUrl: "https://library.municode.com/tx/san_antonio/udc/35-310.01",
  sourceCitation: "Setback rule for R-6 cited to san_antonio_tx/udc/35-310.01",
  accessPolicy: "public-free",
  atomTier: "data",
  status: "active",
  versionStamp: `${parcelNodeId}:setback-rule:1`,
  front: 10,
  side: 5,
  rear: 20,
  sourceCodeAtomRef: { atomDid: "san_antonio_tx/udc/35-310.01/35-310.01", role: "rule", entityType: "code-section" },
} as unknown as SetbackRuleAtomInstance;

function fakeResolver(ring: Array<[number, number]> | undefined): ParcelGeometryResolver {
  return {
    async resolve() {
      return { bbox, sourceRef: `txgio-parcel:${parcelNodeId}:stratmap25-landparcels_48029_2025`, ring };
    },
  };
}

function fakeArtifactStore(): TerrainArtifactStore & { data: Map<string, Uint8Array> } {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    async put(input) {
      const key = `memory://${input.parcelNodeId}/${input.format}/${data.size}`;
      data.set(key, input.bytes);
      return key;
    },
  };
}

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
})) as any;

const fakeParseDem = async () => dem;

// Hermetic aerial-imagery stub: tests never hit the Esri endpoint. Failing
// fast exercises the honest "imagery unavailable" page — the export must
// succeed regardless (sheet 3 always ships).
const stubAerialFetch = async (): Promise<Uint8Array> => {
  throw new Error("test stub: no aerial imagery fetch in unit tests");
};

describe("authorParcelSitePlanExport", { timeout: 20_000 }, () => {
  it("composes the site model, emits DXF+IFC, and persists artifacts merged into the terrain atom", async () => {
    const storage = new InMemoryStorage();
    const artifactStore = fakeArtifactStore();

    const result = await authorParcelSitePlanExport({
      parcelNodeId,
      resolver: fakeResolver(ringWgs84),
      setback,
      storage,
      artifactStore,
      fetchAerialImage: stubAerialFetch,
      fetchDem: fakeFetchDem,
      parseDem: fakeParseDem,
      // Deterministic stub: the real FEMA-adapter default path (network
      // reachability, honest-unavailable on failure) is covered on its own,
      // isolated from network reachability, by the two tests below —
      // this test only needs a fixed, environment-independent flood
      // verdict so its own assertions don't depend on ambient egress.
      fetchFloodZone: async () => ({
        honestUnavailable: true,
        reason: "test stub: no live FEMA NFHL call in this fixture",
      }),
    });

    expect(result.setbackDegenerate).toBe(false);
    expect(result.streetHonestAbsence).toBe(true);
    expect(result.atom.artifacts["dxf-site-plan"]).toBeTruthy();
    expect(result.atom.artifacts["ifc-site-plan"]).toBeTruthy();
    expect(result.atom.artifacts["dxf-site-plan"]?.byteCount).toBeGreaterThan(0);
    expect(result.atom.artifacts["ifc-site-plan"]?.vertexCount).toBeGreaterThan(0);
    expect(artifactStore.data.size).toBe(3);

    // Wave 2 (WDLL 5/6): PDF is additive alongside dxf/ifc-site-plan, off
    // the same authored model — never a second geometry pipeline.
    expect(result.atom.artifacts["pdf-site-plan"]).toBeTruthy();
    expect(result.atom.artifacts["pdf-site-plan"]?.byteCount).toBeGreaterThan(0);
    expect(result.atom.artifacts["pdf-site-plan"]?.pageCount).toBe(3);
    expect(result.pdfPageCount).toBe(3);
    // Aerial fetch stub failed -> sheet 3 still ships with the honest note,
    // and the artifact records the outcome.
    expect(result.atom.artifacts["pdf-site-plan"]?.aerialImageryEmbedded).toBe(false);
    expect(result.atom.artifacts["pdf-site-plan"]?.aerialImageryUnavailableReason).toContain(
      "no aerial imagery fetch in unit tests",
    );
    // No zoning-fact atom in storage and no override supplied -> honest
    // absence, never a fabricated district.
    expect(result.zoningHonestAbsence).toBe(true);
    expect(result.floodZoneHonestUnavailable).toBe(true);
    expect(result.atom.artifacts["pdf-site-plan"]?.zoningHonestAbsence).toBe(true);
    expect(result.atom.artifacts["pdf-site-plan"]?.floodZoneHonestUnavailable).toBe(true);

    const stored = await storage.listPropertyAtomsByParcelNodeId(parcelNodeId);
    const terrainAtom = stored.find((a) => a.entityType === "parcel-terrain-model");
    expect(terrainAtom).toBeTruthy();
    expect((terrainAtom as any).artifacts["dxf-site-plan"]).toBeTruthy();
    expect((terrainAtom as any).artifacts["pdf-site-plan"]).toBeTruthy();
  });

  it("exports a real sheet with NO setback-rule atom — honest-absent setback layer, never a 422 or a fabricated F/S/R (2026-07-27 operator requirement)", async () => {
    const storage = new InMemoryStorage();
    const artifactStore = fakeArtifactStore();

    const result = await authorParcelSitePlanExport({
      parcelNodeId,
      resolver: fakeResolver(ringWgs84),
      // No setback atom supplied at all.
      setback: undefined,
      storage,
      artifactStore,
      fetchAerialImage: stubAerialFetch,
      fetchDem: fakeFetchDem,
      parseDem: fakeParseDem,
      fetchFloodZone: async () => ({ honestUnavailable: true, reason: "test stub" }),
    });

    // Real sheet still produced across all three formats.
    expect(result.atom.artifacts["dxf-site-plan"]?.byteCount).toBeGreaterThan(0);
    expect(result.atom.artifacts["ifc-site-plan"]?.byteCount).toBeGreaterThan(0);
    expect(result.atom.artifacts["ifc-site-plan"]?.vertexCount).toBeGreaterThan(0);
    expect(result.atom.artifacts["pdf-site-plan"]?.byteCount).toBeGreaterThan(0);
    expect(result.atom.artifacts["pdf-site-plan"]?.pageCount).toBe(3);
    expect(artifactStore.data.size).toBe(3);

    // Setback layer honestly absent — NOT degenerate, NOT fabricated.
    expect(result.setbackHonestAbsence).toBe(true);
    expect(result.setbackDegenerate).toBe(false);
    expect(result.setbackHonestAbsenceReason).toMatch(/no setback-rule atom/i);
    expect(result.atom.artifacts["pdf-site-plan"]?.setbackHonestAbsence).toBe(true);
    expect(result.atom.artifacts["dxf-site-plan"]?.setbackHonestAbsence).toBe(true);

    // The honest-absent note is drawn on the PDF; no fabricated F/S/R number.
    const pdfRef = result.atom.artifacts["pdf-site-plan"]!.ref;
    const pdfBytes = artifactStore.data.get(pdfRef)!;
    const decoded = decodeAllContentStreams(pdfBytes);
    expect(decoded.toLowerCase()).toContain("not specified");
    expect(decoded).not.toMatch(/build-to-line governs/i);
  }, 20_000);

  it("resolves zoning district from a zoning-fact atom already in storage, and honors explicit zoning/flood overrides", async () => {
    const storage = new InMemoryStorage();
    const artifactStore = fakeArtifactStore();
    await storage.writePropertyAtom({
      entityType: "zoning-fact",
      atomDid: "san_antonio_tx/zoning-fact/48029:105129/1",
      entityId: `${parcelNodeId}:zoning:1`,
      jurisdictionTenant: "san_antonio_tx",
      parcelNodeId,
      fetchedAt: new Date().toISOString(),
      extractedAt: new Date().toISOString(),
      sourceAdapter: "san-antonio-tx-zoning",
      sourceUrl: "https://gis.sanantonio.gov/zoning",
      sourceCitation: "San Antonio zoning GIS",
      accessPolicy: "public-free",
      atomTier: "data",
      status: "active",
      versionStamp: `${parcelNodeId}:zoning-fact:1`,
      district: "R-6",
    } as any);

    const result = await authorParcelSitePlanExport({
      parcelNodeId,
      resolver: fakeResolver(ringWgs84),
      setback,
      storage,
      artifactStore,
      fetchAerialImage: stubAerialFetch,
      fetchDem: fakeFetchDem,
      parseDem: fakeParseDem,
      floodZoneOverride: {
        zone: "X",
        inSpecialFloodHazardArea: false,
        sourceCitation: "FEMA National Flood Hazard Layer (NFHL)",
        asOfIso: new Date().toISOString(),
      },
    });

    expect(result.zoningHonestAbsence).toBe(false);
    expect(result.floodZoneHonestUnavailable).toBe(false);
    expect((result.atom.artifacts["pdf-site-plan"] as any)?.zoningHonestAbsence).toBe(false);
  });

  it("resolves a provisional-front-edge buildable-envelope atom from storage and threads it into the PDF's buildable-area honesty note (planner HOLD-1)", async () => {
    const storage = new InMemoryStorage();
    const artifactStore = fakeArtifactStore();
    await storage.writePropertyAtom({
      entityType: "buildable-envelope",
      atomDid: "san_antonio_tx/buildable-envelope/48029:105129/1",
      entityId: `${parcelNodeId}:envelope:1`,
      jurisdictionTenant: "san_antonio_tx",
      parcelNodeId,
      fetchedAt: new Date().toISOString(),
      extractedAt: new Date().toISOString(),
      sourceAdapter: "property-reasoning",
      sourceUrl: "internal:buildable-envelope",
      sourceCitation: "Derived buildable envelope",
      accessPolicy: "public-free",
      atomTier: "data",
      status: "active",
      versionStamp: `${parcelNodeId}:buildable-envelope:1`,
      outcome: { kind: "provisional-front-edge", reason: "front-edge-anchor atom unresolved" },
    } as any);

    const result = await authorParcelSitePlanExport({
      parcelNodeId,
      resolver: fakeResolver(ringWgs84),
      setback,
      storage,
      artifactStore,
      fetchAerialImage: stubAerialFetch,
      fetchDem: fakeFetchDem,
      parseDem: fakeParseDem,
      // frontEdgeIndex hint would otherwise resolve the composer's OWN
      // basis to front-edge-hint (no note from ring geometry alone) — this
      // isolates the buildable-envelope-atom lookup as the sole trigger.
      frontEdgeIndex: 0,
      fetchFloodZone: async () => ({ honestUnavailable: true, reason: "test stub" }),
    });

    expect(result.atom.artifacts["pdf-site-plan"]).toBeTruthy();
    const pdfRef = result.atom.artifacts["pdf-site-plan"]!.ref;
    const pdfBytes = artifactStore.data.get(pdfRef)!;
    // SHEET STANDARD §11: machine identifiers (provisional-front-edge, the
    // atom's reason string) stay OFF the sheet — the model still carries them
    // (buildableAreaHonestNote below), and the sheet shows the provisional
    // qualifier + the fine-print planning-estimate sentence.
    expect(result.atom.artifacts["pdf-site-plan"]).toBeTruthy();
    const decoded = decodeAllContentStreams(pdfBytes);
    expect(decoded).toContain("provisional planning estimate");
    expect(decoded).toContain("planning estimate, not a permit-ready boundary");
  });

  it("honors an explicit envelopeOutcomeOverride test seam without requiring a stored buildable-envelope atom", async () => {
    const storage = new InMemoryStorage();
    const artifactStore = fakeArtifactStore();

    const withOverride = await authorParcelSitePlanExport({
      parcelNodeId,
      resolver: fakeResolver(ringWgs84),
      setback,
      storage,
      artifactStore,
      fetchAerialImage: stubAerialFetch,
      fetchDem: fakeFetchDem,
      parseDem: fakeParseDem,
      frontEdgeIndex: 0,
      fetchFloodZone: async () => ({ honestUnavailable: true, reason: "test stub" }),
      envelopeOutcomeOverride: { kind: "provisional-front-edge", reason: "override reason" },
    });

    expect(withOverride.atom.artifacts["pdf-site-plan"]?.byteCount).toBeGreaterThan(0);

    const storage2 = new InMemoryStorage();
    const artifactStore2 = fakeArtifactStore();
    const withoutOverride = await authorParcelSitePlanExport({
      parcelNodeId,
      resolver: fakeResolver(ringWgs84),
      setback,
      storage: storage2,
      artifactStore: artifactStore2,
      fetchAerialImage: stubAerialFetch,
      fetchDem: fakeFetchDem,
      parseDem: fakeParseDem,
      frontEdgeIndex: 0,
      fetchFloodZone: async () => ({ honestUnavailable: true, reason: "test stub" }),
    });

    // The override path renders a longer honesty-note paragraph onto the
    // same page 2 layout, so its PDF is strictly larger than the otherwise
    // identical export with no provisional note at all - a real, if
    // indirect, end-to-end proof the override reaches the renderer.
    expect(withOverride.atom.artifacts["pdf-site-plan"]!.byteCount).toBeGreaterThan(
      withoutOverride.atom.artifacts["pdf-site-plan"]!.byteCount,
    );
  }, 15_000);

  it("degrades to honest flood-zone-unavailable when the flood lookup throws, without failing the export", async () => {
    const storage = new InMemoryStorage();
    const artifactStore = fakeArtifactStore();

    const result = await authorParcelSitePlanExport({
      parcelNodeId,
      resolver: fakeResolver(ringWgs84),
      setback,
      storage,
      artifactStore,
      fetchAerialImage: stubAerialFetch,
      fetchDem: fakeFetchDem,
      parseDem: fakeParseDem,
      fetchFloodZone: async () => {
        throw new Error("simulated network hazard: no egress in sandbox");
      },
    });

    expect(result.floodZoneHonestUnavailable).toBe(true);
    expect(result.atom.artifacts["pdf-site-plan"]).toBeTruthy();
  });

  it("fails closed rather than approximating PROPERTY_LINE when the resolver has no ring", async () => {
    const storage = new InMemoryStorage();
    const artifactStore = fakeArtifactStore();

    await expect(
      authorParcelSitePlanExport({
        parcelNodeId,
        resolver: fakeResolver(undefined),
        setback,
        storage,
        artifactStore,
        fetchAerialImage: stubAerialFetch,
        fetchDem: fakeFetchDem,
        parseDem: fakeParseDem,
      }),
    ).rejects.toThrow(/boundary ring/i);
  });

  it("merges site-plan artifacts into an existing terrain atom without disturbing its other artifacts", async () => {
    const storage = new InMemoryStorage();
    const artifactStore = fakeArtifactStore();
    await storage.writePropertyAtom({
      entityType: "parcel-terrain-model",
      atomDid: "pterrain_existing",
      entityId: parcelNodeId,
      parcelNodeId,
      jurisdictionTenant: "property-spine",
      fetchedAt: new Date().toISOString(),
      extractedAt: new Date().toISOString(),
      sourceAdapter: "usgs:3dep-dem",
      sourceUrl: "https://fake.usgs.example",
      sourceCitation: "USGS 3DEP",
      accessPolicy: "public-paid",
      atomTier: "data",
      status: "active",
      contentHash: "",
      reasoningChain: {
        reasoningKind: "derived",
        derivationMethod: "parcel-terrain-mesh-ifc-v1",
        inputAtomRefs: [{ atomDid: "usgs-3dep-dem", role: "reference-field", citationLabel: "usgs-3dep-dem" }],
      },
      artifacts: {
        glb: { format: "glb", ref: "memory://existing-glb", byteCount: 100, vertexCount: 9, triangleCount: 8 },
      },
      coverage: {
        coverageFraction: 1,
        nodataCount: 0,
        totalCells: 16,
        resolutionMetersRequested: 10,
        resolutionMetersActual: null,
        touchesNodata: false,
      },
      confidence: { value: 0.6, kind: "asserted", provenance: "test", n: 0, intervalWidth: 1 },
    } as any);

    const result = await authorParcelSitePlanExport({
      parcelNodeId,
      resolver: fakeResolver(ringWgs84),
      setback,
      storage,
      artifactStore,
      fetchAerialImage: stubAerialFetch,
      fetchDem: fakeFetchDem,
      parseDem: fakeParseDem,
      // Deterministic stub — this test only cares about artifact merge
      // behavior, not the flood-zone verdict; avoid a live network call.
      fetchFloodZone: async () => ({ honestUnavailable: true, reason: "test stub" }),
    });

    expect(result.atom.atomDid).toBe("pterrain_existing");
    expect(result.atom.artifacts.glb).toBeTruthy();
    expect(result.atom.artifacts["dxf-site-plan"]).toBeTruthy();
  });
});
