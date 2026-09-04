import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";
import type { CadParcelRollAtomInstance, SetbackRuleAtomInstance } from "@hauska-engine/atoms";

import { authorParcelFeasibilityExport } from "../feasibility-author.js";
import type { ParcelGeometryResolver, TerrainArtifactStore } from "../../parcel-terrain/author.js";
import { decodeAllContentStreams } from "../pdf/__tests__/decode-pdf-text.js";

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

const cadRoll: CadParcelRollAtomInstance = {
  entityType: "cad-parcel-roll",
  atomDid: "cad_1",
  entityId: `${parcelNodeId}:cad-roll:2025`,
  parcelNodeId,
  taxYear: 2025,
  countyFips: "48029",
  propId: "105129",
  keyKind: "prop_id",
  joinPassedOwnerMatchGate: true,
  reasoningChain: { reasoningKind: "observed" },
  sourceTier: "county-cad",
  legalDescription: "LOT 4 BLK 2 SAMPLE SUB",
  marketValue: 250000,
  accessPolicy: "public-free",
  sourceCitation: "Bexar CAD 2025 roll",
  extractedAt: new Date().toISOString(),
  verificationStatus: "machine",
  sourceAdapter: "cad-roll:bexar",
  evaluatedAt: new Date().toISOString(),
  atomTier: "data",
  jurisdictionTenant: "property-spine",
  fetchedAt: new Date().toISOString(),
  sourceUrl: "",
  contentHash: "",
  status: "active",
} as unknown as CadParcelRollAtomInstance;

function fakeResolver(ring: Array<[number, number]> | undefined | null): ParcelGeometryResolver {
  return {
    async resolve() {
      if (ring === null) return null;
      return { bbox, sourceRef: `txgio-parcel:${parcelNodeId}:stratmap25-landparcels_48029_2025`, ring };
    },
  };
}

function fakeArtifactStore(): TerrainArtifactStore & { get(ref: string): Promise<Uint8Array | null>; data: Map<string, Uint8Array> } {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    async put(input) {
      const key = `memory://${input.parcelNodeId}/${input.format}/${data.size}`;
      data.set(key, input.bytes);
      return key;
    },
    async get(ref: string) {
      return data.get(ref) ?? null;
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

describe("authorParcelFeasibilityExport", { timeout: 60_000 }, () => {
  it("composes the site-plan + feasibility models, reads real atoms, appends renumbered sheets, records the pdf-feasibility artifact", async () => {
    const storage = new InMemoryStorage();
    await storage.writePropertyAtom(cadRoll);
    const artifactStore = fakeArtifactStore();

    const result = await authorParcelFeasibilityExport({
      parcelNodeId,
      resolver: fakeResolver(ringWgs84),
      setback,
      storage,
      artifactStore,
      fetchAerialImage: stubAerialFetch,
      fetchDem: fakeFetchDem,
      parseDem: fakeParseDem,
      fetchFloodZone: async () => ({ honestUnavailable: true, reason: "test stub: no live FEMA NFHL call in this fixture" }),
      descriptor: { address: "1127 N PINE ST, SAN ANTONIO, TX 78202", countyName: "Bexar County" },
    });

    expect(result.sitePlanAppended).toBe(true);
    expect(result.pageCount).toBe(result.feasibilityPageCount + 1);
    expect(result.sectionCount).toBeGreaterThan(5);
    // parcelOwnership resolved from the seeded cad-parcel-roll atom, so it's
    // not one of the open items.
    expect(result.openItemCount).toBeLessThan(8);
    expect(result.narrativeIsDeterministicSkeleton).toBe(true);

    expect(result.atom.entityType).toBe("parcel-terrain-model");
    const artifact = result.atom.artifacts["pdf-feasibility"];
    expect(artifact).toBeDefined();
    expect(artifact?.byteCount).toBeGreaterThan(0);

    // Round-trip: the bytes are genuinely retrievable and decode with the
    // real fact from the seeded atom, not a placeholder.
    const bytes = await artifactStore.get(artifact!.ref);
    expect(bytes).not.toBeNull();
    const decoded = decodeAllContentStreams(bytes!);
    expect(decoded).toContain("LOT 4 BLK 2 SAMPLE SUB");
    expect(decoded).toContain("SMART SITE FEASIBILITY STUDY");
  });

  it("fails closed with an honest error when the site plan cannot be resolved, never emitting a fabricated report", async () => {
    const storage = new InMemoryStorage();
    const artifactStore = fakeArtifactStore();

    await expect(
      authorParcelFeasibilityExport({
        parcelNodeId,
        resolver: fakeResolver(null),
        setback,
        storage,
        artifactStore,
        fetchAerialImage: stubAerialFetch,
        fetchDem: fakeFetchDem,
        parseDem: fakeParseDem,
      }),
    ).rejects.toThrow(/site plan/i);

    // No artifact was persisted on the failed attempt.
    const atoms = await storage.listPropertyAtomsByParcelNodeId(parcelNodeId);
    expect(atoms.find((a) => a.entityType === "parcel-terrain-model")).toBeUndefined();
  });

  it("finds-or-creates the SAME parcel-terrain-model atom a prior dossier export already created, never a second entity", async () => {
    const storage = new InMemoryStorage();
    await storage.writePropertyAtom(cadRoll);
    const artifactStore = fakeArtifactStore();

    // Simulate a prior dossier export already having created the shared atom.
    const priorRef = await artifactStore.put({ parcelNodeId, format: "pdf-dossier", bytes: new Uint8Array([1, 2, 3]), contentType: "application/pdf" });
    await storage.writePropertyAtom({
      entityType: "parcel-terrain-model",
      atomDid: "pterrain_existing",
      entityId: parcelNodeId,
      parcelNodeId,
      jurisdictionTenant: "property-spine",
      fetchedAt: new Date().toISOString(),
      extractedAt: new Date().toISOString(),
      sourceAdapter: "dossier:no-terrain-resolved",
      sourceUrl: "",
      sourceCitation: "no terrain data resolved for this export",
      accessPolicy: "public-paid",
      atomTier: "data",
      status: "active",
      contentHash: "",
      reasoningChain: {
        reasoningKind: "derived",
        derivationMethod: "parcel-terrain-mesh-ifc-v1",
        inputAtomRefs: [{ atomDid: "dossier:no-terrain-resolved", role: "reference-field", citationLabel: "usgs-3dep-dem" }],
      },
      artifacts: { "pdf-dossier": { format: "pdf-dossier", ref: priorRef, byteCount: 3 } },
      coverage: { coverageFraction: 0, nodataCount: 0, totalCells: 0, resolutionMetersRequested: null, resolutionMetersActual: null, touchesNodata: false },
      confidence: { value: 0.3, kind: "asserted", provenance: "test fixture", n: 0, intervalWidth: 1 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await authorParcelFeasibilityExport({
      parcelNodeId,
      resolver: fakeResolver(ringWgs84),
      setback,
      storage,
      artifactStore,
      fetchAerialImage: stubAerialFetch,
      fetchDem: fakeFetchDem,
      parseDem: fakeParseDem,
      descriptor: { address: "1127 N PINE ST, SAN ANTONIO, TX 78202", countyName: "Bexar County" },
    });

    expect(result.atom.atomDid).toBe("pterrain_existing");
    // Both artifacts now coexist on the ONE atom.
    expect(result.atom.artifacts["pdf-dossier"]).toBeDefined();
    expect(result.atom.artifacts["pdf-feasibility"]).toBeDefined();

    const allAtoms = await storage.listPropertyAtomsByParcelNodeId(parcelNodeId);
    expect(allAtoms.filter((a) => a.entityType === "parcel-terrain-model").length).toBe(1);
  });
});
