#!/usr/bin/env node
/**
 * STATEWIDE SERVING SWEEP — lane SS-W5, PLAN-ROW P-43.
 *
 *   node --import tsx packages/retrieval/scripts/serving-sweep.mjs --county 48021
 *
 * Answers "what does Smart Site actually SERVE a human, for every parcel in
 * this county", by running the REAL serving transforms (vendored verbatim from
 * hauska-map, see src/serving-sweep/vendor/README.md) over a bulk read of the
 * two stores the serving path reads.
 *
 * IT NEVER SAMPLES. Every parcel on the county roster is resolved. Sampling is
 * what certified a broken Bastrop once.
 *
 * READ ONLY. This script issues no INSERT, UPDATE, DELETE or DDL against
 * either database and takes no atoms writer slot.
 *
 * HEAVY-SCAN DISCIPLINE (AGENT_CONTRACT section 4): one county at a time, one
 * batch at a time, never two counties in parallel. Every query is either an
 * index-only probe on a bounded id list or one county-scoped prefix range. The
 * progress artifact named by --progress is written after every batch and every
 * county, so a stall is detected by PROGRESS, not by process existence.
 *
 * DENOMINATORS ARE MEASURED, NEVER SUBTRACTED (DEV_PROCESS 1.3). The county
 * roster is the UNION of two independently measured id sets — baked Tier-1
 * snapshots and `parcel-node` atoms — and both cardinalities are reported
 * beside the union so a reader can see the disagreement instead of inheriting
 * one side of it.
 */

import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

import {
  assembleChain,
  dedupeParcelAtoms,
} from "../src/serving-sweep/chain-assembly.js";
import { composeServedResponse } from "../src/serving-sweep/bff-flow.js";
import { projectSheet } from "../src/serving-sweep/project-sheet.js";
import { CountySweepAccumulator } from "../src/serving-sweep/tally.js";

const TIER1 = "node-facets:tier1";
const TIER2 = "node-facets:tier2";

/**
 * Atom types the sweep reads. `cad-parcel-roll` is handled by a separate
 * county-scoped query because its entity_id carries a `:taxYear` suffix and it
 * is not on the serving path at all — it is the upstream the address
 * contradiction is measured against.
 */
const SWEPT_ATOM_TYPES = [
  "zoning-fact",
  "setback-rule",
  "buildable-envelope",
  "flood-hazard-fact",
  "parcel-node",
  "parcel-terrain-model",
];

/**
 * RESOLVER VERSION. Bump on any change that could move a number. The suffixes
 * name this sweep's two declared deviations from the live path so they travel
 * with every record, per DEV_PROCESS 2.1 (an instrument's exclusion set is part
 * of its contract and must be stated where its output is read).
 */
const RESOLVER_VERSION =
  "ss-w5/1.0.0+atomPath=1+vendor=hauska-map@d3510a6+noCalibrationOverlay+geojsonCountOnly";

function parseArgs(argv) {
  const out = { counties: [], batch: 500, progress: null, out: null, limit: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--county") out.counties.push(String(argv[++i]).trim());
    else if (a === "--counties") out.counties.push(...String(argv[++i]).split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--batch") out.batch = Number(argv[++i]);
    else if (a === "--progress") out.progress = String(argv[++i]);
    else if (a === "--out") out.out = String(argv[++i]);
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (out.counties.length === 0) throw new Error("--county <fips> required");
  if (!out.out) throw new Error("--out <dir> required");
  return out;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`FATAL: ${name} is required`);
  return v.trim();
}

/**
 * Re-attach a geometry STAND-IN in place of the raw envelope polygon.
 *
 * DECLARED DEVIATION, and it is behaviour-preserving by inspection rather than
 * by hope. Every read of `geojson` on the serving path is a null-ness test:
 * `adaptAtomChainToBakedFacets` tests `geojson !== undefined` and
 * `geojson !== null` and otherwise passes the value straight through, and
 * `deriveBakedCardModel` reads `hasGeometry: env?.geojson != null`. No
 * coordinate is ever inspected. So the sweep pulls a feature COUNT out of
 * Postgres instead of megabytes of coordinates per parcel, and rebuilds a
 * collection of that many empty features. `geojson-standin.test.ts` asserts
 * the substitution produces an identical served body.
 */
function reattachGeojsonStandIn(body, state, featureCount) {
  if (state === "absent") return body;
  if (state === "null") return { ...body, geojson: null };
  const n = Number.isFinite(featureCount) ? featureCount : 1;
  return {
    ...body,
    geojson: {
      type: "FeatureCollection",
      features: Array.from({ length: n }, () => ({ type: "Feature" })),
    },
  };
}

function mode(counter) {
  let best = null;
  let bestN = 0;
  for (const [k, n] of counter) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

function bump(counter, key) {
  if (key == null) return;
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

async function sweepCounty({ atoms, cortex, countyFips, batchSize, limit, onProgress }) {
  const t0 = Date.now();

  // -------------------------------------------------------------- roster
  // Two independently measured id sets. Neither is derived from the other.
  const bakedRows = await cortex`
    SELECT place_key FROM place_layer_snapshots
    WHERE adapter_key = ${TIER1} AND place_key LIKE ${"node:" + countyFips + ":%"}
  `;
  const nodeRows = await atoms`
    SELECT entity_id FROM atoms
    WHERE entity_type = 'parcel-node' AND entity_id LIKE ${countyFips + ":%"}
  `;
  const bakedIds = new Set(bakedRows.map((r) => r.place_key.slice("node:".length)));
  const nodeIds = new Set(nodeRows.map((r) => r.entity_id));
  const roster = [...new Set([...bakedIds, ...nodeIds])].sort();
  const rosterCounts = {
    bakedTier1Snapshots: bakedIds.size,
    parcelNodeAtoms: nodeIds.size,
    union: roster.length,
    inBothMeasured: [...bakedIds].filter((id) => nodeIds.has(id)).length,
  };

  const work = limit ? roster.slice(0, limit) : roster;

  // County name comes from the baked payload; a county with no baked snapshot
  // at all keeps the FIPS and says so rather than inventing a name.
  let countyName = countyFips;

  // ---------------------------------------- CAD roll situs (the upstream)
  // One county-scoped read returning ONLY the parcels whose appraisal-roll
  // record carries a legible situs. This is the evidence behind the
  // `address-absent-but-on-cad-roll` contradiction.
  const cadRows = await atoms`
    SELECT DISTINCT body->>'parcelNodeId' AS pnid
    FROM atoms
    WHERE entity_type = 'cad-parcel-roll'
      AND entity_id LIKE ${countyFips + ":%"}
      AND body->>'situsAddress' ~ '[A-Za-z0-9]'
  `;
  const cadLegibleSitus = new Set(cadRows.map((r) => r.pnid).filter(Boolean));

  const acc = new CountySweepAccumulator(countyFips, countyName, RESOLVER_VERSION);
  const srcCounters = {
    geometry: new Map(),
    situsAddress: new Map(),
    apn: new Map(),
    landUse: new Map(),
    zoning: new Map(),
    setbacks: new Map(),
    envelope: new Map(),
    flood: new Map(),
    frontage: new Map(),
  };
  const vintageCounters = {
    geometry: new Map(),
    situsAddress: new Map(),
    landUse: new Map(),
    zoning: new Map(),
    setbacks: new Map(),
    envelope: new Map(),
    flood: new Map(),
  };

  let done = 0;
  for (let i = 0; i < work.length; i += batchSize) {
    const ids = work.slice(i, i + batchSize);
    const placeKeys = ids.map((id) => `node:${id}`);
    const propIds = ids.map((id) => id.split(":")[1]);

    // ---- atoms store (index-only probe on the composite unique index)
    const atomRows = await atoms`
      SELECT entity_type, entity_id,
             (body - 'geojson') AS body,
             CASE
               WHEN NOT (body ? 'geojson') THEN 'absent'
               WHEN jsonb_typeof(body->'geojson') = 'null' THEN 'null'
               ELSE 'value'
             END AS geojson_state,
             CASE
               WHEN jsonb_typeof(body->'geojson'->'features') = 'array'
                 THEN jsonb_array_length(body->'geojson'->'features')
               ELSE NULL
             END AS geojson_features
      FROM atoms
      WHERE entity_type = ANY(${atoms.array(SWEPT_ATOM_TYPES)})
        AND entity_id = ANY(${atoms.array(ids)})
    `;

    // ---- cortex baked snapshots (tier 1 + tier 2)
    const snapRows = await cortex`
      SELECT place_key, adapter_key, payload_json, snapshot_at
      FROM place_layer_snapshots
      WHERE adapter_key = ANY(${cortex.array([TIER1, TIER2])})
        AND place_key = ANY(${cortex.array(placeKeys)})
    `;

    // ---- geometry store (centroid from the stored bbox; no polygon read)
    const geoRows = await cortex`
      SELECT prop_id, situs_address, source_vintage,
             (west_lng + east_lng) / 2.0 AS lng,
             (south_lat + north_lat) / 2.0 AS lat
      FROM txgio_parcel
      WHERE county_fips = ${countyFips} AND prop_id = ANY(${cortex.array(propIds)})
    `;

    const atomsByParcel = new Map();
    for (const r of atomRows) {
      const body = reattachGeojsonStandIn(r.body, r.geojson_state, r.geojson_features);
      const pnid = typeof body.parcelNodeId === "string" ? body.parcelNodeId : r.entity_id;
      const list = atomsByParcel.get(pnid) ?? [];
      list.push(body);
      atomsByParcel.set(pnid, list);
    }
    const tier1ByParcel = new Map();
    const tier2ByParcel = new Map();
    for (const r of snapRows) {
      const pnid = r.place_key.slice("node:".length);
      if (r.adapter_key === TIER1) tier1ByParcel.set(pnid, r);
      else tier2ByParcel.set(pnid, r);
    }
    const geoByProp = new Map();
    for (const r of geoRows) geoByProp.set(r.prop_id, r);

    for (const parcelNodeId of ids) {
      const propId = parcelNodeId.split(":")[1];
      const t1 = tier1ByParcel.get(parcelNodeId) ?? null;
      const t2 = tier2ByParcel.get(parcelNodeId) ?? null;
      const geo = geoByProp.get(propId) ?? null;
      const parcelAtoms = atomsByParcel.get(parcelNodeId) ?? [];

      const t1Payload = t1?.payload_json ?? null;
      if (t1Payload && typeof t1Payload.countyName === "string" && t1Payload.countyName.trim()) {
        countyName = t1Payload.countyName.trim();
      }

      // A parcel with no baked snapshot AND no atoms cannot be resolved at all.
      if (!t1Payload && parcelAtoms.length === 0) {
        acc.addUnresolvable();
        done += 1;
        continue;
      }

      const deduped = dedupeParcelAtoms(parcelNodeId, parcelAtoms);
      const chain = assembleChain(parcelNodeId, deduped);
      const storeTier2 = t2?.payload_json ?? null;
      const cortexBody = t1Payload
        ? {
            parcelNodeId,
            adapterKey: TIER1,
            source: "baked-snapshot",
            snapshotAt: t1.snapshot_at ? new Date(t1.snapshot_at).toISOString() : null,
            // The route serves `stripZombieEnvelopeFromFacets(payload)`, which
            // nulls the baked envelope and forces facetCoverage.envelope false.
            facets: {
              ...t1Payload,
              envelope: null,
              facetCoverage: { ...(t1Payload.facetCoverage ?? {}), envelope: false },
            },
            // Mirrors `extractTier2Overlay` in
            // legacy-design-tools/artifacts/api-server/src/routes/brokerageNodeFacets.ts:
            // a Tier-2 row with no `flood` OBJECT is treated as no overlay at
            // all, and `envelope` is nulled anti-zombie.
            tier2:
              storeTier2 && storeTier2.flood && typeof storeTier2.flood === "object"
                ? {
                    flood: storeTier2.flood,
                    envelope: null,
                    bakedAt: storeTier2.bakedAt ?? null,
                    snapshotAt: t2?.snapshot_at ? new Date(t2.snapshot_at).toISOString() : null,
                  }
                : null,
          }
        : null;

      const served = composeServedResponse({
        parcelNodeId,
        chain,
        cortex: cortexBody,
        propertyAtomPath: true,
      });

      const floodFact = deduped.find((a) => a.entityType === "flood-hazard-fact") ?? null;
      const centroid =
        geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lng)
          ? { lat: Number(geo.lat), lng: Number(geo.lng) }
          : null;

      const obs = projectSheet({
        parcelNodeId,
        servedBody: served.body,
        storeTier2Flood: storeTier2?.flood ?? null,
        floodHazardFact: floodFact,
        cadRoll: cadLegibleSitus.has(parcelNodeId)
          ? { situsAddress: "<legible on cad-parcel-roll>" }
          : null,
        centroid,
      });
      acc.add(obs, served.readPath);

      // ---- sourcesByField evidence
      const prov = t1Payload?.provenance ?? {};
      bump(srcCounters.situsAddress, prov.parcelSource ?? null);
      bump(vintageCounters.situsAddress, prov.parcelVintage ?? null);
      bump(srcCounters.landUse, prov.landUseSource ?? null);
      bump(vintageCounters.landUse, t1Payload?.baseFacts?.landUse?.vintage ?? null);
      bump(srcCounters.geometry, geo ? "txgio_parcel" : null);
      bump(vintageCounters.geometry, geo?.source_vintage ?? null);
      bump(srcCounters.apn, "parcel-node-id");
      const zf = deduped.find((a) => a.entityType === "zoning-fact");
      bump(srcCounters.zoning, zf?.sourceAdapter ?? null);
      bump(vintageCounters.zoning, zf?.versionStamp ?? null);
      const sr = deduped.find((a) => a.entityType === "setback-rule");
      bump(srcCounters.setbacks, sr?.sourceAdapter ?? null);
      bump(vintageCounters.setbacks, sr?.versionStamp ?? null);
      const be = deduped.find((a) => a.entityType === "buildable-envelope");
      bump(srcCounters.envelope, be?.sourceAdapter ?? null);
      bump(vintageCounters.envelope, be?.versionStamp ?? null);
      bump(srcCounters.flood, storeTier2?.flood?.provenance?.source ?? floodFact?.sourceTier ?? null);
      bump(vintageCounters.flood, storeTier2?.flood?.provenance?.vintage ?? floodFact?.sourceVintage ?? null);

      done += 1;
    }

    onProgress?.({
      countyFips,
      done,
      total: work.length,
      elapsedSec: Math.round((Date.now() - t0) / 1000),
    });
  }

  const sourcesByField = {};
  for (const key of Object.keys(srcCounters)) {
    const src = mode(srcCounters[key]);
    if (!src) continue;
    sourcesByField[key] = {
      source: src,
      vintage: vintageCounters[key] ? mode(vintageCounters[key]) : null,
    };
  }

  const record = acc.finish(new Date().toISOString(), sourcesByField);
  record.countyName = countyName;
  return {
    record,
    extra: acc.extra,
    rosterCounts,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  fs.mkdirSync(args.out, { recursive: true });

  const atoms = postgres(requireEnv("ATOMS_DATABASE_URL"), {
    max: 2,
    idle_timeout: 30,
    connect_timeout: 30,
    prepare: false,
  });
  const cortex = postgres(requireEnv("CORTEX_DATABASE_URL"), {
    max: 2,
    idle_timeout: 30,
    connect_timeout: 30,
    prepare: false,
  });

  const writeProgress = (payload) => {
    if (!args.progress) return;
    fs.writeFileSync(
      args.progress,
      JSON.stringify({ lane: "SS-W5", planRow: "P-43", at: new Date().toISOString(), ...payload }, null, 2) + "\n",
    );
  };

  const counties = [];
  try {
    // SERIALIZED BY CONSTRUCTION: one county at a time, awaited.
    for (const countyFips of args.counties) {
      writeProgress({ phase: "county-start", countyFips, countiesDone: counties.length });
      const result = await sweepCounty({
        atoms,
        cortex,
        countyFips,
        batchSize: args.batch,
        limit: args.limit,
        onProgress: (p) => writeProgress({ phase: "county-batch", ...p, countiesDone: counties.length }),
      });
      counties.push(result);
      const file = path.join(args.out, `county_${countyFips}.json`);
      fs.writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
      writeProgress({
        phase: "county-done",
        countyFips,
        parcels: result.record.parcelsTotal,
        elapsedSec: result.elapsedSec,
        countiesDone: counties.length,
      });
      process.stdout.write(
        `[SS-W5] ${countyFips} ${result.record.countyName}: ${result.record.parcelsTotal} parcels in ${result.elapsedSec}s -> ${file}\n`,
      );
    }
  } finally {
    await atoms.end({ timeout: 5 });
    await cortex.end({ timeout: 5 });
  }

  const statewide = {
    sweptAt: new Date().toISOString(),
    resolverVersion: RESOLVER_VERSION,
    countiesTotal: 254,
    countiesSwept: counties.length,
    parcelsTotal: counties.reduce((n, c) => n + c.record.parcelsTotal, 0),
    counties: counties.map((c) => c.record),
  };
  const statewideFile = path.join(args.out, "statewide.json");
  fs.writeFileSync(statewideFile, JSON.stringify(statewide, null, 2) + "\n");
  writeProgress({ phase: "done", countiesDone: counties.length, parcels: statewide.parcelsTotal });
  process.stdout.write(`[SS-W5] statewide record -> ${statewideFile}\n`);
}

main().catch((err) => {
  console.error("[SS-W5] FAILED:", err);
  process.exit(1);
});
