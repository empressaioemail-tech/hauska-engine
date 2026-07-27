#!/usr/bin/env node
/** Quick probe: provenance split + gold specimen edge labels (S2-F close evidence). */
import postgres from "postgres";
import { resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import { roadAtomToWarmSource } from "../src/road-intake/road-to-warm-source.ts";
import { labelEdgesFromRoads } from "../src/depth-warm/edgeLabeling.ts";
import { DEPTH_WARM_PROMOTION_MARKER } from "../src/depth-warm/types.ts";
import { TxgioDatabaseParcelGeometryResolver } from "../src/parcel-terrain/parcel-geometry-resolver.ts";

const url = resolveSubstrateDatabaseUrl();
if (!url) {
  console.error("FATAL: DATABASE_URL required");
  process.exit(1);
}

const txgioUrl = process.env.TXGIO_DATABASE_URL?.trim() || url;
const geomResolver = new TxgioDatabaseParcelGeometryResolver({ databaseUrl: txgioUrl });

const sql = postgres(url, { ssl: "require", max: 1, prepare: false });

const GOLD = ["48021:28286", "48021:34785", "48021:33512", "48021:104985"];

try {
  const [prov] = await sql`
    SELECT
      count(*) FILTER (WHERE body->'row'->'provenance'->>'kind' = 'county-roadway-authoritative')::int AS county_roadway_authoritative,
      count(*) FILTER (WHERE body->'row'->'provenance'->>'kind' = 'county-roadway-undefined')::int AS county_roadway_undefined,
      count(*) FILTER (WHERE body->'row'->'provenance'->>'kind' = 'county-surveyed-2016')::int AS county_surveyed_2016,
      count(*) FILTER (WHERE body->'row'->'provenance'->>'kind' = 'approximate-assumed-per-class')::int AS osm_fallback,
      count(*)::int AS total
    FROM atoms
    WHERE entity_type = 'road-node'
      AND body->>'countyFips' = '48021'
  `;

  const [depth] = await sql`
    SELECT count(*)::int AS depth_warm
    FROM atoms
    WHERE entity_type = 'buildable-envelope'
      AND body->>'parcelNodeId' LIKE '48021:%'
      AND body->>'depthWarmPromotion' = ${DEPTH_WARM_PROMOTION_MARKER}
  `;

  const [placeType] = await sql`
    SELECT count(*)::int AS place_type_universe
    FROM atoms
    WHERE entity_type = 'zoning-fact'
      AND body->>'parcelNodeId' LIKE '48021:%'
      AND NOT (body ? 'absence')
      AND split_part(body->>'district', ' ', 1) IN ('P-1','P-2','P-3','P-4','P-5')
  `;

  const roadRows = await sql`
    SELECT body FROM atoms
    WHERE entity_type = 'road-node'
      AND body->>'countyFips' = '48021'
  `;
  const roads = roadRows.map((r) => roadAtomToWarmSource(r.body)).filter(Boolean);

  const labels = {};
  for (const parcelNodeId of GOLD) {
    const geom = await geomResolver.resolve(parcelNodeId);
    const ring = geom?.ring;
    if (!ring || ring.length < 3) {
      labels[parcelNodeId] = { error: "no-ring" };
      continue;
    }
    const result = labelEdgesFromRoads({ parcelRing: ring, roads });
    if (!result.ok) {
      labels[parcelNodeId] = { error: result.decline };
      continue;
    }
    labels[parcelNodeId] = Object.fromEntries(
      result.edgeLabels
        .filter((e) => e.roadClass)
        .map((e) => [
          String(e.index),
          `${e.label}/${e.roadClass} ${e.roadProvenanceKind ?? "?"}`,
        ]),
    );
  }

  const citySample = await sql`
    SELECT body->>'roadNodeId' AS id,
           body->>'displayName' AS name,
           body->>'classification' AS classification,
           body->'row'->'provenance'->>'kind' AS provenance,
           body->'row'->'provenance'->>'countyOwner' AS owner
    FROM atoms
    WHERE entity_type = 'road-node'
      AND body->'row'->'provenance'->>'kind' = 'county-roadway-authoritative'
      AND body->'row'->'provenance'->>'countyOwner' = 'City'
    LIMIT 1
  `;

  console.log(
    JSON.stringify(
      {
        when: new Date().toISOString(),
        provenance: prov,
        tally: {
          roads: prov.total,
          depth_warm: depth.depth_warm,
          place_type_universe: placeType.place_type_universe,
          depth_ratio: placeType.place_type_universe
            ? depth.depth_warm / placeType.place_type_universe
            : null,
        },
        gold_labels: labels,
        city_owned_sample: citySample[0] ?? null,
        roads_loaded_for_labeling: roads.length,
      },
      null,
      2,
    ),
  );
} finally {
  await sql.end();
}
