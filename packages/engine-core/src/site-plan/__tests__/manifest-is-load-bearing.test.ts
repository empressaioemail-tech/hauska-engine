import { describe, expect, it } from "vitest";
import type { PropertyAtomInstance } from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import { composeParcelReportFacts, type ParcelReportModel } from "../report-model.js";
import { composeSitePlanModel, type SitePlanModel } from "../site-model.js";
import {
  FEASIBILITY_MANIFEST,
  type ReportManifest,
  type ReportSectionId,
} from "../report-manifest.js";
import { emitPdfFeasibility, floodSheetPlan } from "../pdf/feasibility.js";

/**
 * THE ACCEPTANCE TEST FOR "make the manifest real".
 *
 * Before this lane, `pdf/feasibility.ts` called `manifestIncludes` exactly
 * ONCE, for "package". The other nine ids in `FEASIBILITY_MANIFEST` were
 * never consulted; `cover`, `fact-digest` and `drawing` appeared in the PDF
 * only because they were hardcoded. So the manifest passed review, answered
 * "do we gate sections?" affirmatively, and enforced nothing — the defect
 * class ENFORCEMENT.md opens with.
 *
 * The check is therefore a VIOLATION test, not a presence check: remove a
 * section id and the rendered document must change. A test that only
 * rendered the full manifest and asserted it looked right would have passed
 * just as happily against the inert version.
 *
 * Assertions are on PAGE COUNT and BYTE LENGTH only. PDF text extraction is
 * not trustworthy in this repo — the helper reads back through the document's
 * own ToUnicode map with a stale font assumption, so it can decode
 * "correctly" through a map that is itself wrong
 * (`_inbox/2026-09-08_pdf-text-extraction-instrument_finding.md`). Byte and
 * page counts do not go through that path.
 */

// ─── fixtures (same shape as report-model.test.ts) ───────────────────────
const parcelNodeId = "48029:1000001";
const bbox = { westLng: -98.5, southLat: 29.4, eastLng: -98.4995, northLat: 29.4004 };
const dem = {
  width: 4,
  height: 4,
  values: new Float32Array([
    200, 200.5, 201, 201.2, 199.8, 200.2, 200.7, 201.0, 199.5, 200.0, 200.4, 200.8, 199.2, 199.7,
    200.1, 200.5,
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
  sourceCodeAtomRef: {
    atomDid: "san_antonio_tx/udc/35-310.01/35-310.01",
    role: "rule",
    entityType: "code-section",
  },
};

function buildSitePlanModel(): SitePlanModel {
  return composeSitePlanModel({
    parcelNodeId,
    bbox,
    ringWgs84,
    dem,
    contourIntervalMeters: 0.5,
    setback,
    descriptor: { address: "1127 N PINE ST, SAN ANTONIO, TX 78202", countyName: "Bexar County" },
    zoning: { district: "R-6" },
    floodZone: { honestUnavailable: true, reason: "sandbox has no network egress" },
    geometrySourceRef: "txgio-parcel:48029:105129:stratmap25-landparcels_48029_2025",
  });
}

const fakeStorage = (atoms: PropertyAtomInstance[] = []): StoragePort =>
  ({
    listPropertyAtomsByParcelNodeId: async () => atoms,
  }) as unknown as StoragePort;

/** A fixed stamp so two renders of the SAME manifest are byte-comparable —
 * without it the generated-at line differs and every comparison below would
 * "pass" for the wrong reason. */
const GENERATED_AT = "2026-09-08T12:00:00.000Z";

/** Imagery is stubbed to a deterministic failure so the aerial page renders
 * its honest paper ground rather than reaching the network in a unit test.
 * The page is still emitted, which is what the manifest gate governs. */
const stubAerial = {
  fetchImage: async () => {
    throw new Error("test stub: no live imagery fetch");
  },
  timeoutMs: 1,
};

/** Built once and shared. Each render is a full PDF (~1s), and re-composing
 * the model plus re-rendering the full manifest inside every case put enough
 * parallel load on the suite to time out unrelated borderline tests. */
let modelOnce: Promise<ParcelReportModel> | undefined;
function buildModel(): Promise<ParcelReportModel> {
  modelOnce ??= composeModel();
  return modelOnce;
}

/** The full-manifest render, computed once and reused as the comparison
 * baseline by every per-id case. */
let fullOnce: Promise<{ pageCount: number; byteLength: number }> | undefined;
async function renderFull() {
  fullOnce ??= buildModel().then((m) => render(m, FEASIBILITY_MANIFEST));
  return fullOnce;
}

async function composeModel(): Promise<ParcelReportModel> {
  return composeParcelReportFacts({
    parcelNodeId,
    storage: fakeStorage(),
    geometry: { status: "present", model: buildSitePlanModel() },
    drainage: { status: "absent", reason: "no drainage study in this fixture" },
  });
}

function manifestWithout(id: ReportSectionId): ReportManifest {
  return Object.freeze({
    product: FEASIBILITY_MANIFEST.product,
    sections: Object.freeze(FEASIBILITY_MANIFEST.sections.filter((s) => s !== id)),
  });
}

async function render(model: ParcelReportModel, manifest: ReportManifest) {
  const sitePlan = model.geometry.status === "present" ? model.geometry.model : undefined;
  const result = await emitPdfFeasibility(
    model,
    {
      generatedAtIso: GENERATED_AT,
      ...(sitePlan ? { sitePlan: { model: sitePlan, aerial: stubAerial } } : {}),
    },
    manifest,
  );
  return { pageCount: result.pageCount, byteLength: result.bytes.length };
}

describe("FEASIBILITY_MANIFEST is load bearing", () => {
  it("CONTROL (not vacuous): two renders of the SAME manifest are byte-identical", async () => {
    const model = await buildModel();
    const a = await render(model, FEASIBILITY_MANIFEST);
    const b = await render(model, FEASIBILITY_MANIFEST);

    // Without this control, every assertion below could pass on incidental
    // nondeterminism (a timestamp, a map ordering) rather than on the
    // manifest actually being consulted.
    expect(b.byteLength).toBe(a.byteLength);
    expect(b.pageCount).toBe(a.pageCount);
  }, 60_000);

  // The ids whose output does not depend on a drainage study being on file.
  // The four flood ids are covered separately below, against the selection
  // they actually drive, because this fixture carries no study.
  const PDF_LEVEL_IDS: ReportSectionId[] = [
    "cover",
    "aerial",
    "drawing",
    "summary",
    "fact-digest",
    "package",
  ];

  // Ids that additionally drop a whole sheet — the coarsest evidence, and
  // the change a reader notices first.
  const PAGE_DROPPING_IDS = new Set<ReportSectionId>(["cover", "aerial", "drawing", "fact-digest"]);

  for (const id of PDF_LEVEL_IDS) {
    it(`removing "${id}" changes the rendered PDF`, async () => {
      const full = await renderFull();
      const without = await render(await buildModel(), manifestWithout(id));

      expect(without.byteLength).not.toBe(full.byteLength);
      if (PAGE_DROPPING_IDS.has(id)) {
        expect(without.pageCount).toBeLessThan(full.pageCount);
      }
    }, 60_000);
  }
});

/**
 * The four flood ids are independent of each other, which is the part most
 * likely to be faked: it would be easy to gate all four on one boolean and
 * call the manifest honoured. `flood-cover` selects the summary sheet; the
 * other three each select one drawing LAYER.
 *
 * Asserted against `floodSheetPlan`, the function that actually drives the
 * append, because this fixture carries no persisted study and a PDF-level
 * assertion here would be measuring the absent-study path instead.
 */
describe("the four flood ids each do something of their own", () => {
  const withStudy = {
    drainage: { status: "present", study: {} },
  } as unknown as ParcelReportModel;

  it("the full manifest takes both flood sheets and every layer", () => {
    const plan = floodSheetPlan(FEASIBILITY_MANIFEST, withStudy);
    expect(plan.localPages).toEqual([1, 2]);
    expect(plan.layers).toEqual({ catchment: true, ponding: true, flowPaths: true });
  });

  it('removing "flood-cover" drops the summary sheet and keeps the drawing', () => {
    const plan = floodSheetPlan(manifestWithout("flood-cover"), withStudy);
    expect(plan.localPages).toEqual([1]);
  });

  it('removing "ponding" keeps both sheets but turns off the modeled-water layer', () => {
    const plan = floodSheetPlan(manifestWithout("ponding"), withStudy);
    expect(plan.localPages).toEqual([1, 2]);
    expect(plan.layers.ponding).toBe(false);
    expect(plan.layers.catchment).toBe(true);
    expect(plan.layers.flowPaths).toBe(true);
  });

  it('removing "catchment" turns off only the catchment boundary', () => {
    const plan = floodSheetPlan(manifestWithout("catchment"), withStudy);
    expect(plan.layers.catchment).toBe(false);
    expect(plan.layers.ponding).toBe(true);
    expect(plan.layers.flowPaths).toBe(true);
  });

  it('removing "flow-paths" turns off only the flow lines', () => {
    const plan = floodSheetPlan(manifestWithout("flow-paths"), withStudy);
    expect(plan.layers.flowPaths).toBe(false);
    expect(plan.layers.catchment).toBe(true);
    expect(plan.layers.ponding).toBe(true);
  });

  it("with no study on file the flood append is empty, never a blank sheet", () => {
    const noStudy = {
      drainage: { status: "absent", reason: "none" },
    } as unknown as ParcelReportModel;
    expect(floodSheetPlan(FEASIBILITY_MANIFEST, noStudy).localPages).toEqual([]);
  });
});
