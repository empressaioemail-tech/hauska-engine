#!/usr/bin/env node
/**
 * Downtown drill — restamp zoning-fact from STEP0 ground truth (layer 83 district).
 * Manifest-only; fixes F1 P-x/build-to stamps before STEP4 warm.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const HERE = dirname(fileURLToPath(import.meta.url));
const GT = join(
  HERE,
  "../../../../doc_repo/_scratch/bastrop-downtown-drill-ground-truth.json",
);

const COUNTY_FIPS = "48021";
const CITY_KEY = "bastrop-city-tx";
const SOURCE_URL =
  "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Zoned_Parcels/FeatureServer/83";
const SOURCE_ADAPTER = `txgio-zoning-stamp:${CITY_KEY}`;

const dryRun = !process.argv.includes("--apply");
const gt = JSON.parse(readFileSync(GT, "utf8"));

const url =
  process.env.DATABASE_URL?.trim() ||
  process.env.SUBSTRATE_DATABASE_URL?.trim();
if (!url) {
  console.error("FATAL: DATABASE_URL required");
  process.exit(1);
}
if (!dryRun && process.env.PROPERTY_ATOM_PATH !== "1") {
  console.error("FATAL: PROPERTY_ATOM_PATH=1 required for --apply");
  process.exit(1);
}

function sha256HexCanonical(s) {
  return createHash("sha256").update(s).digest("hex");
}

const sql = postgres(url, { ssl: "require", max: 4, prepare: false });
const changes = [];

function pickDistrict(p) {
  const all = p.all_districts_83 ?? [];
  if ((p.overlap_rows ?? 1) > 1) {
    if (all.includes("MU")) return "MU";
    if (all.includes("PDD")) return "PDD";
    if (all.includes("GC") && !all.includes("SF-1")) return "GC";
  }
  return p.stamped_district_83 || p.zoneTypeClass;
}

for (const p of gt.parcels) {
  const entityId = `${COUNTY_FIPS}:${p.prop_id}`;
  const nextDistrict = pickDistrict(p);
  if (!nextDistrict) continue;

  const [row] = await sql`
    SELECT entity_id, body FROM atoms
    WHERE entity_type = 'zoning-fact' AND entity_id = ${entityId}
    LIMIT 1
  `;
  if (!row) {
    changes.push({ prop_id: p.prop_id, status: "missing-zoning-fact" });
    continue;
  }

  const body = { ...row.body };
  const oldDistrict = typeof body.district === "string" ? body.district : "";
  if (oldDistrict === nextDistrict && body.sourceUrl === SOURCE_URL) {
    changes.push({ prop_id: p.prop_id, status: "unchanged", district: oldDistrict });
    continue;
  }

  const extractedAt = new Date().toISOString();
  const next = {
    ...body,
    district: nextDistrict,
    absence: undefined,
    sourceAdapter: SOURCE_ADAPTER,
    sourceUrl: SOURCE_URL,
    sourceCitation:
      `GIS Zoned_Parcels field ZoneTypeClass cityKey=${CITY_KEY}` +
      ` vintage=${extractedAt} district=${nextDistrict} parcel=${entityId}` +
      ` (downtown drill manifest restamp from layer 83)`,
    extractedAt,
  };
  delete next.absence;
  delete next.contentHash;
  next.contentHash = sha256HexCanonical(JSON.stringify(next));

  if (!dryRun) {
    await sql`
      UPDATE atoms SET body = ${sql.json(next)}, updated_at = NOW()
      WHERE entity_type = 'zoning-fact' AND entity_id = ${entityId}
    `;
  }

  changes.push({
    prop_id: p.prop_id,
    status: dryRun ? "would-update" : "updated",
    oldDistrict,
    nextDistrict,
  });
}

console.log(
  JSON.stringify(
    {
      dryRun,
      manifestCount: gt.parcels.length,
      updated: changes.filter((c) => c.status === "updated" || c.status === "would-update").length,
      missing: changes.filter((c) => c.status === "missing-zoning-fact").length,
      unchanged: changes.filter((c) => c.status === "unchanged").length,
      sample: changes.filter((c) => [34081, 34073, 34841, 34089, 105054].includes(c.prop_id)),
    },
    null,
    2,
  ),
);

await sql.end({ timeout: 5 });
