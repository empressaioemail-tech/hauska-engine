/**
 * P-248 falsifiers 1 and 2 — the dispatch's own instrument, run the way P-219
 * and P-239 were verified: REGENERATE the PDFs and DECODE them.
 *
 * What is real here and what is a fixture (the honest denominator):
 *
 *  - The 908 Pine parcel RING is the real one — it is the boundary the repo's
 *    own offline fixture carries for `48021:34137` (`src/registry/__fixtures__/
 *    block13-offline.json`), copied verbatim, with that fixture's own four
 *    boundary-edge roles (rear / side / front / side_corner).
 *  - The FOOTPRINT atom is built by the production writer
 *    (`buildPresentBuildingFootprintAtom`, `@hauska-engine/atoms`) from a
 *    POLYGON FIXTURE placed inside that real ring. The store has no
 *    ML footprint for this parcel in this checkout, so the polygon's own
 *    vertices are a fixture; everything downstream of the atom — the mapper,
 *    the composer, the layout, the transform, the sheet — is production.
 *  - `verificationStatus` is left OFF the observation on purpose, so the
 *    atom's own default (`unsurveyed` for an `ml-derived` tier) is what the
 *    sheet has to print.
 *
 * Set `P248_PROBE_OUT=<dir>` to also write the regenerated PDFs and a JSON of
 * the decoded excerpts, which is what the lane's close cites.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildBuildingFootprintPerParcelAbsenceAtom,
  buildPresentBuildingFootprintAtom,
  type PropertyAtomInstance,
} from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import { footprintsInputFromAtoms } from "../../footprint-layer.js";
import { composeParcelReportFacts } from "../../report-model.js";
import { composeXrayBrief } from "../../dossier-author.js";
import { composeSitePlanModel } from "../../site-model.js";
import { boundaryEdgesForRing } from "../../__tests__/boundary-edge-fixture.js";
import { emitPdfDossier } from "../dossier.js";
import { emitPdfFeasibility } from "../feasibility.js";
import { emitPdfSitePlan, type PdfSitePlanResult } from "../render.js";
import { decodeAllContentStreams } from "./decode-pdf-text.js";

// ── the real 908 Pine parcel ────────────────────────────────────────────
const PINE = "48021:34137";

/** `block13-offline.json` → parcels["48021:34137"].ring, verbatim. */
const PINE_RING: Array<[number, number]> = [
  [-97.31637445599995, 30.109579695000036],
  [-97.31669069099996, 30.10957718000003],
  [-97.31669481099999, 30.110037139000042],
  [-97.31638153399996, 30.11003779500004],
  [-97.31637445599995, 30.109579695000036],
];

/** Same fixture, same parcel: the four persisted edge roles, in edge order. */
const PINE_EDGES = [
  { role: "rear" as const, feet: 25 },
  { role: "side" as const, feet: 5 },
  { role: "front" as const, feet: 25 },
  { role: "side_corner" as const, feet: 15 },
];

const SF1_SETBACK = {
  front: 25,
  side: 5,
  rear: 25,
  sourceCodeAtomRef: {
    atomDid: "did:hauska:setback-rule:48021:34137",
    role: "rule",
    entityType: "code-section",
  },
};

function bboxAround(ring: Array<[number, number]>, marginFactor = 1.6) {
  const lngs = ring.map(([lng]) => lng);
  const lats = ring.map(([, lat]) => lat);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const dLng = (maxLng - minLng) * (marginFactor - 1);
  const dLat = (maxLat - minLat) * (marginFactor - 1);
  return {
    westLng: minLng - dLng,
    eastLng: maxLng + dLng,
    southLat: minLat - dLat,
    northLat: maxLat + dLat,
  };
}

/** Flat 4x4 DEM — the drawing needs contours to exist, not elevations here. */
const DEM = {
  width: 4,
  height: 4,
  values: new Float32Array([
    200, 200.5, 201, 201.2, 199.8, 200.2, 200.7, 201.0, 199.5, 200.0, 200.4, 200.8, 199.2, 199.7, 200.1, 200.5,
  ]),
  minElevation: 199.2,
  maxElevation: 201.2,
  nodataCount: 0,
};

/**
 * A POLYGON FIXTURE inside the real ring: the ML footprint the sheet is asked
 * to draw. Fractions of the parcel's own extent, so it cannot drift outside a
 * parcel whose real dimensions change; a front yard and a side yard are left
 * open, the way a mapped house on a 50 ft lot sits.
 */
function footprintPolygon(ring: Array<[number, number]>): Array<[number, number]> {
  const lngs = ring.map(([lng]) => lng);
  const lats = ring.map(([, lat]) => lat);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const w = maxLng - minLng;
  const h = maxLat - minLat;
  const x0 = minLng + w * 0.2;
  const x1 = minLng + w * 0.8;
  const y0 = minLat + h * 0.25;
  const y1 = minLat + h * 0.7;
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ];
}

const FOOTPRINT_ID = "primary";
const FOOTPRINT_ATOM_DID = `did:hauska:building-footprint:${PINE}:${FOOTPRINT_ID}`;

function pineFootprintAtom(): PropertyAtomInstance {
  return buildPresentBuildingFootprintAtom(
    {
      parcelNodeId: PINE,
      footprintId: FOOTPRINT_ID,
      footprintGeometry: { type: "Polygon", coordinates: [footprintPolygon(PINE_RING)] },
      sourceTier: "ml-derived",
      structureRole: "primary",
      confidence: 0.71,
      // verificationStatus deliberately UNSET: the atom's own default.
    },
    {
      sourceAdapter: "ml-footprint-rss",
      sourceCitation:
        "Microsoft/OSM building footprints (ODC-By) — ML-derived polygon, no survey; fixture polygon inside the parcel ring for P-248 verification",
      sourceUrl: "https://example.invalid/ml-footprints",
      observedAt: "2026-09-16T00:00:00.000Z",
      jurisdictionTenant: "breadth_48021_bastrop",
      contentHash: "p248-probe-908-pine",
    },
  ) as unknown as PropertyAtomInstance;
}

function checkedClearAtom(parcelNodeId: string): PropertyAtomInstance {
  return buildBuildingFootprintPerParcelAbsenceAtom(
    {
      parcelNodeId,
      absenceKind: "no-footprint-feature",
      reason: "ML footprint source checked for this parcel and maps no structure",
    },
    {
      sourceAdapter: "ml-footprint-rss",
      sourceCitation: "Microsoft/OSM building footprints (ODC-By) — coverage checked, nothing mapped on this parcel",
      sourceUrl: "https://example.invalid/ml-footprints",
      observedAt: "2026-09-16T00:00:00.000Z",
      jurisdictionTenant: "breadth_48021_bastrop",
      contentHash: "p248-probe-vacant",
    },
  ) as unknown as PropertyAtomInstance;
}

const EMPTY_STORE: StoragePort = {
  listPropertyAtomsByParcelNodeId: async () => [],
} as unknown as StoragePort;

function storeWith(atoms: PropertyAtomInstance[]): StoragePort {
  return {
    listPropertyAtomsByParcelNodeId: async () => atoms,
  } as unknown as StoragePort;
}

/** The site model the production path composes, fed the layer the atoms make. */
function pineModel(atoms: PropertyAtomInstance[]) {
  return composeSitePlanModel({
    parcelNodeId: PINE,
    bbox: bboxAround(PINE_RING),
    ringWgs84: PINE_RING,
    dem: DEM,
    contourIntervalMeters: 0.5,
    setback: SF1_SETBACK,
    boundaryEdges: boundaryEdgesForRing(PINE_RING, PINE_EDGES),
    footprints: footprintsInputFromAtoms(atoms),
    descriptor: { address: "908 PINE ST, BASTROP, TX 78602", countyName: "Bastrop County" },
    zoning: { district: "SF-1" },
    floodZone: { honestUnavailable: true, reason: "probe fixture: no live FEMA NFHL read" },
    geometrySourceRef: "fixture:block13-offline:48021:34137",
  });
}

const TINY_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

function footprintMarks(result: PdfSitePlanResult) {
  return result.marks.filter((m) => m.kind === "footprint");
}

/** The lane's close cites this: regenerated PDFs + the decoded excerpts. */
const PROBE_OUT = process.env.P248_PROBE_OUT;
const decodedEvidence: Record<string, unknown> = {};

function capture(name: string, payload: Uint8Array, decoded: string, excerpt: string[]): void {
  decodedEvidence[name] = {
    byteCount: payload.byteLength,
    decodedLength: decoded.length,
    excerpt,
  };
  if (!PROBE_OUT) return;
  mkdirSync(PROBE_OUT, { recursive: true });
  writeFileSync(join(PROBE_OUT, `${name}.pdf`), Buffer.from(payload));
  writeFileSync(join(PROBE_OUT, `${name}.decoded.txt`), decoded, "utf8");
}

function excerpts(decoded: string, needles: string[]): string[] {
  return needles.map((needle) => {
    const at = decoded.indexOf(needle);
    return at < 0 ? `<<ABSENT>> ${needle}` : decoded.slice(at, at + needle.length + 40).split("\n")[0]!;
  });
}

describe("P-248 — the mapped footprint reaches the sheets (decoded PDFs)", { timeout: 120_000 }, () => {
  it("falsifier 1: 908 Pine's site plan draws the footprint polygon, its label and its legend row", async () => {
    const model = pineModel([pineFootprintAtom()]);
    expect(model.footprints.kind).toBe("present");
    expect(model.footprints.kind === "present" && model.footprints.polygons.length).toBe(1);

    const result = await emitPdfSitePlan(model, { aerial: { fetchImage: async () => TINY_PNG } });
    const decoded = decodeAllContentStreams(result.bytes);

    // (a) THE POLYGON: a keyed draw-once mark on the drawing sheet AND on the
    // aerial sheet, from the model's own rings — not a label-only claim.
    const marks = footprintMarks(result);
    expect(marks.map((m) => `${m.page}:${m.key}`).sort()).toEqual([`1:${FOOTPRINT_ID}`, `3:${FOOTPRINT_ID}`]);
    const sheet1 = marks.find((m) => m.page === 1)!;
    expect(sheet1.bbox).toBeTruthy();
    // §3 frame gate stays true for the mark this row adds.
    const f = result.page1Frame;
    const b = sheet1.bbox!;
    expect(b.minX).toBeGreaterThanOrEqual(f.minX);
    expect(b.maxX).toBeLessThanOrEqual(f.maxX);
    expect(b.minY).toBeGreaterThanOrEqual(f.minY);
    expect(b.maxY).toBeLessThanOrEqual(f.maxY);

    // (b) THE LABEL: tier and verification status, off the atom, humanised.
    expect(decoded).toContain("EXISTING STRUCTURE");
    expect(decoded).toContain("ML-DERIVED");
    expect(decoded).toContain("UNSURVEYED");

    // (c) THE LEGEND ROW: the layer's own state.
    expect(decoded).toContain("Existing structure · ML-derived, unsurveyed");

    capture(
      "p248_908pine_site_plan",
      result.bytes,
      decoded,
      excerpts(decoded, ["EXISTING STRUCTURE", "Existing structure · ML-derived, unsurveyed"]),
    );
  });

  it("falsifier 2: a vacant lot draws no footprint and says so in the legend", async () => {
    // (a) CHECKED AND CLEAR — an absence atom on file: "none mapped".
    const clearModel = pineModel([checkedClearAtom(PINE)]);
    expect(clearModel.footprints.kind).toBe("clear");
    const clearResult = await emitPdfSitePlan(clearModel, { aerial: { fetchImage: async () => TINY_PNG } });
    const clearDecoded = decodeAllContentStreams(clearResult.bytes);
    expect(footprintMarks(clearResult)).toHaveLength(0);
    expect(clearDecoded).toContain(
      "Existing structure — none mapped · the footprint source was checked and maps no structure here",
    );

    // (b) NEVER CHECKED — no atom at all: a different sentence, never the same
    // one (the D5 collapse this module exists to prevent).
    const uncheckedModel = pineModel([]);
    expect(uncheckedModel.footprints.kind).toBe("unchecked");
    const uncheckedResult = await emitPdfSitePlan(uncheckedModel, { aerial: { fetchImage: async () => TINY_PNG } });
    const uncheckedDecoded = decodeAllContentStreams(uncheckedResult.bytes);
    expect(footprintMarks(uncheckedResult)).toHaveLength(0);
    expect(uncheckedDecoded).toContain(
      "Existing structure — not checked · no footprint mapping has been run for this parcel",
    );

    capture(
      "p248_vacant_lot_checked_clear_site_plan",
      clearResult.bytes,
      clearDecoded,
      excerpts(clearDecoded, ["Existing structure — none mapped"]),
    );
    capture(
      "p248_vacant_lot_unchecked_site_plan",
      uncheckedResult.bytes,
      uncheckedDecoded,
      excerpts(uncheckedDecoded, ["Existing structure — not checked"]),
    );
  });

  it("the store read path resolves the same layer the mapper does (resolveFootprintLayer)", async () => {
    const atoms = [pineFootprintAtom()];
    const fromStore = await EMPTY_STORE.listPropertyAtomsByParcelNodeId(PINE);
    expect(fromStore).toHaveLength(0);
    const layer = footprintsInputFromAtoms(await storeWith(atoms).listPropertyAtomsByParcelNodeId(PINE));
    expect(layer.kind).toBe("present");
    expect(layer.kind === "present" && layer.footprints[0]!.ringWgs84.length).toBeGreaterThanOrEqual(4);
    // The layer the store read produces is the layer the model carries.
    const model = pineModel(atoms);
    expect(model.footprints.kind).toBe("present");
  });

  it("the feasibility study and the X-ray carry the same footprint — facts row, legend row, drawn ring", async () => {
    const atoms = [pineFootprintAtom()];
    const sitePlan = pineModel(atoms);
    const report = await composeParcelReportFacts({
      parcelNodeId: PINE,
      storage: storeWith(atoms),
      geometry: { status: "present", model: sitePlan },
      drainage: { status: "absent", reason: "probe fixture: drainage not composed" },
    });

    // The X-ray's own structures row now carries the verification word.
    const brief = composeXrayBrief(report);
    const structures = brief.sections.find((s) => s.id === "structures");
    expect(structures).toBeTruthy();
    const row = structures!.facts.find((fact) => fact.label === "Mapped footprints");
    expect(row?.value).toBe("1 · unsurveyed");

    const dossier = await emitPdfDossier(
      {
        parcelNodeId: PINE,
        address: "908 PINE ST",
        countyName: "Bastrop County",
        verdictLine: brief.verdictLine,
        brief: { sections: brief.sections },
      },
      { sitePlan: { model: sitePlan } },
    );
    const dossierDecoded = decodeAllContentStreams(dossier.bytes);
    // Section titles print uppercase (dossier.ts uppercases `section.title`).
    expect(dossierDecoded).toContain("STRUCTURES ON FILE");
    expect(dossierDecoded).toContain("Mapped footprints");
    expect(dossierDecoded).toContain("1 · unsurveyed");
    expect(dossierDecoded).toContain("UNSURVEYED");
    capture(
      "p248_908pine_xray",
      dossier.bytes,
      dossierDecoded,
      excerpts(dossierDecoded, ["STRUCTURES ON FILE", "Mapped footprints", "EXISTING STRUCTURE"]),
    );

    // The feasibility study: the facts page's structures row and the aerial
    // page's footprint ring, decoded from its own regenerated PDF.
    const feasibility = await emitPdfFeasibility(report, { sitePlan: { model: sitePlan } });
    const feasibilityDecoded = decodeAllContentStreams(feasibility.bytes);
    expect(feasibilityDecoded).toContain("EXISTING STRUCTURES");
    expect(feasibilityDecoded).toContain("Structure 1");
    expect(feasibilityDecoded).toContain("existing structure · unsurveyed");
    expect(feasibilityDecoded).toContain("ML-derived");
    capture(
      "p248_908pine_feasibility",
      feasibility.bytes,
      feasibilityDecoded,
      excerpts(feasibilityDecoded, ["EXISTING STRUCTURES", "existing structure · unsurveyed"]),
    );
  });

  it.runIf(Boolean(PROBE_OUT))("writes the probe's decoded evidence", () => {
    writeFileSync(join(PROBE_OUT!, "p248_decoded_evidence.json"), JSON.stringify(decodedEvidence, null, 2), "utf8");
    expect(Object.keys(decodedEvidence).length).toBeGreaterThan(0);
  });
});
