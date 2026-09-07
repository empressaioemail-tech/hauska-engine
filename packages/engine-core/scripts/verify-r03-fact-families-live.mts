#!/usr/bin/env node
/**
 * verify-r03-fact-families-live.mts -- live verification harness for P-120
 * item 18/20/21 (floodplain acreage + FIRM panel, SSURGO soil, electric/gas
 * provider). Runs the ACTUAL resolver code (not a re-implementation) against
 * live public upstreams for the two Bastrop parcels the dispatch names as
 * known-good: 48021:52726 and 48021:52727 (1007 Water St, downtown Bastrop,
 * TX -- the parcels tonight's outage work covered).
 *
 * Not part of the composition wiring (R-01 owns that); this is the
 * dispatch's own check -- "present and cited... verified against real
 * output, not a fixture" -- run against the resolvers directly, ahead of
 * whatever section R-01 eventually wires them into.
 *
 *   pnpm --filter @hauska-engine/engine-core exec tsx scripts/verify-r03-fact-families-live.mts
 */
import { resolveFloodplainFact } from "../src/floodplain-acreage-fact/resolve-floodplain-acreage.js";
import { resolveSoilFact } from "../src/soil-fact/resolve-soil-fact.js";
import { resolveElectricProviderFact } from "../src/electric-provider-fact/resolve-electric-provider.js";
import { resolveGasProviderFact } from "../src/electric-provider-fact/resolve-gas-provider.js";

const BASTROP_CAD_LAYER =
  "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Parcels_One_Click/FeatureServer/23";

async function fetchParcelRing(propId: number) {
  const url = new URL(`${BASTROP_CAD_LAYER}/query`);
  url.searchParams.set("where", `prop_id=${propId}`);
  url.searchParams.set("outFields", "prop_id,CALC_ACRE,SITUS_ADDR");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("f", "geojson");
  const res = await fetch(url);
  const body = (await res.json()) as {
    features?: Array<{ geometry: { coordinates: number[][][] }; properties: Record<string, unknown> }>;
  };
  const feature = body.features?.[0];
  if (!feature) throw new Error(`prop_id ${propId} not found on Bastrop CAD layer`);
  const ring = feature.geometry.coordinates[0]!.map(([lng, lat]) => [lng!, lat!] as [number, number]);
  const centroidPts = ring.slice(0, -1);
  const centroid = {
    longitude: centroidPts.reduce((s, p) => s + p[0], 0) / centroidPts.length,
    latitude: centroidPts.reduce((s, p) => s + p[1], 0) / centroidPts.length,
  };
  return { ring, centroid, props: feature.properties };
}

async function verifyParcel(parcelNodeId: string, propId: number) {
  console.log(`\n=== ${parcelNodeId} ===`);
  const { ring, centroid, props } = await fetchParcelRing(propId);
  console.log("CAD props:", JSON.stringify(props));

  const flood = await resolveFloodplainFact(ring);
  console.log("floodplain acreage:", JSON.stringify(flood, null, 2));

  const soil = await resolveSoilFact(centroid);
  console.log("soil:", JSON.stringify(soil, null, 2));

  const electric = await resolveElectricProviderFact(centroid);
  console.log("electric:", JSON.stringify(electric, null, 2));

  const gas = resolveGasProviderFact();
  console.log("gas:", JSON.stringify(gas, null, 2));

  return { parcelNodeId, flood, soil, electric, gas };
}

const results = [await verifyParcel("48021:52726", 52726), await verifyParcel("48021:52727", 52727)];

const fs = await import("node:fs");
const outPath =
  process.env.R03_VERIFY_OUT ??
  new URL("../../../r03-live-verification-results.json", import.meta.url).pathname.slice(1);
fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(`\n\nWrote full results to ${outPath}`);
