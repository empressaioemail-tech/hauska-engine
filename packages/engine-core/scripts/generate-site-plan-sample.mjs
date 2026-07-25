#!/usr/bin/env node
/**
 * Generates a sample DXF + IFC site-plan pair for the locked parcel
 * 48029:105129 (1127 N Pine St, San Antonio TX 78202, R-6).
 *
 * SYNTHETIC FIXTURE, not a live TxGIO/USGS fetch: this sandbox has no
 * outbound network egress (documented in
 * _inbox/2026-07-25_site_plan_export_STATUS.md Wave 0 evidence). The
 * parcel ring is an approximate ~62x125 ft rectangle (~7750 sqft, matching
 * the ~7756 sqft lot size on record) centered near the parcel's public
 * street address, NOT a surveyed boundary. The DEM is a synthetic gentle
 * slope in the plausible San Antonio elevation band (~193-198 m NAVD88),
 * NOT a real USGS 3DEP clip. Every value that matters for the exercise —
 * setback front/side/rear and the code citation — IS the real, atom-chain
 * verified value for this parcel (see STATUS Wave 0 evidence).
 *
 * Run: npx tsx scripts/generate-site-plan-sample.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildTerrainMeshGeometry } from "../src/parcel-terrain/mesh.js";
import { composeSitePlanModel } from "../src/site-plan/site-model.js";
import { emitDxfSitePlan, emitIfcSitePlan } from "../src/site-plan/emitters.js";
import { emitPdfSitePlan } from "../src/site-plan/pdf/render.js";

const PARCEL_NODE_ID = "48029:105129";
const OUT_DIR = process.argv[2] ?? "P:/doc_repo/_inbox/2026-07-25_site_plan_samples";

// Approximate centroid near 1127 N Pine St, San Antonio TX 78202 (Dignowity
// Hill). Not a geocoded or surveyed point — see the fixture disclosure above.
const centerLng = -98.4711;
const centerLat = 29.4332;

const METERS_PER_DEGREE_LAT = 111_320;
const cosLat = Math.cos((centerLat * Math.PI) / 180);
const metersPerDegreeLng = METERS_PER_DEGREE_LAT * cosLat;
const FEET_TO_METERS = 0.3048;

const halfWidthFt = 31; // ~62 ft frontage (east-west)
const halfDepthFt = 62.5; // ~125 ft depth (north-south)
const dLng = (halfWidthFt * FEET_TO_METERS) / metersPerDegreeLng;
const dLat = (halfDepthFt * FEET_TO_METERS) / METERS_PER_DEGREE_LAT;

const ringWgs84 = [
  [centerLng - dLng, centerLat - dLat],
  [centerLng + dLng, centerLat - dLat],
  [centerLng + dLng, centerLat + dLat],
  [centerLng - dLng, centerLat + dLat],
  [centerLng - dLng, centerLat - dLat],
];

const marginFactor = 1.6;
const bbox = {
  westLng: centerLng - dLng * marginFactor,
  eastLng: centerLng + dLng * marginFactor,
  southLat: centerLat - dLat * marginFactor,
  northLat: centerLat + dLat * marginFactor,
};

// 6x6 synthetic DEM, gentle slope, San Antonio plausible elevation band.
const demSize = 6;
const values = new Float32Array(demSize * demSize);
for (let y = 0; y < demSize; y++) {
  for (let x = 0; x < demSize; x++) {
    const slope = (x + y) * 0.18;
    values[y * demSize + x] = 195.4 + slope + (x === 2 && y === 3 ? 0.15 : 0);
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

// Real, atom-chain verified setback for 48029:105129 (R-6): front=10,
// side=5, rear=20 ft, cited san_antonio_tx/udc/35-310.01 — see STATUS
// Wave 0 evidence (matches both the 2026-07-24 live StoragePort write and
// the adapter source-of-truth san-antonio-tx.json independently).
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

async function main() {
  const model = composeSitePlanModel({
    parcelNodeId: PARCEL_NODE_ID,
    bbox,
    ringWgs84,
    dem,
    contourIntervalMeters: 0.25,
    setback,
    geometrySourceRef: "synthetic-fixture:1127-n-pine-st-san-antonio-tx-78202-approx-rect",
    demSourceCitation: "synthetic-fixture (no live USGS 3DEP fetch; sandbox has no network egress)",
    // Real, atom-chain verified values for this parcel (WDLL/STATUS Wave 0
    // evidence) — only the RING and DEM are synthetic in this fixture.
    descriptor: { address: "1127 N PINE ST, SAN ANTONIO, TX 78202", countyName: "Bexar County" },
    zoning: { district: "R-6" },
    // Flood zone genuinely could not be read live (same network hazard as
    // Wave 0/1) — honest-unavailable, never fabricated.
    floodZone: {
      honestUnavailable: true,
      reason: "Sandbox has no outbound network egress to FEMA NFHL (see STATUS Wave 0 evidence).",
    },
  });
  const mesh = buildTerrainMeshGeometry(dem, bbox);

  const dxf = await emitDxfSitePlan(model, mesh);
  const ifc = await emitIfcSitePlan(model, mesh, "synthetic-fixture (see manifest)");
  if (ifc.status !== "ok" || !ifc.ifcText) {
    throw new Error(`IFC site-plan emission failed: ${ifc.message ?? "unknown worker error"}`);
  }
  const pdf = await emitPdfSitePlan(model);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, `${PARCEL_NODE_ID.replace(":", "_")}_site_plan.dxf`), Buffer.from(dxf.bytes));
  await writeFile(join(OUT_DIR, `${PARCEL_NODE_ID.replace(":", "_")}_site_plan.ifc`), ifc.ifcText, "utf8");
  await writeFile(join(OUT_DIR, `${PARCEL_NODE_ID.replace(":", "_")}_site_plan.pdf`), Buffer.from(pdf.bytes));

  const manifest = {
    parcelNodeId: PARCEL_NODE_ID,
    generatedAt: new Date().toISOString(),
    fixtureKind: "synthetic",
    fixtureDisclosure:
      "Sandbox has no outbound network egress (see _inbox/2026-07-25_site_plan_export_STATUS.md Wave 0 evidence). " +
      "Ring is an approximate ~62x125 ft rectangle near the parcel address, not a surveyed boundary. " +
      "DEM is a synthetic gentle slope in a plausible San Antonio elevation band, not a live USGS 3DEP clip. " +
      "Setback values (front=10, side=5, rear=20 ft, cited san_antonio_tx/udc/35-310.01) ARE the real, " +
      "atom-chain-verified values for this parcel. Zoning district R-6, address, and county are also the " +
      "real, dispatch-verified values. Flood zone could NOT be read live (same network hazard) and is " +
      "rendered as honest-unavailable in the PDF, not fabricated.",
    setback,
    bbox,
    dxf: { entityCount: dxf.entityCount, byteCount: dxf.bytes.byteLength },
    ifc: {
      vertexCount: ifc.vertexCount,
      triangleCount: ifc.triangleCount,
      annotationCount: ifc.annotationCount,
      spatialValidation: ifc.spatialValidation,
    },
    pdf: { pageCount: pdf.pageCount, byteCount: pdf.bytes.byteLength },
    setbackDegenerate: model.setback.degenerate,
    setbackBasis: model.setback.basis,
    streetHonestAbsence: model.streets.honestAbsence,
    summary: model.summary,
  };
  await writeFile(join(OUT_DIR, `${PARCEL_NODE_ID.replace(":", "_")}_manifest.json`), JSON.stringify(manifest, null, 2), "utf8");

  console.log(JSON.stringify({ status: "ok", outDir: OUT_DIR, manifest }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
