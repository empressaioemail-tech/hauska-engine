import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";
import type { SetbackRuleAtomInstance } from "@hauska-engine/atoms";

import { authorParcelPropertyDossierExport, composeXrayBrief } from "../dossier-author.js";
import { present, absent } from "../feasibility-model.js";
import type { ParcelReportModel } from "../report-model.js";
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
  chatSummary: { summary: "Buildable under R-6.", savedAt: "2026-07-25T14:03:00Z" },
  notes: "Client prefers a single-story plan.",
};

describe("authorParcelPropertyDossierExport", { timeout: 60_000 }, () => {
  it("composes the site-plan model once via composeParcelReport, derives verdict/brief from it, appends renumbered sheets, and records the pdf-dossier artifact on the terrain atom", async () => {
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
    // P-120/P-221: the verdict is now ALWAYS derived (composeVerdict never
    // returns an empty string) — "no verdict" is no longer a reachable state
    // once the engine resolves it in-process.
    expect(result.verdictIncluded).toBe(true);
    // Derived brief facts (composeXrayBrief): County + Lot area from
    // jurisdiction/geometry — no flood/footprint/special-district/wells/
    // utilities atoms are seeded in this fixture, so those sections
    // contribute nothing (absent, not a placeholder).
    expect(result.briefFactCount).toBe(2);
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
    // P-228: running-header report type + report-chrome's own zero-padded
    // footer counter replace the old inline "SITE PLAN · SHEET N OF M".
    expect(decoded).toContain("SITE PLAN");
    expect(decoded).toContain(`SHEET ${String(result.dossierPageCount + 1).padStart(2, "0")} / ${result.pageCount}`);
    // No buildable-envelope atom is seeded in this fixture, so Ruling B
    // refuses the figure — the derived verdict must say so (never a
    // caller-supplied figure, since none is accepted anymore).
    expect(decoded).toContain("Buildable area is refused");
    expect(decoded).toContain("Bexar County");

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
    // Falsifier 1 (P-221 dispatch), proven at the engine-core level: with
    // geometry composition failing outright and no fact atoms/resolvers
    // seeded at all, composeXrayBrief derives NOTHING — the hollow-report
    // refusal this feeds (parcel-terrain.ts's dossier-export/download route)
    // remains reachable for a parcel whose inputs are genuinely absent, even
    // though verdict text itself is always present post-derivation.
    expect(result.briefFactCount).toBe(0);

    const artifact = result.atom.artifacts["pdf-dossier"];
    expect(artifact).toBeDefined();
    expect(artifact!.sitePlanAppended).toBe(false);
    expect(artifact!.sitePlanUnavailableReason).toContain("geometry");
    expect(artifact!.briefFactCount).toBe(0);

    // Honest degraded atom: zero coverage, explicitly labeled — never a
    // fabricated terrain claim.
    expect(result.atom.coverage.totalCells).toBe(0);
    expect(result.atom.sourceAdapter).toBe("dossier:no-terrain-resolved");

    const bytes = artifactStore.data.get(artifact!.ref);
    const decoded = decodeAllContentStreams(bytes!);
    expect(decoded).toContain("Site-plan sheets are not appended");
    expect(decoded).toContain("Buildable area could not be determined for this parcel");
  });
});

// P-119/P-221 Falsifier 2: diff X-ray against Feasibility for the SAME
// parcel and confirm no Studio-only section appears in X-ray. Rather than
// diff two rendered PDFs, this builds a `ParcelReportModel` where every
// Studio-exclusive family is genuinely PRESENT with a marker value, and
// asserts composeXrayBrief's derived output contains NONE of those markers
// — the tier gate must hold even when the underlying data exists and is
// resolved, since the leak risk is exactly "the data is there, so why not
// show it," never "the data happens to be absent."
describe("composeXrayBrief (Solo/Studio allow-list)", () => {
  // Cast at the call site rather than annotating this const: several
  // Studio-only fact families (floodplainAcreage/firmPanel/soil/
  // electricProvider/dischargePoint) are typed against shapes owned by
  // OTHER modules this test does not otherwise import, and this fixture only
  // needs to be structurally close enough for composeXrayBrief to read the
  // few fields it actually touches.
  const fullyResolvedModel = {
    parcelNodeId: "48029:105129",
    geometry: {
      status: "present",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: {
        summary: {
          countyName: "Bexar County",
          zoningDistrict: "R-6",
          lotAreaSqFt: 6000,
          address: "1127 N Pine St",
          floodZone: { honestUnavailable: true, reason: "test fixture" },
          zoningHonestAbsenceReason: undefined,
        },
        setback: { degenerate: false, honestAbsence: false },
        streets: { honestAbsence: true },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    },
    drainage: { status: "absent", reason: "not requested" },
    facts: {
      jurisdiction: {
        countyFips: "48029",
        countyName: "Bexar County",
        cityLimitsStatus: "incorporated",
        cityName: "San Antonio",
        etjStatus: "unresolved",
      },
      // STUDIO-ONLY: owner/valuation. Must never leak into X-ray (A-104/A-108/A-109).
      parcelOwnership: present({
        ownerName: "STUDIO-ONLY-OWNER-NAME",
        ownerMailingAddress: "STUDIO-ONLY-MAILING-ADDRESS",
        marketValue: 999999,
        assessedValue: 888888,
        landValue: 777777,
        improvementValue: 111111,
        legalDescription: "STUDIO-ONLY-LEGAL-DESCRIPTION",
      }),
      flood: present({ inSpecialFloodHazardArea: true, floodZone: "AE" }, { sourceCitation: "FEMA NFHL" }),
      specialDistricts: present({ districts: [{ districtName: "Lake Pointe MUD", districtType: "MUD" }] }),
      wellsPipelines: present({ wells: [{ wellStatus: "active" }], nearPipeline: true }),
      // STUDIO-ONLY (P-120's own named Feasibility exhibit): terrain.
      terrain: present({
        elevationRangeMeters: { min: 1, max: 2 },
        contourIntervalMeters: 1,
      }),
      utilities: present({ holders: [{ serviceKind: "water", territoryName: "STUDIO-OR-NOT-UTILITY-TERRITORY" }], residual: "r" }),
      hoa: { searchStatus: "not-searched" },
      footprint: present({ footprints: [{ footprintId: "fp-1" }] }),
      // STUDIO-ONLY (P-120's own named Feasibility exhibits):
      dischargePoint: present({ point: { name: "STUDIO-ONLY-DISCHARGE-POINT" } }),
      floodplainAcreage: present({ acreageInFloodplain: 1.2, sourceCitation: "STUDIO-ONLY-FIRM" }),
      firmPanel: present({ panels: [{ panelNumber: "STUDIO-ONLY-PANEL" }] }),
      soil: present({ soilType: "STUDIO-ONLY-SOIL-TYPE" }),
      electricProvider: present({ providerName: "STUDIO-ONLY-ELECTRIC-PROVIDER" }),
      gasProvider: absent("out-of-scope", "not requested"),
    },
    package: {
      verdict: "1,234 sq ft of buildable area under the facts on file. 0 open items to resolve.",
      narrativeSkeleton: "STUDIO-ONLY-NARRATIVE-SKELETON",
      openItems: [],
      dataQuality: { supersededNotes: [] },
    },
  };

  it("never leaks parcelOwnership, terrain, or any of P-120's Feasibility-only exhibits into the derived brief", () => {
    const { sections, verdictLine } = composeXrayBrief(fullyResolvedModel as unknown as ParcelReportModel);
    const serialized = JSON.stringify(sections);

    // The verdict is reused VERBATIM from the shared model (Falsifier 4: no
    // cross-document disagreement is possible when it is the same string).
    expect(verdictLine).toBe(fullyResolvedModel.package.verdict);

    for (const forbidden of [
      "STUDIO-ONLY-OWNER-NAME",
      "STUDIO-ONLY-MAILING-ADDRESS",
      "999999",
      "888888",
      "777777",
      "111111",
      "STUDIO-ONLY-LEGAL-DESCRIPTION",
      "STUDIO-ONLY-DISCHARGE-POINT",
      "STUDIO-ONLY-FIRM",
      "STUDIO-ONLY-PANEL",
      "STUDIO-ONLY-SOIL-TYPE",
      "STUDIO-ONLY-ELECTRIC-PROVIDER",
      "STUDIO-ONLY-NARRATIVE-SKELETON",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // terrain's own elevation-range fact never appears as a section either.
    expect(sections.some((s) => s.id === "terrain")).toBe(false);
    expect(sections.some((s) => s.id === "parcelOwnership")).toBe(false);
    // hoa never becomes a brief fact (every parcel carries the identical
    // constant — see composeXrayBrief's own doc for why).
    expect(sections.some((s) => s.id === "hoa")).toBe(false);

    // The Solo-safe facts this same model DOES carry are still present —
    // this is a tier gate, not a blanket refusal.
    expect(serialized).toContain("Bexar County");
    expect(serialized).toContain("San Antonio");
    expect(serialized).toContain("AE");
    expect(serialized).toContain("Lake Pointe MUD");
  });

  it("derives nothing when every allow-listed family is genuinely absent (hollow-report refusal stays reachable)", () => {
    const hollowModel = {
      ...fullyResolvedModel,
      geometry: { status: "absent" as const, reason: "test fixture: no geometry" },
      facts: {
        ...fullyResolvedModel.facts,
        jurisdiction: {
          countyFips: null,
          countyName: undefined,
          cityLimitsStatus: "unresolved" as const,
          etjStatus: "unresolved" as const,
        },
        flood: absent("blocked-at-source", "no mapping"),
        specialDistricts: absent("blocked-at-source", "not checked"),
        wellsPipelines: absent("blocked-at-source", "not checked"),
        utilities: absent("out-of-scope", "not requested"),
        footprint: absent("blocked-at-source", "not checked"),
      },
    };
    const { sections } = composeXrayBrief(hollowModel as unknown as ParcelReportModel);
    expect(sections).toEqual([]);
  });
});
