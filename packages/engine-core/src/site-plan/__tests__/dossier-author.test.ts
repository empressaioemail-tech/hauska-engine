import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";
import type { SetbackRuleAtomInstance } from "@hauska-engine/atoms";

import { authorParcelPropertyDossierExport } from "../dossier-author.js";
import type { ParcelGeometryResolver, TerrainArtifactStore } from "../../parcel-terrain/author.js";
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

function fakeResolver(ring: Array<[number, number]> | undefined | null): ParcelGeometryResolver {
  return {
    async resolve() {
      if (ring === null) return null;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
})) as any;

const fakeParseDem = async () => dem;

const stubAerialFetch = async (): Promise<Uint8Array> => {
  throw new Error("test stub: no aerial imagery fetch in unit tests");
};

const content = {
  address: "1127 N PINE ST, SAN ANTONIO, TX 78202",
  countyName: "Bexar County",
  verdictLine: "BUILDABLE — 4,860 SF envelope under R-6 setbacks",
  brief: {
    sections: [
      {
        id: "zoning",
        title: "Zoning & buildability",
        facts: [{ label: "Zoning district", value: "R-6", source: "san_antonio_tx/udc", vintage: "2025" }],
      },
    ],
  },
  chatSummary: { summary: "Buildable under R-6.", savedAt: "2026-07-25T14:03:00Z" },
  notes: "Client prefers a single-story plan.",
};

describe("authorParcelPropertyDossierExport", { timeout: 60_000 }, () => {
  it("composes the site-plan model once, appends renumbered sheets, and records the pdf-dossier artifact on the terrain atom", async () => {
    const storage = new InMemoryStorage();
    const artifactStore = fakeArtifactStore();

    const result = await authorParcelPropertyDossierExport({
      parcelNodeId,
      content,
      resolver: fakeResolver(ringWgs84),
      setback,
      storage,
      artifactStore,
      fetchAerialImage: stubAerialFetch,
      fetchDem: fakeFetchDem,
      parseDem: fakeParseDem,
      fetchFloodZone: async () => ({
        honestUnavailable: true,
        reason: "test stub: no live FEMA NFHL call in this fixture",
      }),
    });

    expect(result.sitePlanAppended).toBe(true);
    // P-90 item 3: the dossier appends exactly ONE site-plan sheet (the
    // drawing), not the standalone export's full 3+ sheet set.
    expect(result.pageCount).toBe(result.dossierPageCount + 1);
    expect(result.verdictIncluded).toBe(true);
    expect(result.briefFactCount).toBe(1);
    expect(result.chatSummaryIncluded).toBe(true);
    expect(result.notesIncluded).toBe(true);
    expect(result.setbackHonestAbsence).toBe(false);

    // Artifact recorded like pdf-site-plan: on the parcel-terrain-model atom,
    // with pageCount + honest flags.
    const artifact = result.atom.artifacts["pdf-dossier"];
    expect(artifact).toBeDefined();
    expect(artifact!.pageCount).toBe(result.pageCount);
    expect(artifact!.dossierPageCount).toBe(result.dossierPageCount);
    expect(artifact!.sitePlanAppended).toBe(true);
    expect(artifact!.verdictIncluded).toBe(true);

    // Bytes persisted and decodable; renumbered site-plan sheets inside.
    const bytes = artifactStore.data.get(artifact!.ref);
    expect(bytes).toBeDefined();
    const decoded = decodeAllContentStreams(bytes!);
    expect(decoded).toContain(`SITE PLAN · SHEET ${result.dossierPageCount + 1} OF ${result.pageCount}`);
    expect(decoded).toContain("4,860 SF envelope under R-6 setbacks");

    // Atom persisted.
    const atoms = await storage.listPropertyAtomsByParcelNodeId(parcelNodeId);
    expect(atoms.some((a) => a.entityType === "parcel-terrain-model")).toBe(true);
  });

  it("NEVER fails the export when site-plan authoring is unavailable — dossier pages still emit with the honest note", async () => {
    const storage = new InMemoryStorage();
    const artifactStore = fakeArtifactStore();

    const result = await authorParcelPropertyDossierExport({
      parcelNodeId,
      content,
      // Resolver cannot resolve this parcel: the site-plan leg throws inside
      // composition; the dossier must still ship.
      resolver: fakeResolver(null),
      storage,
      artifactStore,
      fetchAerialImage: stubAerialFetch,
      fetchDem: fakeFetchDem,
      parseDem: fakeParseDem,
    });

    expect(result.sitePlanAppended).toBe(false);
    expect(result.sitePlanUnavailableReason).toContain("geometry");
    expect(result.pageCount).toBe(result.dossierPageCount);

    const artifact = result.atom.artifacts["pdf-dossier"];
    expect(artifact).toBeDefined();
    expect(artifact!.sitePlanAppended).toBe(false);
    expect(artifact!.sitePlanUnavailableReason).toContain("geometry");

    // Honest degraded atom: zero coverage, explicitly labeled — never a
    // fabricated terrain claim.
    expect(result.atom.coverage.totalCells).toBe(0);
    expect(result.atom.sourceAdapter).toBe("dossier:no-terrain-resolved");

    const bytes = artifactStore.data.get(artifact!.ref);
    const decoded = decodeAllContentStreams(bytes!);
    expect(decoded).toContain("Site-plan sheets are not appended");
    expect(decoded).toContain("4,860 SF envelope under R-6 setbacks");
  });
});
