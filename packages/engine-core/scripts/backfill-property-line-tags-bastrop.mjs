#!/usr/bin/env node
/**
 * backfill-property-line-tags-bastrop.mjs
 *
 * Patch existing Bastrop property-boundary-edge atoms with GIS propertyLineTags
 * from interior.edgeEndpoints. Does NOT re-run adjacency/roads/setbacks and
 * does NOT touch depth-warm promote.
 *
 *   PROPERTY_ATOM_PATH=1 PROPERTY_LINE_TAGS_BACKFILL=1 DATABASE_URL=... \
 *     pnpm --filter @hauska-engine/engine-core run backfill-property-line-tags-bastrop \
 *       [--parcel=48021:28286] [--gold] [--dry-run] [--limit=N] [--batch=500]
 *
 * Default (no --parcel/--gold): all 48021 boundary edges missing tags.
 * --gold: 28286, 33512, 34785 only.
 */

import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";

import postgres from "postgres";

import {
  computePropertyLineTagsFromLocalEnuEndpoints,
  PROPERTY_LINE_TAGS_ATOM_HONESTY,
} from "../src/geometry/gis-property-line-tags.ts";

const COUNTY_FIPS = "48021";
const GOLD_PROP_IDS = ["28286", "33512", "34785"];

function parseArgs(argv) {
  const out = {
    parcel: null,
    gold: false,
    dryRun: false,
    limit: null,
    batch: 500,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--parcel") out.parcel = String(argv[++i] || "").trim();
    else if (a.startsWith("--parcel=")) out.parcel = a.slice("--parcel=".length).trim();
    else if (a === "--gold") out.gold = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--limit") out.limit = Number(argv[++i] || 0) || null;
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length)) || null;
    else if (a === "--batch") out.batch = Number(argv[++i] || 500) || 500;
    else if (a.startsWith("--batch=")) out.batch = Number(a.slice("--batch=".length)) || 500;
  }
  return out;
}

function sha256HexCanonical(s) {
  return createHash("sha256").update(s).digest("hex");
}

function tagsFromBody(body) {
  const endpoints = body?.interior?.edgeEndpoints;
  if (
    !Array.isArray(endpoints) ||
    endpoints.length !== 2 ||
    !Array.isArray(endpoints[0]) ||
    !Array.isArray(endpoints[1]) ||
    endpoints[0].length !== 2 ||
    endpoints[1].length !== 2
  ) {
    return null;
  }
  return computePropertyLineTagsFromLocalEnuEndpoints(
    [Number(endpoints[0][0]), Number(endpoints[0][1])],
    [Number(endpoints[1][0]), Number(endpoints[1][1])],
  );
}

const args = parseArgs(process.argv.slice(2));
const dryRun =
  args.dryRun ||
  (process.env.BOUNDARY_PRIMITIVE_PERSIST !== "1" &&
    process.env.PROPERTY_LINE_TAGS_BACKFILL !== "1");

if (!dryRun && process.env.PROPERTY_ATOM_PATH !== "1") {
  console.error("FATAL: PROPERTY_ATOM_PATH=1 required for persist.");
  process.exit(1);
}

const substrateUrl =
  process.env.DATABASE_URL?.trim() ||
  process.env.SUBSTRATE_DATABASE_URL?.trim() ||
  process.env.CORTEX_DATABASE_URL?.trim();
if (!substrateUrl) {
  console.error("FATAL: DATABASE_URL (or SUBSTRATE_DATABASE_URL) required.");
  process.exit(1);
}

const t0 = performance.now();
const sql = postgres(substrateUrl, { ssl: "require", max: 4, prepare: false });

let rows;
if (args.parcel) {
  rows = await sql`
    SELECT entity_id, body
    FROM atoms
    WHERE entity_type = 'property-boundary-edge'
      AND body->>'parcelNodeId' = ${args.parcel}
      AND coalesce(body->>'status', 'active') = 'active'
    ORDER BY (body->>'edgeIndex')::int
  `;
} else if (args.gold) {
  const goldNodeIds = GOLD_PROP_IDS.map((p) => `${COUNTY_FIPS}:${p}`);
  rows = await sql`
    SELECT entity_id, body
    FROM atoms
    WHERE entity_type = 'property-boundary-edge'
      AND body->>'parcelNodeId' = ANY(${goldNodeIds})
      AND coalesce(body->>'status', 'active') = 'active'
    ORDER BY body->>'parcelNodeId', (body->>'edgeIndex')::int
  `;
} else {
  rows = await sql`
    SELECT entity_id, body
    FROM atoms
    WHERE entity_type = 'property-boundary-edge'
      AND body->>'countyFips' = ${COUNTY_FIPS}
      AND coalesce(body->>'status', 'active') = 'active'
      AND (
        NOT (body ? 'propertyLineTags')
        OR body->'propertyLineTags'->'provenance'->>'honesty' IS DISTINCT FROM ${PROPERTY_LINE_TAGS_ATOM_HONESTY}
      )
    ORDER BY body->>'parcelNodeId', (body->>'edgeIndex')::int
    ${args.limit ? sql`LIMIT ${args.limit}` : sql``}
  `;
}

let updated = 0;
let skipped = 0;
let missingEndpoints = 0;
const goldPaste = [];
/** @type {Array<{ entity_id: string, body: object, content_hash: string }>} */
const pending = [];

for (const row of rows) {
  const body = row.body;
  const tags = tagsFromBody(body);
  if (!tags) {
    missingEndpoints += 1;
    skipped += 1;
    continue;
  }

  const next = { ...body, propertyLineTags: tags };
  const forHash = { ...next, contentHash: "" };
  next.contentHash = sha256HexCanonical(JSON.stringify(forHash));

  const parcelNodeId = String(body.parcelNodeId ?? "");
  if (GOLD_PROP_IDS.some((p) => parcelNodeId.endsWith(`:${p}`))) {
    goldPaste.push({
      boundaryEdgeId: body.boundaryEdgeId,
      edgeIndex: body.edgeIndex,
      bearing: tags.bearing,
      distanceFeet: Number(tags.distanceFeet.toFixed(4)),
      honesty: tags.provenance.honesty,
    });
  }

  pending.push({
    entity_id: row.entity_id,
    body: next,
    content_hash: next.contentHash,
  });
  updated += 1;
}

if (!dryRun && pending.length > 0) {
  const batchSize = Math.max(25, args.batch);
  for (let i = 0; i < pending.length; i += batchSize) {
    const chunk = pending.slice(i, i + batchSize);
    await Promise.all(
      chunk.map(
        (c) => sql`
          UPDATE atoms
          SET body = ${sql.json(c.body)},
              content_hash = ${c.content_hash},
              updated_at = now()
          WHERE entity_id = ${c.entity_id}
            AND entity_type = 'property-boundary-edge'
        `,
      ),
    );
    if (i === 0 || (i / batchSize) % 5 === 0 || i + batchSize >= pending.length) {
      console.error(
        JSON.stringify({
          progress: Math.min(i + chunk.length, pending.length),
          of: pending.length,
        }),
      );
    }
  }
}

const wallMs = performance.now() - t0;
console.log(
  JSON.stringify(
    {
      dryRun,
      mode: args.parcel ? "parcel" : args.gold ? "gold" : "county-missing",
      rowsScanned: rows.length,
      updated,
      skipped,
      missingEndpoints,
      wallMsTotal: Math.round(wallMs),
      goldPasteSample: goldPaste,
    },
    null,
    2,
  ),
);

await sql.end({ timeout: 5 });
