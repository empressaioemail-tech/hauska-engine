#!/usr/bin/env node
/**
 * backfill-bastrop-zoning-fact-provenance.mjs — COMPLETE-BASTROP A1 (WDLL 2)
 *
 * UPDATE/re-emit Bastrop zoning-fact atoms so sourceAdapter/sourceUrl/
 * sourceCitation cite the City of Bastrop AGOL Zoning_Place_Type origin.
 * Breadth bake stays as a TRANSFORM step in reasoningChain — not the source.
 *
 * Origin (do not invent):
 *   https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Zoning_Place_Type/FeatureServer/0
 *   codeField=PlaceTypeClass cityKey=bastrop-city-tx
 *
 *   PROPERTY_ATOM_PATH=1 DATABASE_URL=...hauska_mcp... \
 *     pnpm --filter @hauska-engine/engine-core run backfill-bastrop-zoning-fact-provenance \
 *       [--dry-run] [--apply] [--limit=N] [--gold]
 *
 * Persist requires COMPLETE_BASTROP_A1_BACKFILL=1 or --apply (and PROPERTY_ATOM_PATH=1).
 */

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import postgres from "postgres";

const COUNTY_FIPS = "48021";
const CITY_KEY = "bastrop-city-tx";
const CODE_FIELD = "PlaceTypeClass";
const LAYER_NAME = "Zoning_Place_Type";
const SOURCE_URL =
  "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Zoning_Place_Type/FeatureServer/0";
const SOURCE_ADAPTER = `txgio-zoning-stamp:${CITY_KEY}`;
const BAKE_TRANSFORM = {
  kind: "TRANSFORM",
  adapter: "cortex-tier1-snapshot-breadth-bake",
  sourceUrl: "https://hauska.dev/internal/breadth-atom-bake/cortex-snapshot",
  note: "Breadth bake projected GIS stamp from cortex tier1 snapshot; not the district origin",
};
const GOLD_PROP_IDS = ["28286", "33512", "34785"];

function parseArgs(argv) {
  const out = {
    dryRun: false,
    apply: false,
    limit: null,
    batch: 500,
    gold: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--apply") out.apply = true;
    else if (a === "--gold") out.gold = true;
    else if (a === "--limit") out.limit = Number(argv[++i] || 0) || null;
    else if (a.startsWith("--limit="))
      out.limit = Number(a.slice("--limit=".length)) || null;
    else if (a === "--batch") out.batch = Number(argv[++i] || 500) || 500;
    else if (a.startsWith("--batch="))
      out.batch = Number(a.slice("--batch=".length)) || 500;
  }
  return out;
}

function sha256HexCanonical(s) {
  return createHash("sha256").update(s).digest("hex");
}

function log(msg) {
  console.log(`[a1-zoning-fact-prov] ${msg}`);
}

const args = parseArgs(process.argv.slice(2));
const dryRun =
  args.dryRun ||
  (!args.apply && process.env.COMPLETE_BASTROP_A1_BACKFILL !== "1");

if (!dryRun && process.env.PROPERTY_ATOM_PATH !== "1") {
  console.error("FATAL: PROPERTY_ATOM_PATH=1 required for persist.");
  process.exit(1);
}

const substrateUrl =
  process.env.DATABASE_URL?.trim() ||
  process.env.SUBSTRATE_DATABASE_URL?.trim();
if (!substrateUrl) {
  console.error("FATAL: DATABASE_URL (hauska_mcp) required.");
  process.exit(1);
}

const sql = postgres(substrateUrl, { ssl: "require", max: 4, prepare: false });
const t0 = performance.now();

const before = await sql`
  SELECT
    count(*)::int AS total,
    count(*) FILTER (
      WHERE coalesce(body->>'district','') <> ''
    )::int AS with_district,
    count(*) FILTER (
      WHERE coalesce(body->>'district','') <> ''
        AND coalesce(body->>'sourceAdapter','') LIKE 'txgio-zoning-stamp:%'
    )::int AS district_gis_adapter,
    count(*) FILTER (
      WHERE coalesce(body->>'district','') <> ''
        AND coalesce(body->>'sourceAdapter','') = 'cortex-tier1-snapshot-breadth-bake'
    )::int AS district_bake_adapter
  FROM atoms
  WHERE entity_type = 'zoning-fact'
    AND entity_id LIKE ${COUNTY_FIPS + ":%"}
`;
log(`BEFORE: ${JSON.stringify(before[0])}`);

let rows;
if (args.gold) {
  const ids = GOLD_PROP_IDS.map((p) => `${COUNTY_FIPS}:${p}`);
  rows = await sql`
    SELECT entity_id, atom_did, body
    FROM atoms
    WHERE entity_type = 'zoning-fact'
      AND entity_id = ANY(${ids})
      AND coalesce(body->>'district','') <> ''
    ORDER BY entity_id
  `;
} else {
  rows = await sql`
    SELECT entity_id, atom_did, body
    FROM atoms
    WHERE entity_type = 'zoning-fact'
      AND entity_id LIKE ${COUNTY_FIPS + ":%"}
      AND coalesce(body->>'district','') <> ''
      AND (
        coalesce(body->>'sourceAdapter','') = 'cortex-tier1-snapshot-breadth-bake'
        OR coalesce(body->>'sourceUrl','') = 'https://hauska.dev/internal/breadth-atom-bake/cortex-snapshot'
        OR coalesce(body->>'sourceUrl','') = ''
      )
    ORDER BY entity_id
    ${args.limit != null ? sql`LIMIT ${args.limit}` : sql``}
  `;
}

log(`candidates: ${rows.length} dryRun=${dryRun}`);

let updated = 0;
for (let i = 0; i < rows.length; i += args.batch) {
  const chunk = rows.slice(i, i + args.batch);
  for (const row of chunk) {
    const body = row.body && typeof row.body === "object" ? { ...row.body } : {};
    const district = typeof body.district === "string" ? body.district.trim() : "";
    if (!district) continue;
    const extractedAt =
      (typeof body.extractedAt === "string" && body.extractedAt) ||
      (typeof body.fetchedAt === "string" && body.fetchedAt) ||
      new Date().toISOString();
    const next = {
      ...body,
      sourceAdapter: SOURCE_ADAPTER,
      sourceUrl: SOURCE_URL,
      sourceCitation:
        `GIS ${LAYER_NAME} field ${CODE_FIELD} cityKey=${CITY_KEY}` +
        ` vintage=${extractedAt} district=${district} parcel=${row.entity_id}` +
        ` (PIP stamp; breadth bake is TRANSFORM only)`,
      reasoningChain: {
        reasoningKind: "observed",
        transformSteps: [BAKE_TRANSFORM],
      },
    };
    // Recompute contentHash over the patched body (engine convention).
    delete next.contentHash;
    next.contentHash = sha256HexCanonical(JSON.stringify(next));

    if (dryRun) {
      if (updated < 3) {
        log(
          `DRY sample entity_id=${row.entity_id} district=${district} ` +
            `oldAdapter=${body.sourceAdapter} → ${SOURCE_ADAPTER}`,
        );
      }
      updated += 1;
      continue;
    }

    await sql`
      UPDATE atoms
      SET body = ${sql.json(next)},
          updated_at = NOW()
      WHERE entity_type = 'zoning-fact'
        AND entity_id = ${row.entity_id}
    `;
    updated += 1;
  }
  log(`progress ${Math.min(i + chunk.length, rows.length)}/${rows.length}`);
}

const after = await sql`
  SELECT
    count(*) FILTER (
      WHERE coalesce(body->>'district','') <> ''
    )::int AS with_district,
    count(*) FILTER (
      WHERE coalesce(body->>'district','') <> ''
        AND coalesce(body->>'sourceAdapter','') = ${SOURCE_ADAPTER}
        AND coalesce(body->>'sourceUrl','') = ${SOURCE_URL}
    )::int AS district_gis_cited,
    count(*) FILTER (
      WHERE coalesce(body->>'district','') <> ''
        AND coalesce(body->>'sourceAdapter','') = 'cortex-tier1-snapshot-breadth-bake'
    )::int AS district_bake_adapter_remaining
  FROM atoms
  WHERE entity_type = 'zoning-fact'
    AND entity_id LIKE ${COUNTY_FIPS + ":%"}
`;
log(`AFTER: ${JSON.stringify(after[0])}`);

const gold = await sql`
  SELECT
    atom_did,
    body->>'district' AS district,
    body->>'sourceAdapter' AS source_adapter,
    body->>'sourceUrl' AS source_url,
    left(body->>'sourceCitation', 120) AS source_citation_prefix
  FROM atoms
  WHERE entity_type = 'zoning-fact'
    AND entity_id = ANY(${GOLD_PROP_IDS.map((p) => `${COUNTY_FIPS}:${p}`)})
  ORDER BY entity_id
`;
log(`GOLD: ${JSON.stringify(gold)}`);

log(
  `done dryRun=${dryRun} updated=${updated} elapsedMs=${Math.round(performance.now() - t0)}`,
);

await sql.end({ timeout: 5 });
