#!/usr/bin/env node
/**
 * Track B2 gold sample — site-plan PDF design pass for 48021:34785
 * (1009 Chestnut St, Bastrop). Uses the live TxGIO ring fixture already in
 * engine-core (PARCEL_1009_CHESTNUT_34785_LIVE_TXGIO) + a synthetic DEM so
 * the sheet can be regenerated offline. STREET remains honest-absence until
 * B1 road geometry lands.
 *
 * Run from packages/engine-core:
 *   npx tsx scripts/generate-site-plan-gold-34785.mjs
 *   npx tsx scripts/generate-site-plan-gold-34785.mjs P:/doc_repo/_inbox/2026-07-27_track_b2_site_plan_samples
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PARCEL_1009_CHESTNUT_34785_LIVE_TXGIO } from "../src/depth-warm/fixtures/parcelRings.ts";
import { composeSitePlanModel } from "../src/site-plan/site-model.ts";
import { emitPdfSitePlan } from "../src/site-plan/pdf/render.ts";

const PARCEL_NODE_ID = "48021:34785";
const OUT_DIR = process.argv[2] ?? "P:/doc_repo/_inbox/2026-07-27_track_b2_site_plan_samples";

const ringWgs84 = PARCEL_1009_CHESTNUT_34785_LIVE_TXGIO;

function ringBbox(ring) {
  const lngs = ring.map(([lng]) => lng);
  const lats = ring.map(([, lat]) => lat);
  const padLng = (Math.max(...lngs) - Math.min(...lngs)) * 0.35 || 0.0003;
  const padLat = (Math.max(...lats) - Math.min(...lats)) * 0.35 || 0.0003;
  return {
    westLng: Math.min(...lngs) - padLng,
    eastLng: Math.max(...lngs) + padLng,
    southLat: Math.min(...lats) - padLat,
    northLat: Math.max(...lats) + padLat,
  };
}

const bbox = ringBbox(ringWgs84);

// Synthetic gentle DEM in a plausible Bastrop elevation band (~140–145 m NAVD88).
const demSize = 8;
const values = new Float32Array(demSize * demSize);
for (let y = 0; y < demSize; y++) {
  for (let x = 0; x < demSize; x++) {
    values[y * demSize + x] = 141.2 + (x + y) * 0.22 + (x === 3 && y === 4 ? 0.35 : 0);
  }
}
const dem = {
  width: demSize,
  height: demSize,
  values,
  minElevation: Math.min(...values),
  maxElevation: Math.max(...values),
  nodataCount: 0,
};

// Bastrop residential front setback pattern used by FIX1.1 / depth-warm for
// this gold: front 15 ft with sides/rear for a readable sellable sheet.
// frontEdgeIndex = west edge (3) facing Chestnut.
const setback = {
  front: 15,
  side: 5,
  rear: 15,
  sourceCodeAtomRef: {
    atomDid: "bastrop_tx/udc:residential-front-setback",
    role: "rule",
    entityType: "code-section",
  },
};

async function main() {
  const model = composeSitePlanModel({
    parcelNodeId: PARCEL_NODE_ID,
    bbox,
    ringWgs84,
    dem,
    contourIntervalMeters: 0.5,
    setback,
    frontEdgeIndex: 3,
    geometrySourceRef: "txgio-live-fixture:48021:34785:PARCEL_1009_CHESTNUT_34785_LIVE_TXGIO",
    demSourceCitation:
      "synthetic-fixture DEM (Track B2 design-pass sample; not a live USGS 3DEP clip)",
    descriptor: {
      address: "1009 CHESTNUT ST, BASTROP, TX",
      countyName: "Bastrop County",
    },
    zoning: { district: "R-1 (fixture label — confirm live zoning-fact on planner QA)" },
    floodZone: {
      honestUnavailable: true,
      reason: "Gold sample script does not call FEMA NFHL (offline regenerate).",
    },
  });

  const pdf = await emitPdfSitePlan(model);
  await mkdir(OUT_DIR, { recursive: true });
  const stem = PARCEL_NODE_ID.replace(":", "_");
  await writeFile(join(OUT_DIR, `${stem}_site_plan.pdf`), Buffer.from(pdf.bytes));

  const manifest = {
    parcelNodeId: PARCEL_NODE_ID,
    generatedAt: new Date().toISOString(),
    track: "B2",
    wdllItems: [3, 4, 6],
    fixtureKind: "live-txgio-ring + synthetic DEM",
    fixtureDisclosure:
      "Ring is the live TxGIO fixture PARCEL_1009_CHESTNUT_34785_LIVE_TXGIO (GIS parcel polygon, not a survey). " +
      "DEM is synthetic for offline regenerate. STREET is honest-absence until B1 road geometry merges. " +
      "Property-line bearing/distance tags are GIS-approximate — not survey-grade.",
    streetHonestAbsence: model.streets.honestAbsence,
    setbackDegenerate: model.setback.degenerate,
    setbackBasis: model.setback.basis,
    buildableAreaSqFt: model.summary.buildableAreaSqFt,
    lotAreaSqFt: model.summary.lotAreaSqFt,
    propertySegmentCount: model.propertySegments.length,
    pdf: { pageCount: pdf.pageCount, byteCount: pdf.bytes.byteLength },
    regenerate:
      "cd P:/hauska-engine/packages/engine-core && npx tsx scripts/generate-site-plan-gold-34785.mjs",
  };
  await writeFile(join(OUT_DIR, `${stem}_manifest.json`), JSON.stringify(manifest, null, 2), "utf8");
  await writeFile(
    join(OUT_DIR, "README.md"),
    [
      "# Track B2 — site-plan design pass samples",
      "",
      "Gold parcel: `48021:34785` (1009 Chestnut).",
      "",
      "Regenerate:",
      "```",
      "cd P:/hauska-engine/packages/engine-core",
      "npx tsx scripts/generate-site-plan-gold-34785.mjs",
      "```",
      "",
      "Planner verifies the live PDF (customer-reads-as-paid-deliverable). Builder does not claim customer QA.",
      "",
    ].join("\n"),
    "utf8",
  );

  console.log(JSON.stringify({ status: "ok", outDir: OUT_DIR, manifest }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
