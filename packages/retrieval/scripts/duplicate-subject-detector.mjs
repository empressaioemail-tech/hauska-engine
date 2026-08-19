#!/usr/bin/env node
/**
 * DUPLICATE-SUBJECT DETECTOR — lane SS-W11, PLAN-ROW P-45.
 *
 *   node --import tsx packages/retrieval/scripts/duplicate-subject-detector.mjs \
 *     --inventory --out artifacts/ss-w11
 *
 *   node --import tsx packages/retrieval/scripts/duplicate-subject-detector.mjs \
 *     --inventory --check-registry            # exits 1 on registry/store drift
 *
 *   node --import tsx packages/retrieval/scripts/duplicate-subject-detector.mjs \
 *     --county 48021 --subject flood-zone --out artifacts/ss-w11 [--adjudicate]
 *
 * WHAT IT ANSWERS. "Which facts does the spine hold in more than one place,
 * and where those places disagree, WHY do they disagree." Flood is case one,
 * not the case list.
 *
 * READ ONLY. No INSERT, UPDATE, DELETE or DDL against either database. Takes
 * no atoms writer slot.
 *
 * HEAVY-SCAN DISCIPLINE (AGENT_CONTRACT section 4). One county at a time, one
 * batch at a time, never two in parallel. The inventory pass uses loose index
 * scans (skip-scans over an existing btree) rather than GROUP BY over 102 M
 * atom rows, because a full group-by on that table does not return.
 *
 * DENOMINATORS ARE MEASURED, NEVER SUBTRACTED (DEV_PROCESS 1.3), and every
 * rate is printed beside the population in which it is arithmetically
 * possible (DEV_PROCESS 1.1/1.2). The roster-wide rate is printed too, and
 * labelled as the one that must never be quoted alone — a 0.04% and an 8.69%
 * that turn out to be the same rate under different denominators is the
 * defect this instrument was built after.
 */

import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

import {
  SUBJECT_REGISTRY,
  OUT_OF_SCOPE_STORES,
  declaredStoreKeys,
} from "../src/duplicate-subject/subject-registry.js";
import {
  classifyEntity,
  tallyPair,
  femaTileCentre,
  approxDistanceMetres,
  isSfhaZone,
  normalizeValue,
} from "../src/duplicate-subject/classify.js";
import { isDisagreement } from "../src/duplicate-subject/types.js";

/**
 * Which way a disagreement points, and how dangerous that direction is.
 *
 * Counted over disagreements only. The asymmetry is the whole reason to report
 * it: `b-understates-hazard` means the tier2 store tells a reader the parcel is
 * OUTSIDE the special flood hazard area when the atom says it is inside.
 */
function directionTally(verdicts) {
  const out = {
    "b-understates-hazard": 0,
    "b-overstates-hazard": 0,
    "same-hazard-class-different-zone": 0,
    unclassifiable: 0,
    countingRule:
      "over DISAGREEMENTS only. SFHA membership is decided by the leading letter of the FEMA zone code " +
      "(A and V families are inside; X and D are outside). 'b-understates-hazard' = store A names an SFHA " +
      "zone and store B does not.",
  };
  const pairs = {};
  for (const v of verdicts) {
    if (!isDisagreement(v.divergence)) continue;
    const key = `${normalizeValue(v.a.value)} -> ${normalizeValue(v.b.value)}`;
    pairs[key] = (pairs[key] ?? 0) + 1;
    const sa = isSfhaZone(v.a.value);
    const sb = isSfhaZone(v.b.value);
    if (sa == null || sb == null) out.unclassifiable += 1;
    else if (sa && !sb) out["b-understates-hazard"] += 1;
    else if (!sa && sb) out["b-overstates-hazard"] += 1;
    else out["same-hazard-class-different-zone"] += 1;
  }
  out.valuePairs = Object.fromEntries(
    Object.entries(pairs).sort((x, y) => y[1] - x[1]),
  );
  return out;
}

/**
 * Where ground truth lands, per divergence class. The classifier names the
 * CAUSE of a divergence; this names the WINNER, which is what a retirement
 * decision actually needs.
 */
function truthAttribution(verdicts) {
  const out = {};
  for (const v of verdicts) {
    if (!isDisagreement(v.divergence) || v.groundTruth == null) continue;
    const bucket = (out[v.divergence] ??= { matchesA: 0, matchesB: 0, matchesBoth: 0, matchesNeither: 0 });
    const truth = normalizeValue(v.groundTruth.atSamplePointA) ?? normalizeValue(v.groundTruth.atSamplePointB);
    const a = normalizeValue(v.a.value);
    const b = normalizeValue(v.b.value);
    if (truth === a && truth === b) bucket.matchesBoth += 1;
    else if (truth === a) bucket.matchesA += 1;
    else if (truth === b) bucket.matchesB += 1;
    else bucket.matchesNeither += 1;
  }
  return {
    byClass: out,
    countingRule:
      "'truth' is the NFHL zone at store A's sample point (the parcel centroid), falling back to store B's " +
      "point when A's is null. Counted over adjudicated disagreements only.",
  };
}

const RESOLVER_VERSION = "ss-w11/1.0.0";

/* ------------------------------------------------------------------ */
/* args + env                                                          */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = {
    inventory: false,
    checkRegistry: false,
    counties: [],
    subjects: [],
    adjudicate: false,
    sampleKeys: false,
    out: null,
    batch: 2000,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--inventory") out.inventory = true;
    else if (a === "--check-registry") out.checkRegistry = true;
    else if (a === "--adjudicate") out.adjudicate = true;
    else if (a === "--sample-keys") out.sampleKeys = true;
    else if (a === "--county") out.counties.push(String(argv[++i]).trim());
    else if (a === "--counties")
      out.counties.push(...String(argv[++i]).split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--subject") out.subjects.push(String(argv[++i]).trim());
    else if (a === "--out") out.out = String(argv[++i]);
    else if (a === "--batch") out.batch = Number(argv[++i]);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.inventory && out.counties.length === 0)
    throw new Error("--inventory or --county <fips> required");
  return out;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`FATAL: ${name} is required`);
  return v.trim();
}

function writeJson(dir, name, obj) {
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

/* ------------------------------------------------------------------ */
/* PART A — inventory, DERIVED from the live stores                    */
/* ------------------------------------------------------------------ */

/**
 * Loose index scan (skip-scan) for the distinct values of an indexed column.
 * A GROUP BY over `atoms` (102 M rows / 156 GB) does not return inside any
 * usable timeout; this walks the btree and touches one row per distinct value.
 */
async function distinctViaIndex(sql, table, column) {
  const rows = await sql`
    WITH RECURSIVE t AS (
      (SELECT ${sql(column)} AS v FROM ${sql(table)} ORDER BY 1 LIMIT 1)
      UNION ALL
      SELECT (SELECT x.${sql(column)} FROM ${sql(table)} x WHERE x.${sql(column)} > t.v ORDER BY 1 LIMIT 1)
      FROM t WHERE t.v IS NOT NULL
    )
    SELECT v FROM t WHERE v IS NOT NULL ORDER BY 1
  `;
  return rows.map((r) => r.v);
}

async function runInventory({ atoms, cortex, outDir, checkRegistry, sampleKeys }) {
  const atomTypes = await distinctViaIndex(atoms, "atoms", "entity_type");
  const adapterKeys = await distinctViaIndex(cortex, "place_layer_snapshots", "adapter_key");

  // Row counts per adapter key, via the (adapter_key, place_key) unique index.
  const adapterCounts = {};
  for (const k of adapterKeys) {
    const r = await cortex`
      SELECT count(*)::bigint AS n, max(snapshot_at) AS max_snapshot
      FROM place_layer_snapshots WHERE adapter_key = ${k}
    `;
    adapterCounts[k] = { rows: Number(r[0].n), maxSnapshot: r[0].max_snapshot };
  }

  // Estimated atom rows per type. EXACT counts are avoided deliberately: a
  // count(*) per type over 102 M rows is a heavy scan per type and the
  // inventory does not need exactness, only presence and order of magnitude.
  // The estimate's basis travels with it, per DEV_PROCESS 1.2.
  const est = await atoms`
    SELECT v AS entity_type,
           round((f * (SELECT reltuples FROM pg_class WHERE relname='atoms'))::numeric)::bigint AS est_rows
    FROM (SELECT unnest(most_common_vals::text::text[]) v, unnest(most_common_freqs) f
          FROM pg_stats WHERE tablename='atoms' AND attname='entity_type') s
  `;
  const atomEstimates = Object.fromEntries(est.map((r) => [r.entity_type, Number(r.est_rows)]));

  // Sampled key sets, one row per type/adapter. OFF BY DEFAULT.
  //
  // A single `LIMIT 1` on `atoms` is an index seek, but the heap fetch has to
  // detoast a body that can carry parcel geometry, and under concurrent
  // full-table scans from another lane one of these measured 4m52s. The
  // inventory's job is the store-by-subject matrix and the drift check; the key
  // sets are diagnostic colour. So they are opt-in behind --sample-keys and
  // every probe carries its own statement_timeout: a probe that times out is
  // recorded as "not sampled", never as an empty key set. An empty result is
  // not an absence (DEV_PROCESS 4.3).
  const atomKeySets = {};
  const adapterKeySets = {};
  if (sampleKeys) {
    // Dedicated clients whose SERVER-SIDE statement_timeout enforces the budget.
    // postgres.js has no per-query timeout, and a client-side race would leave
    // the query running on the server — a "timeout" that does not stop the work
    // is not a budget.
    const atomsBounded = postgres(requireEnv("ATOMS_DATABASE_URL"), {
      max: 1,
      prepare: false,
      connection: { statement_timeout: 45_000 },
    });
    const cortexBounded = postgres(requireEnv("CORTEX_DATABASE_URL"), {
      max: 1,
      prepare: false,
      connection: { statement_timeout: 45_000 },
    });
    try {
    for (const t of atomTypes) {
      try {
        const r = await atomsBounded`
          SELECT (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(s.body) k) AS keys
          FROM (SELECT (body - 'geojson') AS body FROM atoms WHERE entity_type = ${t} LIMIT 1) s
        `;
        atomKeySets[t] = r[0]?.keys ?? [];
      } catch {
        atomKeySets[t] = "(not sampled: probe exceeded its 45 s budget)";
      }
    }
    for (const k of adapterKeys) {
      try {
        const r = await cortexBounded`
          SELECT (SELECT array_agg(kk ORDER BY kk) FROM jsonb_object_keys(s.payload_json) kk) AS keys
          FROM (SELECT payload_json FROM place_layer_snapshots WHERE adapter_key = ${k} LIMIT 1) s
        `;
        adapterKeySets[k] = r[0]?.keys ?? [];
      } catch {
        adapterKeySets[k] = "(not sampled: probe exceeded its 45 s budget)";
      }
    }
    } finally {
      await atomsBounded.end({ timeout: 5 });
      await cortexBounded.end({ timeout: 5 });
    }
  }

  // Raw cortex tables that carry a parcel-subject column.
  const rawCols = await cortex`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name IN ('txgio_parcel','cad_property','tx_fema_nfhl_flood_zone','tx_zoning_district_staging')
    ORDER BY table_name, ordinal_position
  `;
  const rawTables = {};
  for (const r of rawCols) (rawTables[r.table_name] ??= []).push(r.column_name);

  // ---- the derivation: which store keys the live stores actually expose.
  const derivedStoreKeys = new Set();
  for (const t of atomTypes) derivedStoreKeys.add(`atoms:${t}`);
  for (const k of adapterKeys) derivedStoreKeys.add(`pls:${k}`);
  for (const [tbl, cols] of Object.entries(rawTables))
    for (const c of cols) derivedStoreKeys.add(`${tbl}.${c}`);

  // ---- the divergence test against the hand-authored registry.
  //
  // A registry store key that names no live store is a DEAD DECLARATION.
  // A live atom type or adapter key that the registry neither claims nor
  // excludes is an UNCLASSIFIED STORE. Both are drift, and both exit 1.
  const declared = declaredStoreKeys();
  const excluded = new Set(OUT_OF_SCOPE_STORES.map((s) => s.storeKey));
  const suffixed = (k) => k.split("#")[0];

  const deadDeclarations = declared.filter((k) => !derivedStoreKeys.has(suffixed(k)));
  const claimed = new Set(declared.map(suffixed));
  const unclassified = [...derivedStoreKeys].filter(
    (k) =>
      !claimed.has(k) &&
      !excluded.has(k) &&
      // raw-table columns are enumerated exhaustively; only the ones the
      // registry names are subjects, the rest are not claims about a subject.
      !k.includes("."),
  );

  const duplicates = SUBJECT_REGISTRY.filter((d) => d.stores.length >= 2).map((d) => ({
    subject: d.subject,
    duplicationClass: d.duplicationClass,
    storeCount: d.stores.length,
    stores: d.stores.map((s) => s.storeKey),
    groundTruth: d.groundTruth,
  }));

  const report = {
    lane: "SS-W11",
    planRow: "P-45",
    resolverVersion: RESOLVER_VERSION,
    generatedAt: new Date().toISOString(),
    layer: "WRITTEN — atoms actually in the store, and snapshot rows actually in place_layer_snapshots. Not SCORED, not SERVED.",
    derived: {
      atomTypes,
      atomRowEstimates: {
        basis: "pg_stats.most_common_freqs x pg_class.reltuples. ESTIMATE, not a count.",
        values: atomEstimates,
      },
      adapterKeys,
      adapterCounts,
      atomKeySets: sampleKeys ? atomKeySets : "(not sampled; pass --sample-keys)",
      adapterKeySets: sampleKeys ? adapterKeySets : "(not sampled; pass --sample-keys)",
      rawTables,
    },
    duplicateSubjects: duplicates,
    outOfScopeStores: OUT_OF_SCOPE_STORES,
    registryDivergence: {
      deadDeclarations,
      unclassifiedLiveStores: unclassified,
      clean: deadDeclarations.length === 0 && unclassified.length === 0,
    },
  };

  const p = writeJson(outDir, "inventory.json", report);
  console.log(JSON.stringify(report.registryDivergence, null, 2));
  console.log(`atom types: ${atomTypes.length}  adapter keys: ${adapterKeys.length}  duplicate subjects: ${duplicates.length}`);
  if (p) console.log(`wrote ${p}`);

  if (checkRegistry && !report.registryDivergence.clean) {
    console.error("REGISTRY DRIFT — the subject registry and the live stores disagree.");
    process.exitCode = 1;
  }
  return report;
}

/* ------------------------------------------------------------------ */
/* PART B — per-county divergence for the flood-zone subject           */
/* ------------------------------------------------------------------ */

/**
 * The flood pair, measured in full for one county. Never sampled.
 *
 * Store A: `atoms.flood-hazard-fact` — parcel-centroid point-in-polygon
 *          against `tx_fema_nfhl_flood_zone`.
 * Store B: `place_layer_snapshots['node-facets:tier2'].flood` — one live FEMA
 *          point query per 0.005-degree tile CENTRE, reused across the tile.
 */
async function measureFloodPair({ atoms, cortex, countyFips, adjudicate, outDir }) {
  const t0 = Date.now();

  // ---- store B, full county. lat_rounded/lng_rounded are the parcel centroid
  // the bake computed; the tile centre is reconstructed from it.
  const bRows = await cortex`
    SELECT place_key,
           payload_json->'flood'->>'floodZone'   AS zone,
           payload_json->'flood'->>'status'      AS status,
           payload_json->'flood'->'provenance'->>'vintage' AS vintage_field,
           lat_rounded::float8 AS lat,
           lng_rounded::float8 AS lng
    FROM place_layer_snapshots
    WHERE adapter_key = 'node-facets:tier2'
      AND place_key LIKE ${"node:" + countyFips + ":%"}
  `;

  // ---- store A, full county.
  const aRows = await atoms`
    SELECT entity_id,
           body->>'floodZone'     AS zone,
           body->>'status'        AS status,
           body->>'sourceVintage' AS vintage
    FROM atoms
    WHERE entity_type = 'flood-hazard-fact'
      AND entity_id LIKE ${countyFips + ":%"}
  `;

  const bById = new Map();
  for (const r of bRows) bById.set(r.place_key.slice("node:".length), r);
  const aById = new Map();
  for (const r of aRows) aById.set(r.entity_id, r);

  const roster = [...new Set([...aById.keys(), ...bById.keys()])].sort();

  /**
   * IS THE TIER-2 VINTAGE FIELD AN EDITION AT ALL?
   *
   * Measured, not assumed. A field that only ever holds an ISO instant equal to
   * the bake's own timestamp is a bake clock, not a source edition, and
   * treating it as one is what makes the dispatch's vintage fork misfire.
   */
  const isoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
  let bVintageIsoCount = 0;
  let bVintageNonIso = new Set();
  for (const r of bRows) {
    if (r.vintage_field == null) continue;
    if (isoInstant.test(r.vintage_field)) bVintageIsoCount += 1;
    else bVintageNonIso.add(r.vintage_field);
  }

  // ---- first pass, no ground truth. Establishes agree / one-sided / disagree.
  const firstPass = [];
  const disagreeIds = [];
  for (const id of roster) {
    const a = aById.get(id);
    const b = bById.get(id);
    const ra = {
      present: a != null,
      value: a?.zone ?? null,
      edition: a?.vintage ?? null,
      samplePoint: null,
      status: a?.status ?? null,
    };
    const rb = {
      present: b != null,
      value: b?.zone ?? null,
      // DELIBERATELY null: the tier2 record carries a bake timestamp where an
      // edition belongs, and calling that an edition is the defect.
      edition: null,
      samplePoint:
        b != null && Number.isFinite(b.lat) && Number.isFinite(b.lng)
          ? { lat: b.lat, lng: b.lng }
          : null,
      status: b?.status ?? null,
    };
    const v = classifyEntity(id, ra, rb, null);
    firstPass.push(v);
    if (v.divergence === "vintage-undecidable" || v.divergence === "genuine-conflict")
      disagreeIds.push(id);
  }

  const firstTally = tallyPair({
    subject: "flood-zone",
    storeA: "atoms:flood-hazard-fact",
    storeB: "pls:node-facets:tier2",
    countyFips,
    rosterUnion: roster.length,
    rowsA: aById.size,
    rowsB: bById.size,
    verdicts: firstPass,
  });

  const result = {
    lane: "SS-W11",
    planRow: "P-45",
    subject: "flood-zone",
    countyFips,
    resolverVersion: RESOLVER_VERSION,
    generatedAt: new Date().toISOString(),
    layer: "WRITTEN",
    samplingContracts: {
      storeA:
        "parcel centroid point-in-polygon against tx_fema_nfhl_flood_zone " +
        "(packages/engine-core/scripts/write-flood-hazard-fact-county.mjs)",
      storeB:
        "one live FEMA ArcGIS MapServer/28 point query per 0.005-degree tile CENTRE, reused " +
        "across every parcel whose centroid rounds into the tile " +
        "(legacy-design-tools nodeFacetBakeTier2Cli.ts FEMA_TILE_DEG=0.005)",
    },
    tier2VintageFieldAudit: {
      rowsWithVintage: bRows.filter((r) => r.vintage_field != null).length,
      isoInstantCount: bVintageIsoCount,
      nonIsoValues: [...bVintageNonIso].slice(0, 20),
      verdict:
        bVintageNonIso.size === 0
          ? "tier2 provenance.vintage is a BAKE CLOCK, not a source edition — every value is an ISO instant"
          : "tier2 provenance.vintage carries non-instant values; inspect before classifying",
    },
    preAdjudication: firstTally,
    disagreementDirection: directionTally(firstPass),
    adjudication: null,
    elapsedMs: Date.now() - t0,
  };

  if (!adjudicate || disagreeIds.length === 0) {
    const p = writeJson(outDir, `flood-${countyFips}.json`, result);
    if (p) console.log(`wrote ${p}`);
    return result;
  }

  /* ---------------- ground-truth adjudication (PostGIS) ---------------- */
  //
  // Zone-major, not point-major: the zone set is materialised ONCE inside the
  // county bbox so the mega-polygons detoast once per query rather than once
  // per point. A point-major LATERAL over the same data is ~218x slower.

  const points = [];
  for (const id of disagreeIds) {
    const b = bById.get(id);
    if (!b || !Number.isFinite(b.lat) || !Number.isFinite(b.lng)) continue;
    const centre = femaTileCentre({ lat: b.lat, lng: b.lng });
    points.push({
      id,
      propId: id.split(":")[1],
      aLat: b.lat, // store A sampled the parcel centroid; tier2 recorded that centroid
      aLng: b.lng,
      bLat: centre.lat, // store B sampled the tile centre
      bLng: centre.lng,
      distanceM: approxDistanceMetres({ lat: b.lat, lng: b.lng }, centre),
    });
  }

  // Batch by SPATIAL LOCALITY, not by id order. The zone CTE is materialised
  // per batch from the batch's own bbox, so a batch scattered across a county
  // materialises every zone in the county while a batch drawn from one
  // neighbourhood materialises a handful. Sorting first is the difference
  // between a few zones per batch and a few thousand.
  points.sort((p, q) => p.bLat - q.bLat || p.bLng - q.bLng);

  const gtById = new Map();
  const BATCH = 500;
  for (let i = 0; i < points.length; i += BATCH) {
    const chunk = points.slice(i, i + BATCH);
    const ids = chunk.map((p) => p.id);
    const propIds = chunk.map((p) => p.propId);
    const aLats = chunk.map((p) => p.aLat);
    const aLngs = chunk.map((p) => p.aLng);
    const bLats = chunk.map((p) => p.bLat);
    const bLngs = chunk.map((p) => p.bLng);

    const rows = await cortex`
      WITH pts AS (
        SELECT * FROM unnest(
          ${ids}::text[], ${propIds}::text[],
          ${aLats}::float8[], ${aLngs}::float8[],
          ${bLats}::float8[], ${bLngs}::float8[]
        ) AS t(id, prop_id, a_lat, a_lng, b_lat, b_lng)
      ),
      box AS (
        SELECT ST_Expand(ST_Extent(ST_MakePoint(a_lng, a_lat))::geometry, 0.02) AS g FROM pts
      ),
      zones AS MATERIALIZED (
        SELECT zone_row_id, fld_zone, sfha_tf,
               west_lng, south_lat, east_lng, north_lat, geom
        FROM tx_fema_nfhl_flood_zone, box
        WHERE geom && box.g
      ),
      parcels AS (
        SELECT p.id, tp.geom
        FROM pts p
        LEFT JOIN txgio_parcel tp
          ON tp.county_fips = ${countyFips} AND tp.prop_id = p.prop_id AND tp.geom IS NOT NULL
      )
      SELECT p.id,
        -- Two things are load-bearing here.
        --
        -- The FLOAT BBOX PREFILTER (west/south/east/north are plain columns) is
        -- the twin of bboxContainsPoint in the writer, and it is what keeps this
        -- from calling ST_Intersects once per point per zone. A materialised CTE
        -- has no GiST index, so without it every point would test every zone.
        --
        -- The ORDER BY mirrors findZoneAtPoint in
        -- packages/engine-core/src/flood-hazard-fact/geo.ts:175-201: where several
        -- polygons contain the point, the SFHA one wins, else the first in
        -- zone_row_id order (the writer's own scan order). A bare LIMIT 1 would
        -- measure the planner rather than the writer.
        (SELECT z.fld_zone FROM zones z
          WHERE p.a_lng BETWEEN z.west_lng AND z.east_lng
            AND p.a_lat BETWEEN z.south_lat AND z.north_lat
            AND ST_Intersects(z.geom, ST_SetSRID(ST_MakePoint(p.a_lng, p.a_lat), 4326))
          ORDER BY (z.sfha_tf IN ('T','t','true')) DESC, z.zone_row_id LIMIT 1) AS gt_a,
        (SELECT z.fld_zone FROM zones z
          WHERE p.b_lng BETWEEN z.west_lng AND z.east_lng
            AND p.b_lat BETWEEN z.south_lat AND z.north_lat
            AND ST_Intersects(z.geom, ST_SetSRID(ST_MakePoint(p.b_lng, p.b_lat), 4326))
          ORDER BY (z.sfha_tf IN ('T','t','true')) DESC, z.zone_row_id LIMIT 1) AS gt_b,
        (SELECT array_agg(DISTINCT z.fld_zone) FROM zones z, parcels pa
          WHERE pa.id = p.id AND pa.geom IS NOT NULL
            AND z.geom && pa.geom
            AND ST_Intersects(z.geom, pa.geom)) AS zone_set,
        (SELECT pa.geom IS NOT NULL FROM parcels pa WHERE pa.id = p.id LIMIT 1) AS has_geom
      FROM pts p
    `;
    for (const r of rows) gtById.set(r.id, r);
    console.log(`  adjudicated ${Math.min(i + BATCH, points.length)}/${points.length}`);
  }

  const secondPass = [];
  const pointMeta = new Map(points.map((p) => [p.id, p]));
  for (const v of firstPass) {
    if (!gtById.has(v.entityId)) {
      secondPass.push(v);
      continue;
    }
    const g = gtById.get(v.entityId);
    const meta = pointMeta.get(v.entityId);
    const gt = {
      atSamplePointA: g.gt_a ?? null,
      atSamplePointB: g.gt_b ?? null,
      entityZoneSet: g.zone_set ?? [],
      samplePointDistanceM: meta?.distanceM ?? null,
      edition: "NFHL_48_20260101",
    };
    const rb = { ...v.b };
    secondPass.push(classifyEntity(v.entityId, v.a, rb, gt));
  }

  const finalTally = tallyPair({
    subject: "flood-zone",
    storeA: "atoms:flood-hazard-fact",
    storeB: "pls:node-facets:tier2",
    countyFips,
    rosterUnion: roster.length,
    rowsA: aById.size,
    rowsB: bById.size,
    verdicts: secondPass,
  });

  const distances = points.map((p) => p.distanceM).sort((x, y) => x - y);
  result.adjudication = {
    groundTruth: "tx_fema_nfhl_flood_zone edition NFHL_48_20260101",
    adjudicatedEntities: points.length,
    disagreementsFound: disagreeIds.length,
    // MEASURED, never derived by subtraction (DEV_PROCESS 1.3): a null zone_set
    // means EITHER no parcel geometry OR a parcel that intersects no mapped
    // zone, and those are different facts. has_geom separates them.
    parcelsWithNoGeometry: [...gtById.values()].filter((g) => g.has_geom !== true).length,
    parcelsWithGeometryButNoZoneIntersect: [...gtById.values()].filter(
      (g) => g.has_geom === true && (g.zone_set ?? null) == null,
    ).length,
    samplePointDistanceM: {
      min: distances[0] ?? null,
      median: distances[Math.floor(distances.length / 2)] ?? null,
      max: distances[distances.length - 1] ?? null,
      countingRule:
        "metres between the parcel centroid (store A's sample point, as recorded by the tier2 bake) " +
        "and the 0.005-degree tile centre (store B's sample point), over adjudicated disagreements only",
    },
    tally: finalTally,
    truthAttribution: truthAttribution(secondPass),
    // Examples PER CLASS, not the first twelve overall. The residue classes are
    // the ones the retirement decision turns on, and a head-of-list sample
    // shows only whichever class happens to sort first.
    examplesByClass: (() => {
      const out = {};
      for (const v of secondPass) {
        if (v.groundTruth == null) continue;
        (out[v.divergence] ??= []).push({
          entityId: v.entityId,
          a: v.a.value,
          b: v.b.value,
          basis: v.basis,
          groundTruthAtA: v.groundTruth.atSamplePointA,
          groundTruthAtB: v.groundTruth.atSamplePointB,
          entityZoneSet: v.groundTruth.entityZoneSet,
          samplePointDistanceM: Number((v.groundTruth.samplePointDistanceM ?? 0).toFixed(1)),
        });
      }
      for (const k of Object.keys(out)) out[k] = out[k].slice(0, 8);
      return out;
    })(),
    /**
     * A SELF-CHECK on this instrument's one declared deviation.
     *
     * Store A's sample point is not read from store A: the atom does not record
     * the point it evaluated, so the tier2 bake's recorded parcel centroid is
     * used as a stand-in. The two are computed by different ringCentroid
     * implementations in different repos. This counts how often ground truth at
     * that stand-in point reproduces store A's own value — a high rate is
     * evidence the stand-in is sound, and a low one would invalidate every
     * `explained-by-sampling-point` verdict here.
     */
    standInPointReproducesStoreA: (() => {
      let ok = 0;
      let n = 0;
      for (const v of secondPass) {
        if (v.groundTruth == null) continue;
        n += 1;
        const gtA = (v.groundTruth.atSamplePointA ?? "").toUpperCase();
        if (gtA !== "" && gtA === (v.a.value ?? "").toUpperCase()) ok += 1;
      }
      return {
        reproduced: ok,
        adjudicated: n,
        pct: n === 0 ? 0 : Number(((ok / n) * 100).toFixed(2)),
        countingRule:
          "adjudicated disagreements where the NFHL zone at the stand-in centroid equals the atom's own " +
          "recorded zone, over all adjudicated disagreements",
      };
    })(),
  };
  result.elapsedMs = Date.now() - t0;

  const p = writeJson(outDir, `flood-${countyFips}.json`, result);
  if (p) console.log(`wrote ${p}`);
  return result;
}

/* ------------------------------------------------------------------ */

async function main() {
  const args = parseArgs(process.argv);
  const atoms = postgres(requireEnv("ATOMS_DATABASE_URL"), {
    max: 2,
    idle_timeout: 20,
    connect_timeout: 30,
    prepare: false,
  });
  const cortex = postgres(requireEnv("CORTEX_DATABASE_URL"), {
    max: 2,
    idle_timeout: 20,
    connect_timeout: 30,
    prepare: false,
  });
  try {
    if (args.inventory) {
      await runInventory({
        atoms,
        cortex,
        outDir: args.out,
        checkRegistry: args.checkRegistry,
        sampleKeys: args.sampleKeys,
      });
    }
    for (const c of args.counties) {
      const wanted = args.subjects.length ? args.subjects : ["flood-zone"];
      for (const s of wanted) {
        if (s !== "flood-zone")
          throw new Error(
            `subject "${s}" has no measurement pass yet; the inventory names it, the runner does not measure it`,
          );
        console.log(`[heavy-scan] flood-zone county ${c} — starting, serialized`);
        const r = await measureFloodPair({
          atoms,
          cortex,
          countyFips: c,
          adjudicate: args.adjudicate,
          outDir: args.out,
        });
        const t = r.adjudication?.tally ?? r.preAdjudication;
        console.log(
          `[heavy-scan] flood-zone county ${c} — done in ${r.elapsedMs} ms; ` +
            `comparable ${t.comparable} of roster ${t.rosterUnion}; ` +
            `disagreements ${t.disagreementRate.numerator} = ${t.disagreementRate.pct}% of comparable ` +
            `(${t.disagreementRateOverRoster.pct}% of roster)`,
        );
        console.log(JSON.stringify(t.byClass, null, 2));
      }
    }
  } finally {
    await atoms.end({ timeout: 5 });
    await cortex.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
