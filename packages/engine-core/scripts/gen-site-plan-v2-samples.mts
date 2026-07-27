/**
 * QA2 template-match sample generator. Emits two site-plan PDFs — a BIG
 * parcel (48021:34785, the template's Bastrop reference) and a SMALL DENSE
 * urban parcel — so the planner + operator can compare the rebuilt sheet
 * against the Industry gold-reference template side by side.
 *
 * Run: pnpm -C packages/engine-core tsx scripts/gen-site-plan-v2-samples.mts <outDir>
 *
 * Fixture data only. Uses a synthetic DEM (declared as such in the sheet's
 * fine print + provenance) — no live 3DEP fetch, no network.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { composeSitePlanModel } from "../src/site-plan/site-model.js";
import { emitPdfSitePlan } from "../src/site-plan/pdf/render.js";
import type { ParsedDem } from "../src/site-topography/derivation.js";

/** Synthesize a gentle sloping DEM over the bbox (row-major, NW origin). */
function syntheticDem(width: number, height: number, base: number, relief: number): ParsedDem {
  const values = new Float32Array(width * height);
  let min = Infinity;
  let max = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Slope down toward the south-east + a mild bulge.
      const fx = x / (width - 1);
      const fy = y / (height - 1);
      const v = base + relief * (0.6 * fy + 0.4 * fx) + Math.sin(fx * Math.PI) * relief * 0.15;
      values[y * width + x] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { width, height, values, minElevation: min, maxElevation: max, nodataCount: 0 };
}

async function writePdf(outDir: string, name: string, bytes: Uint8Array): Promise<void> {
  const p = resolve(outDir, name);
  writeFileSync(p, bytes);
  console.log(`wrote ${p} (${bytes.byteLength} bytes)`);
}

async function main(): Promise<void> {
  const outDir = resolve(process.argv[2] ?? ".");
  mkdirSync(outDir, { recursive: true });

  // ── BIG PARCEL — 1009 Chestnut St, Bastrop (template reference) ──
  // A ~98 x 164 ft lot (~16,100 SF). Front/rear 15', side 5' -> ~65% buildable.
  // No attaching road node -> honest empty STREET layer (matches the template).
  {
    const bbox = { westLng: -97.315, southLat: 30.109, eastLng: -97.3143, northLat: 30.1098 };
    const dem = syntheticDem(24, 24, 141.2, 3.1);
    // ~98 ft E-W (~0.00031 deg lng at 30N) x ~164 ft N-S (~0.00045 deg lat).
    const ring: Array<[number, number]> = [
      [-97.31480, 30.10940],
      [-97.31449, 30.10940],
      [-97.31449, 30.10985],
      [-97.31480, 30.10985],
      [-97.31480, 30.10940],
    ];
    const model = composeSitePlanModel({
      parcelNodeId: "48021:34785",
      bbox,
      ringWgs84: ring,
      dem,
      contourIntervalMeters: 1,
      setback: {
        front: 15,
        side: 5,
        rear: 15,
        sourceCodeAtomRef: { atomDid: "bastrop_tx/udc/residential-front-setback", role: "rule", entityType: "code-section" },
      },
      descriptor: { address: "1009 Chestnut St, Bastrop, TX", countyName: "Bastrop County" },
      zoning: { district: "R-1" },
      floodZone: { honestUnavailable: true, reason: "FEMA NFHL not queried on this run." },
      geometrySourceRef: "txgio-live-fixture:48021:34785",
      demSourceCitation: "synthetic-fixture DEM (Track B2) — sample, not live 3DEP",
    });
    const { bytes, pageCount, fontNote } = await emitPdfSitePlan(model);
    console.log(`BIG parcel 48021:34785 -> ${pageCount} pages; ${fontNote}`);
    await writePdf(outDir, "48021_34785_site_plan_v2.pdf", bytes);
  }

  // ── SMALL DENSE PARCEL — tight urban infill lot w/ an attaching street ──
  // ~28 x 45 ft (~1,260 SF) with 8 ring vertices, tight 10/5/20 setbacks,
  // and a fronting road node (exercises the street layer + dense collision).
  {
    const bbox = { westLng: -97.7440, southLat: 30.2670, eastLng: -97.7435, northLat: 30.2674 };
    const dem = syntheticDem(20, 20, 150.0, 2.2);
    const ring: Array<[number, number]> = [
      [-97.74385, 30.26715],
      [-97.74376, 30.26715],
      [-97.74368, 30.26715],
      [-97.74368, 30.26728],
      [-97.74368, 30.26740],
      [-97.74376, 30.26740],
      [-97.74385, 30.26740],
      [-97.74385, 30.26728],
      [-97.74385, 30.26715],
    ];
    const model = composeSitePlanModel({
      parcelNodeId: "48453:882910",
      bbox,
      ringWgs84: ring,
      dem,
      contourIntervalMeters: 0.5,
      setback: {
        front: 10,
        side: 5,
        rear: 20,
        sourceCodeAtomRef: { atomDid: "austin_tx/ldc/25-2-492", role: "rule", entityType: "code-section" },
      },
      descriptor: { address: "1412 E Cesar Chavez St, Austin, TX", countyName: "Travis County" },
      zoning: { district: "SF-3" },
      floodZone: { zone: "X", inSpecialFloodHazardArea: false, sourceCitation: "FEMA NFHL panel 48453C0465K", asOfIso: "2026-07-01T00:00:00Z" },
      geometrySourceRef: "txgio-live-fixture:48453:882910",
      demSourceCitation: "synthetic-fixture DEM (Track B2) — sample, not live 3DEP",
      streetAnchors: [
        {
          name: "E CESAR CHAVEZ ST",
          points: [
            [-97.74420, 30.26710],
            [-97.74340, 30.26710],
          ],
          sourceRef: "osm:way/cesar-chavez",
          rowProvenanceKind: "approximate-assumed-per-class",
          assumedWidthFt: 60,
          leftEdgePoints: [
            [-97.74420, 30.267055],
            [-97.74340, 30.267055],
          ],
          rightEdgePoints: [
            [-97.74420, 30.267145],
            [-97.74340, 30.267145],
          ],
        },
      ],
    });
    const { bytes, pageCount, fontNote } = await emitPdfSitePlan(model);
    console.log(`SMALL DENSE parcel 48453:882910 -> ${pageCount} pages; ${fontNote}`);
    await writePdf(outDir, "48453_882910_small_dense_site_plan_v2.pdf", bytes);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
