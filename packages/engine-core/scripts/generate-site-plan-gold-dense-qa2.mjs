#!/usr/bin/env node
/**
 * QA2 craft sample — small dense parcel PDF for visual QA alongside 34785.
 * Uses a compact synthetic ring so label crowding is visible.
 *
 * Run from packages/engine-core:
 *   npx tsx scripts/generate-site-plan-gold-dense-qa2.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { composeSitePlanModel } from "../src/site-plan/site-model.ts";
import { emitPdfSitePlan } from "../src/site-plan/pdf/render.ts";

const PARCEL_NODE_ID = "qa2:dense-small";
const OUT_DIR = process.argv[2] ?? "P:/doc_repo/_inbox/2026-07-27_qa2_site_plan_craft_samples";

const ringWgs84 = [
  [-98.49978, 29.40012],
  [-98.49974, 29.40012],
  [-98.49970, 29.40012],
  [-98.49970, 29.40016],
  [-98.49970, 29.40020],
  [-98.49974, 29.40020],
  [-98.49978, 29.40020],
  [-98.49978, 29.40016],
  [-98.49978, 29.40012],
];

const bbox = {
  westLng: -98.4999,
  eastLng: -98.4995,
  southLat: 29.4000,
  northLat: 29.40035,
};

const demSize = 6;
const values = new Float32Array(demSize * demSize);
for (let y = 0; y < demSize; y++) {
  for (let x = 0; x < demSize; x++) {
    values[y * demSize + x] = 200 + (x + y) * 0.15;
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

const setback = {
  front: 10,
  side: 5,
  rear: 10,
  sourceCodeAtomRef: {
    atomDid: "fixture/udc:dense-qa2",
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
    frontEdgeIndex: 0,
    geometrySourceRef: "qa2-dense-synthetic-ring",
    demSourceCitation: "synthetic-fixture DEM (QA2 craft sample; not live 3DEP)",
    descriptor: {
      address: "DENSE QA2 FIXTURE",
      countyName: "Bexar County",
    },
    zoning: { district: "R-6 (fixture)" },
    floodZone: {
      honestUnavailable: true,
      reason: "Gold sample script does not call FEMA NFHL (offline regenerate).",
    },
    streetAnchors: [
      {
        name: "N PINE ST",
        points: [
          [-98.49982, 29.40016],
          [-98.49966, 29.40016],
        ],
        sourceRef: "osm:way/dense-qa2",
      },
    ],
  });

  const pdf = await emitPdfSitePlan(model);
  await mkdir(OUT_DIR, { recursive: true });
  const stem = PARCEL_NODE_ID.replace(/:/g, "_");
  await writeFile(join(OUT_DIR, `${stem}_site_plan.pdf`), Buffer.from(pdf.bytes));

  const manifest = {
    parcelNodeId: PARCEL_NODE_ID,
    generatedAt: new Date().toISOString(),
    track: "QA2-site-plan-craft",
    fixtureKind: "synthetic dense small ring",
    fixtureDisclosure:
      "Synthetic crowded parcel for label-collision visual QA. GIS tags are approximate. Not a survey.",
    streetHonestAbsence: model.streets.honestAbsence,
    lotAreaSqFt: model.summary.lotAreaSqFt,
    propertySegmentCount: model.propertySegments.length,
    pdf: { pageCount: pdf.pageCount, byteCount: pdf.bytes.byteLength },
    regenerate:
      "cd P:/hauska-engine/packages/engine-core && npx tsx scripts/generate-site-plan-gold-dense-qa2.mjs",
  };
  await writeFile(join(OUT_DIR, `${stem}_manifest.json`), JSON.stringify(manifest, null, 2), "utf8");
  console.log(JSON.stringify({ status: "ok", outDir: OUT_DIR, manifest }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
