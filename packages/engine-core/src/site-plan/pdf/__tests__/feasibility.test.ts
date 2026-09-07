import { describe, expect, it } from "vitest";
import type { PropertyAtomInstance } from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import { composeParcelReportFacts } from "../../report-model.js";
import type { ParcelReportModel } from "../../report-model.js";
import { composeSitePlanModel } from "../../site-model.js";
import { boundaryEdgesForRing } from "../../__tests__/boundary-edge-fixture.js";
import { emitPdfFeasibility } from "../feasibility.js";
import { decodeAllContentStreams } from "./decode-pdf-text.js";

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
  return { listPropertyAtomsByParcelNodeId: async () => atoms } as unknown as StoragePort;
}

const NO_DRAINAGE = { status: "absent" as const, reason: "test fixture: drainage not composed" };

async function buildModel(
  atoms: PropertyAtomInstance[],
  extra: Partial<Parameters<typeof composeParcelReportFacts>[0]> = {},
): Promise<ParcelReportModel> {
  const sitePlan = buildSitePlanModel();
  return composeParcelReportFacts({
    parcelNodeId: "48029:105129",
    storage: fakeStorage(atoms),
    geometry: { status: "present", model: sitePlan },
    drainage: NO_DRAINAGE,
    ...extra,
  });
}

describe("emitPdfFeasibility", () => {
  it("emits a complete document with no atoms on file — honest chips throughout, never fabrication", async () => {
    const model = await buildModel([]);
    const result = await emitPdfFeasibility(model);

    expect(result.pageCount).toBeGreaterThan(0);
    expect(result.narrativeIsDeterministicSkeleton).toBe(true);
    expect(result.sitePlanAppended).toBe(false);

    const decoded = decodeAllContentStreams(result.bytes);
    expect(decoded).toContain("SMART SITE FEASIBILITY STUDY");
    expect(decoded).toContain("1127 N PINE ST");
    expect(decoded).toContain("UNAVAILABLE");
    // Never a fabricated flood zone when the fact atom is absent.
    expect(decoded).toContain("No flood-hazard-fact atom on file");
    expect(decoded).toContain("VERDICT");
    expect(decoded).toContain("NARRATIVE");
  });

  it("item 6 — the open items table lists every absent section with a real action sentence", async () => {
    const model = await buildModel([]);
    const result = await emitPdfFeasibility(model);
    const decoded = decodeAllContentStreams(result.bytes);
    expect(decoded).toContain("Open items");
    expect(decoded).toContain("Order a title or CAD roll pull");
    expect(decoded).toContain("Confirm special-district membership");
  });

  it("item 7 — LLM disabled still emits a complete document with a grounded deterministic skeleton", async () => {
    const model = await buildModel([]);
    // Grounded: cites the actual county name and zoning district from the model, not a placeholder.
    expect(model.package.narrativeSkeleton).toContain("Bexar County");
    expect(model.package.narrativeSkeleton).toContain("R-6");
    expect(model.package.verdict).toMatch(/open item/);
    const result = await emitPdfFeasibility(model);
    expect(result.narrativeGrounded).toBe(true);
    expect(result.narrativeIsDeterministicSkeleton).toBe(true);
  });

  it("a caller-supplied narrativeOverride renders verbatim instead of the deterministic skeleton", async () => {
    const model = await buildModel([]);
    const result = await emitPdfFeasibility(model, {
      narrativeOverride: { text: "A wholly distinct generated narrative sentence for this parcel.", generatedBy: "test-llm", generatedAt: "2026-09-04T00:00:00Z" },
    });
    expect(result.narrativeIsDeterministicSkeleton).toBe(false);
    const decoded = decodeAllContentStreams(result.bytes);
    expect(decoded).toContain("A wholly distinct generated narrative sentence");
  });

  it("appends exactly one site-plan sheet when a site plan is supplied, same as the dossier contract", async () => {
    const sitePlan = buildSitePlanModel();
    const model = await composeParcelReportFacts({
      parcelNodeId: "48029:105129",
      storage: fakeStorage([]),
      geometry: { status: "present", model: sitePlan },
      drainage: NO_DRAINAGE,
    });
    const result = await emitPdfFeasibility(model, { sitePlan: { model: sitePlan } });
    expect(result.sitePlanAppended).toBe(true);
    expect(result.pageCount).toBe(result.feasibilityPageCount + 1);
    const decoded = decodeAllContentStreams(result.bytes);
    expect(decoded).toContain("SITE PLAN");
  });

  it("prints a supplied liveViewUrl verbatim on the cover", async () => {
    const model = await buildModel([]);
    const result = await emitPdfFeasibility(model, { liveViewUrl: "https://smartsite.cloud/share?g=test-feasibility" });
    const decoded = decodeAllContentStreams(result.bytes);
    expect(decoded).toContain("https://smartsite.cloud/share?g=test-feasibility");
  });

  // item 14, defect 4: every parcel-and-ownership fact shares one citation
  // (po.sourceCitation/asOfIso) — only Market value was wired to show it,
  // leaving Legal description/Land use/Owner/Assessed value/Year built/
  // Living area with none on the same sheet, same section weight.
  it("item 14 — every parcel-and-ownership fact carries the shared citation, not just market value", async () => {
    const cadRoll = {
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
      marketValue: 350000,
      assessedValue: 350000,
      yearBuilt: 1905,
      livingAreaSqft: 2408,
      situsAddress: "1127 N PINE ST",
      accessPolicy: "public-free" as const,
      sourceCitation: "cad_property county 48029, taxYears 2025",
      extractedAt: "2026-08-12T17:19:40.095Z",
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
    const model = await buildModel([cadRoll as unknown as PropertyAtomInstance]);
    const result = await emitPdfFeasibility(model);
    const decoded = decodeAllContentStreams(result.bytes);
    // Substring match: the citation source text must appear more than once
    // — once would mean only one fact (market value) still carries it.
    const occurrences = decoded.split("cad_property county 48029").length - 1;
    expect(occurrences).toBeGreaterThan(1);
  });

  // item 14, defect: County fell back to the raw FIPS code ("48021") when no
  // county name was on file, violating format.ts's own countyDisplayName
  // rule (§11: a raw FIPS code never prints). Same leak in the narrative.
  it("item 14 — never prints a raw county FIPS code when the county name is unresolved", async () => {
    // countyFips is parsed from the parcelNodeId itself ("48029:..."),
    // independent of the descriptor, so omitting countyName from the
    // descriptor (rather than mutating an already-composed model, which
    // package.narrativeSkeleton is baked from at compose time, R5) is the
    // faithful way to exercise the unresolved-name path through the real
    // composition.
    const sitePlanNoCountyName = composeSitePlanModel({
      parcelNodeId: "48029:105129",
      bbox,
      ringWgs84,
      dem,
      contourIntervalMeters: 0.5,
      setback,
      boundaryEdges,
      descriptor: { address: "1127 N PINE ST, SAN ANTONIO, TX 78202" },
      zoning: { district: "R-6" },
      floodZone: { honestUnavailable: true, reason: "sandbox has no network egress" },
      geometrySourceRef: "txgio-parcel:48029:105129:stratmap25-landparcels_48029_2025",
    });
    const unresolvedModel = await composeParcelReportFacts({
      parcelNodeId: "48029:105129",
      storage: fakeStorage([]),
      geometry: { status: "present", model: sitePlanNoCountyName },
      drainage: NO_DRAINAGE,
    });
    expect(unresolvedModel.facts.jurisdiction.countyName).toBeUndefined();
    expect(unresolvedModel.facts.jurisdiction.countyFips).toBe("48029");
    const result = await emitPdfFeasibility(unresolvedModel);
    const decoded = decodeAllContentStreams(result.bytes);
    // The parcelNodeId ("48029:105129") legitimately contains the FIPS
    // prefix elsewhere on the sheet — the bug was the raw code standing in
    // for the county NAME specifically, in the narrative's "sits in ..."
    // clause and the County fact row.
    expect(decoded).not.toContain("sits in 48029.");
    expect(decoded).toContain("sits in an unresolved county.");
  });

  it("item 19 — a real named discharge point renders cited, distance included", async () => {
    const model = await buildModel([], {
      dischargeExitPoint: { lat: 30.1269, lng: -97.3305 },
      dischargeResolver: {
        resolve: async () => ({
          status: "present",
          point: {
            name: "Piney Creek",
            featureType: "STREAM/RIVER",
            distanceMeters: 41,
            sourceUrl: "https://maps.co.bastrop.tx.us/server/rest/services/Hydrography/Creeks_Streams/MapServer/0",
            layerName: "Bastrop County Creeks & Streams",
          },
        }),
      },
    });
    const result = await emitPdfFeasibility(model);
    const decoded = decodeAllContentStreams(result.bytes);
    expect(decoded).toContain("Named downstream discharge point");
    expect(decoded).toContain("Piney Creek");
    expect(decoded).toContain("41 m from modeled exit");
  });

  it("item 19 — honest UNAVAILABLE, never a fabricated name, when no exit point was supplied", async () => {
    const model = await buildModel([]);
    const result = await emitPdfFeasibility(model);
    const decoded = decodeAllContentStreams(result.bytes);
    expect(decoded).toContain("Named downstream discharge point");
    expect(decoded).toContain("No flood-drainage-study flow exit was supplied");
  });
});
