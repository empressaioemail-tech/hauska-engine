import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";

import { authorParcelFloodDrainageReport } from "../flood-drainage-author.js";
import { HONEST_EMPTY_FLAT_TERRAIN, type FloodDrainageStudy } from "../flood-drainage-study.js";
import type { ParcelGeometryResolver, TerrainArtifactStore } from "../../parcel-terrain/author.js";
import { decodeAllContentStreams } from "../pdf/__tests__/decode-pdf-text.js";

const parcelNodeId = "48021:47595";
const parcelBbox = { westLng: -97.32, southLat: 30.1, eastLng: -97.318, northLat: 30.102 };
const ringWgs84: Array<[number, number]> = [
  [-97.3196, 30.1004],
  [-97.3184, 30.1004],
  [-97.3184, 30.1016],
  [-97.3196, 30.1016],
  [-97.3196, 30.1004],
];

const resolver: ParcelGeometryResolver = {
  async resolve() {
    return { bbox: parcelBbox, sourceRef: "txgio-parcel:48021:47595:stratmap25", ring: ringWgs84 };
  },
};

const GRID = 24;

function slopedDem() {
  const values = new Float32Array(GRID * GRID);
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      values[row * GRID + col] = 200 - col * 0.8 + row * 0.05;
    }
  }
  return {
    width: GRID,
    height: GRID,
    values,
    minElevation: 200 - (GRID - 1) * 0.8,
    maxElevation: 200 + (GRID - 1) * 0.05,
    nodataCount: 0,
  };
}

function flatDem() {
  const values = new Float32Array(GRID * GRID).fill(150);
  return { width: GRID, height: GRID, values, minElevation: 150, maxElevation: 150, nodataCount: 0 };
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
  bytes: new Uint8Array(8),
  contentType: "image/tiff",
  bbox: bboxArg,
  resolutionMeters: opts.resolutionMeters,
  resolutionMetersRequested: opts.resolutionMeters,
  resolutionMetersActual: null,
  widthPx: GRID,
  heightPx: GRID,
  endpoint: "https://fake.usgs.example/exportImage",
  fetchedAt: new Date().toISOString(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
})) as any;

const failingRainfall = (async () => {
  throw new Error("test stub: no NOAA egress");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

describe("authorParcelFloodDrainageReport", { timeout: 60_000 }, () => {
  it("runs the study once, records pdf-flood-drainage + json-flood-drainage-study on the terrain atom", async () => {
    const storage = new InMemoryStorage();
    const artifactStore = fakeArtifactStore();

    // Real native D8 over the sloped synthetic DEM (worker prefers native
    // under vitest) — the study output is genuinely computed, not mocked.
    const result = await authorParcelFloodDrainageReport({
      parcelNodeId,
      resolver,
      storage,
      artifactStore,
      fetchDem: fakeFetchDem,
      parseDem: async () => slopedDem(),
      fetchRainfall: failingRainfall,
      rainfallDepthInches: 8,
      descriptor: { address: "141 Old Antioch Rd, Smithville, TX", countyName: "Bastrop County" },
      generatedAtIso: "2026-07-29T12:00:00.000Z",
    });

    expect(result.honestEmpty).toBe(false);
    expect(result.pageCount).toBe(2);
    expect(result.study.rainfallSource).toBe("parameter");
    expect(result.study.computation.library).toBe("native-d8");

    const pdfArtifact = result.atom.artifacts["pdf-flood-drainage"];
    expect(pdfArtifact).toBeDefined();
    expect(pdfArtifact!.format).toBe("pdf-flood-drainage");
    expect(pdfArtifact!.pageCount).toBe(2);
    expect(pdfArtifact!.rainfallDepthInches).toBe(8);
    expect(pdfArtifact!.rainfallSource).toBe("parameter");
    expect(pdfArtifact!.computationLibrary).toBe("native-d8");
    expect(pdfArtifact!.honestEmpty).toBeUndefined();

    const jsonArtifact = result.atom.artifacts["json-flood-drainage-study"];
    expect(jsonArtifact).toBeDefined();
    const jsonBytes = artifactStore.data.get(jsonArtifact!.ref);
    expect(jsonBytes).toBeDefined();
    const cached = JSON.parse(new TextDecoder().decode(jsonBytes!)) as FloodDrainageStudy;
    // The cached study IS the study returned — same run, one computation.
    expect(cached.parcelNodeId).toBe(parcelNodeId);
    expect(cached.rainfallDepthInches).toBe(8);
    expect(cached.briefing).toBe(result.study.briefing);
    expect(cached.catchmentGeoJson.features.length).toBe(
      result.study.catchmentGeoJson.features.length,
    );

    // PDF bytes persisted and decodable.
    const pdfBytes = artifactStore.data.get(pdfArtifact!.ref);
    expect(pdfBytes).toBeDefined();
    const decoded = decodeAllContentStreams(pdfBytes!);
    expect(decoded).toContain("FLOOD & DRAINAGE · SHEET 1 OF 2");
    expect(decoded).toContain("141 OLD ANTIOCH RD");

    // Atom persisted with real DEM coverage.
    const atoms = await storage.listPropertyAtomsByParcelNodeId(parcelNodeId);
    const terrain = atoms.find((a) => a.entityType === "parcel-terrain-model");
    expect(terrain).toBeDefined();
    expect(result.atom.coverage.totalCells).toBe(GRID * GRID);
  });

  it("honest-empty (flat terrain) still authors BOTH artifacts with the honest flags — never a fake study", async () => {
    const storage = new InMemoryStorage();
    const artifactStore = fakeArtifactStore();

    const result = await authorParcelFloodDrainageReport({
      parcelNodeId,
      resolver,
      storage,
      artifactStore,
      fetchDem: fakeFetchDem,
      parseDem: async () => flatDem(),
      fetchRainfall: failingRainfall,
      rainfallDepthInches: 8,
    });

    expect(result.honestEmpty).toBe(true);
    expect(result.honestEmptyReason).toBe(HONEST_EMPTY_FLAT_TERRAIN);
    expect(result.pageCount).toBe(2);

    const pdfArtifact = result.atom.artifacts["pdf-flood-drainage"];
    expect(pdfArtifact!.honestEmpty).toBe(true);
    expect(pdfArtifact!.honestEmptyReason).toBe(HONEST_EMPTY_FLAT_TERRAIN);
    const jsonArtifact = result.atom.artifacts["json-flood-drainage-study"];
    expect(jsonArtifact!.honestEmpty).toBe(true);

    const cached = JSON.parse(
      new TextDecoder().decode(artifactStore.data.get(jsonArtifact!.ref)!),
    ) as FloodDrainageStudy;
    expect(cached.honestEmpty?.reason).toBe(HONEST_EMPTY_FLAT_TERRAIN);
    expect(cached.catchmentGeoJson.features.length).toBe(0);
  });

  it("merges artifacts into an EXISTING parcel-terrain-model atom instead of forking a second record", async () => {
    const storage = new InMemoryStorage();
    const artifactStore = fakeArtifactStore();
    const existingDid = "pterrain_existing_123";
    await storage.writePropertyAtom({
      entityType: "parcel-terrain-model",
      atomDid: existingDid,
      entityId: parcelNodeId,
      parcelNodeId,
      jurisdictionTenant: "property-spine",
      fetchedAt: new Date().toISOString(),
      extractedAt: new Date().toISOString(),
      sourceAdapter: "usgs:3dep-dem",
      sourceUrl: "https://example.test",
      sourceCitation: "USGS 3DEP",
      accessPolicy: "public-paid",
      atomTier: "data",
      status: "active",
      contentHash: "",
      reasoningChain: {
        reasoningKind: "derived",
        derivationMethod: "parcel-terrain-mesh-ifc-v1",
        inputAtomRefs: [{ atomDid: "x", role: "reference-field", citationLabel: "usgs-3dep-dem" }],
      },
      artifacts: {},
      coverage: {
        coverageFraction: 1,
        nodataCount: 0,
        totalCells: 16,
        resolutionMetersRequested: 1,
        resolutionMetersActual: null,
        touchesNodata: false,
      },
      confidence: { value: 0.6, kind: "asserted", provenance: "test", n: 0, intervalWidth: 1 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await authorParcelFloodDrainageReport({
      parcelNodeId,
      resolver,
      storage,
      artifactStore,
      fetchDem: fakeFetchDem,
      parseDem: async () => slopedDem(),
      fetchRainfall: failingRainfall,
      rainfallDepthInches: 8,
    });
    expect(result.atom.atomDid).toBe(existingDid);
    expect(result.atom.artifacts["pdf-flood-drainage"]).toBeDefined();
  });
});
