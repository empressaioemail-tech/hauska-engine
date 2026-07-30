#!/usr/bin/env node
/**
 * Stamp missing zoning-fact atoms for re-platted successor prop_ids (R9 companion).
 * Spatial L83 district at BCAD centroid when prop_id not yet on city GIS layers.
 *
 *   PROPERTY_ATOM_PATH=1 DATABASE_URL=... \
 *     pnpm --filter @hauska-engine/engine-core exec tsx scripts/stamp-bastrop-successor-zoning-fact.mjs --apply
 */
import { arcgisPointQuery } from "../../adapters/src/arcgis.ts";
import { BASTROP_ZONE_TYPE_CLASS } from "../../adapters/src/local/setbacks/bastrop-per-parcel-record.ts";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import bastropDescriptor from "../src/property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import {
  assertParcelCurrencyInBcad,
  ringCentroidLngLat,
} from "../src/boundary-primitive/index.ts";
import { emitZoningFact } from "../src/property-reasoning/emit-zoning-fact.ts";
import { writePropertyAtomIfEnabled } from "../src/property-reasoning/write-property-atom.ts";

const COUNTY_FIPS = "48021";
const CITY_KEY = "bastrop-city-tx";
const L83 =
  "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Zoned_Parcels/FeatureServer/83";

const SUCCESSORS = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("--"))
  .map((a) => a.trim())
  .filter(Boolean);
const propIds =
  SUCCESSORS.length > 0
    ? SUCCESSORS
    : ["8741972", "8741974"];

const apply = process.argv.includes("--apply");
const dryRun = !apply;

if (!dryRun && process.env.PROPERTY_ATOM_PATH !== "1") {
  console.error("FATAL: PROPERTY_ATOM_PATH=1 required for --apply");
  process.exit(1);
}

const substrateUrl = resolveSubstrateDatabaseUrl();
if (!substrateUrl) {
  console.error("FATAL: DATABASE_URL required");
  process.exit(1);
}

const storageHandle = dryRun
  ? null
  : createPgStorage({ databaseUrl: substrateUrl, maxConnections: 2 });

const descriptor = {
  ...bastropDescriptor,
  sourceAdapter: `txgio-zoning-stamp:${CITY_KEY}`,
  sourceUrl: L83,
};

const outcomes = [];

for (const propId of propIds) {
  const parcelNodeId = `${COUNTY_FIPS}:${propId}`;
  const currency = await assertParcelCurrencyInBcad(propId);
  if (!currency.ok) {
    outcomes.push({ propId, status: "superseded", reason: currency.reason });
    continue;
  }

  const [lng, lat] = ringCentroidLngLat(currency.ring);
  const l83 = await arcgisPointQuery({
    serviceUrl: L83,
    longitude: lng,
    latitude: lat,
    outFields: "ZoneTypeClass,prop_id",
    upstreamLabel: "Bastrop Zoned_Parcels layer 83 (spatial)",
  });

  const attrs = l83.features[0]?.attributes ?? {};
  const ztcRaw = attrs.ZoneTypeClass;
  const ztc =
    typeof ztcRaw === "number"
      ? ztcRaw
      : typeof ztcRaw === "string"
        ? Number(ztcRaw)
        : NaN;
  const district = BASTROP_ZONE_TYPE_CLASS[ztc];
  if (!district) {
    outcomes.push({
      propId,
      status: "no-district",
      ztc: ztcRaw,
      spatialPropId: attrs.prop_id,
    });
    continue;
  }

  const extractedAt = new Date().toISOString();
  const atom = emitZoningFact(
    descriptor,
    {
      parcelNodeId,
      districtCode: district,
      districtLabel: district,
      matchBasis: "exact",
      extractedAt,
      sourceCitation:
        `GIS Zoned_Parcels field ZoneTypeClass cityKey=${CITY_KEY}` +
        ` vintage=${extractedAt} district=${district} parcel=${parcelNodeId}` +
        ` (R9 successor spatial stamp; layer83 prop_id=${attrs.prop_id ?? "unknown"})`,
    },
    1,
  );

  if (dryRun) {
    outcomes.push({
      propId,
      status: "would-stamp",
      district,
      spatialPropId: attrs.prop_id,
      centroid: [lng, lat],
    });
    continue;
  }

  const written = await writePropertyAtomIfEnabled(
    storageHandle.storage,
    atom,
  );
  outcomes.push({
    propId,
    status: "stamped",
    district,
    atomDid: written?.atomDid,
    spatialPropId: attrs.prop_id,
  });
}

console.log(JSON.stringify({ dryRun, outcomes }, null, 2));

if (storageHandle) await storageHandle.close();

process.exit(outcomes.some((o) => o.status === "no-district" || o.status === "superseded") ? 1 : 0);
