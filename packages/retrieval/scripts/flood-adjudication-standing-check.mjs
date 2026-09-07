#!/usr/bin/env node
/**
 * FLOOD ADJUDICATION STANDING CHECK — SS-W17, PLAN-ROW P-45.
 *
 * SS-W11's `measureFloodPair` promoted. That instrument adjudicated `tier2`
 * against FEMA NFHL and is the only thing in this estate that has ever
 * adjudicated a determination against an external authority. Its subject is
 * being retired; its METHOD is what caught the defect, so the method is
 * converted onto the replacement rather than retired with the subject.
 *
 *   # offline, no database, runs in CI
 *   node --import tsx packages/retrieval/scripts/flood-adjudication-standing-check.mjs \
 *     --fixture packages/retrieval/src/flood-adjudication/__fixtures__/flood-containment-48021.json
 *
 *   # live, read-only, needs both production URLs
 *   ATOMS_DATABASE_URL=... CORTEX_DATABASE_URL=... \
 *   node --import tsx packages/retrieval/scripts/flood-adjudication-standing-check.mjs \
 *     --county 48021 [--limit 5000] [--out artifacts/ss-w17]
 *
 *   # dump the offline fixture from live data
 *   ... --county 48021 --limit 400 --dump-fixture <path>
 *
 * EXIT CODE IS THE CONTROL. Any breached band exits 1. The bands are declared
 * in src/flood-adjudication/types.ts and every one of them is zero.
 *
 * READ ONLY. No INSERT, UPDATE, DELETE or DDL. Takes no atoms writer slot.
 *
 * HEAVY-SCAN DISCIPLINE (AGENT_CONTRACT section 4). One county at a time, one
 * batch at a time, announced before and confirmed after, never in parallel.
 * Points are sorted by spatial locality before the NFHL batch so the
 * materialised zone CTE covers a neighbourhood rather than a county — the same
 * lesson SS-W11 paid for.
 */

import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

import { selectPlannableParcels } from "@hauska-engine/engine-core/flood-hazard-fact";
import { gradeFloodAdjudication } from "../src/flood-adjudication/grade.js";
import {
  ALL_LEGS,
  CODE_LEGS,
  DECLARED_BANDS,
} from "../src/flood-adjudication/types.js";

const NFHL_TABLE = "tx_fema_nfhl_flood_zone";
const RESOLVER_VERSION = "ss-w17/1.0.0";

function parseArgs(argv) {
  const out = {
    county: null,
    limit: 0,
    out: null,
    fixture: null,
    dumpFixture: null,
    batch: 500,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--county") out.county = String(argv[++i]).trim();
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--out") out.out = String(argv[++i]);
    else if (a === "--fixture") out.fixture = String(argv[++i]);
    else if (a === "--dump-fixture") out.dumpFixture = String(argv[++i]);
    else if (a === "--batch") out.batch = Number(argv[++i]);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.fixture && !out.county) {
    throw new Error("--fixture <path> or --county <fips> required");
  }
  return out;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`FATAL: ${name} is required`);
  return v.trim();
}

function writeJson(target, obj) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(obj, null, 2));
  return target;
}

function report(result, snapshot) {
  console.log(
    JSON.stringify(
      {
        event: "flood-adjudication.standing-check",
        resolverVersion: RESOLVER_VERSION,
        snapshot,
        pass: result.pass,
        scope: result.scope,
        breaches: result.breaches,
        denominators: result.denominators,
        legs: result.legs,
        containmentStates: result.containmentStates,
        zoneAdjudicationOnStandInPoint: result.zoneAdjudicationOnStandInPoint,
        bands: result.bands,
        findings: result.findings,
      },
      null,
      2,
    ),
  );
}

/* ------------------------------------------------------------------ */
/* OFFLINE — the CI leg. No database, no secrets, no network.          */
/* ------------------------------------------------------------------ */

function runFixture(fixturePath) {
  const raw = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    // An empty fixture would pass every band trivially. A check that passes on
    // its own absence is not a check.
    throw new Error(
      `FAIL CLOSED: fixture ${fixturePath} carries no cases; a check that passes on an empty population is not a check`,
    );
  }
  const result = gradeFloodAdjudication(raw.cases, CODE_LEGS, DECLARED_BANDS);
  report(result, {
    mode: "fixture",
    fixture: fixturePath,
    dumpedFrom: raw.dumpedFrom ?? "(unstated)",
    dumpedAt: raw.dumpedAt ?? "(unstated)",
    nfhlEdition: raw.nfhlEdition ?? "(unstated)",
    cases: raw.cases.length,
  });
  return result;
}

/* ------------------------------------------------------------------ */
/* LIVE — read-only against production.                                */
/* ------------------------------------------------------------------ */

/**
 * tile_key travels with every row because it is part of txgio_parcel's primary
 * key. Without it the PostGIS leg has to re-find "the" row by prop_id, and a
 * multi-row parcel then answers bool_or over rows the JS side never saw. That
 * is not a predicate divergence, it is two different questions, and it produced
 * 19 phantom divergences on this instrument's first live run.
 */
async function loadParcels(cortex, countyFips, limit) {
  const parcels = [];
  let lastFeature = -1;
  const page = limit > 0 ? Math.min(limit, 2000) : 2000;
  for (;;) {
    if (limit > 0 && parcels.length >= limit) break;
    const rows = await cortex`
      SELECT DISTINCT ON (feature_index)
             feature_index, tile_key, prop_id, geometry,
             west_lng, south_lat, east_lng, north_lat,
             (geom IS NOT NULL) AS has_geom
      FROM txgio_parcel
      WHERE county_fips = ${countyFips}
        AND feature_index > ${lastFeature}
      ORDER BY feature_index
      LIMIT ${page}
    `;
    if (rows.length === 0) break;
    for (const r of rows) {
      if (limit > 0 && parcels.length >= limit) break;
      if (!r.prop_id) continue;
      parcels.push(r);
    }
    lastFeature = rows[rows.length - 1].feature_index;
    if (rows.length < page) break;
  }
  return parcels;
}

async function loadAtoms(atoms, countyFips) {
  return atoms`
    SELECT entity_id,
           body->>'floodZone'              AS flood_zone,
           body->'absence'->>'kind'        AS absence_kind,
           body->>'sourceTier'             AS source_tier,
           body->>'samplePointContainment' AS containment,
           body->'samplePoint'             AS sample_point
    FROM atoms
    WHERE entity_type = 'flood-hazard-fact'
      AND entity_id LIKE ${countyFips + ":%"}
  `;
}

/**
 * PostGIS containment for the SAME point the JS side tested, plus the NFHL zone
 * at that point.
 *
 * Zone-major, not point-major: the zone set is materialised once per batch from
 * the batch's own bounding box, so a county-spanning NFHL polygon is detoasted
 * once rather than once per point. The float bbox prefilter is the twin of
 * `bboxContainsPoint` in the writer, and the SFHA-then-zone_row_id ordering
 * mirrors `findZoneAtPoint`; a bare LIMIT 1 would measure the planner rather
 * than the writer.
 */
async function adjudicateBatch(cortex, countyFips, chunk) {
  const ids = chunk.map((p) => p.parcelNodeId);
  const tileKeys = chunk.map((p) => p.tileKey);
  const featureIdx = chunk.map((p) => p.featureIndex);
  const lngs = chunk.map((p) => p.point[0]);
  const lats = chunk.map((p) => p.point[1]);

  return cortex`
    WITH pts AS (
      SELECT * FROM unnest(
        ${ids}::text[], ${tileKeys}::text[], ${featureIdx}::int[],
        ${lngs}::float8[], ${lats}::float8[]
      ) AS t(id, tile_key, feature_index, lng, lat)
    ),
    box AS (
      SELECT ST_Expand(ST_Extent(ST_MakePoint(lng, lat))::geometry, 0.02) AS g FROM pts
    ),
    zones AS MATERIALIZED (
      SELECT zone_row_id, fld_zone, sfha_tf, source_vintage,
             west_lng, south_lat, east_lng, north_lat, geom
      FROM ${cortex(NFHL_TABLE)}, box
      WHERE geom && box.g
    )
    SELECT p.id,
      -- The FULL primary key (county_fips, tile_key, feature_index), so PostGIS
      -- is asked about exactly the row whose geometry jsonb the JS side read.
      -- Anything looser makes the two legs answer different questions and turns
      -- a data property into a fake predicate divergence.
      (SELECT ST_Contains(tp.geom, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326))
         FROM txgio_parcel tp
        WHERE tp.county_fips = ${countyFips}
          AND tp.tile_key = p.tile_key
          AND tp.feature_index = p.feature_index
          AND tp.geom IS NOT NULL) AS postgis_contains,
      (SELECT z.fld_zone FROM zones z
        WHERE p.lng BETWEEN z.west_lng AND z.east_lng
          AND p.lat BETWEEN z.south_lat AND z.north_lat
          AND ST_Intersects(z.geom, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326))
        ORDER BY (z.sfha_tf IN ('T','t','true')) DESC, z.zone_row_id LIMIT 1) AS nfhl_zone,
      (SELECT z.source_vintage FROM zones z
        WHERE p.lng BETWEEN z.west_lng AND z.east_lng
          AND p.lat BETWEEN z.south_lat AND z.north_lat
          AND ST_Intersects(z.geom, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326))
        ORDER BY (z.sfha_tf IN ('T','t','true')) DESC, z.zone_row_id LIMIT 1) AS nfhl_edition
    FROM pts p
  `;
}

async function runLive(args) {
  const atomsUrl = requireEnv("ATOMS_DATABASE_URL");
  const cortexUrl = requireEnv("CORTEX_DATABASE_URL");
  const atoms = postgres(atomsUrl, { max: 1, prepare: false, ssl: "require" });
  const cortex = postgres(cortexUrl, { max: 1, prepare: false, ssl: "require" });

  try {
    console.error(
      `[heavy-scan] flood adjudication county ${args.county} — starting, serialized`,
    );
    const t0 = Date.now();

    const parcelRows = await loadParcels(cortex, args.county, args.limit);
    const atomRows = await loadAtoms(atoms, args.county);
    const atomById = new Map(atomRows.map((r) => [r.entity_id, r]));

    // The harness's POPULATION is the writer's population, derived by the
    // SHIPPING selection rule rather than re-implemented here. The pre-filter
    // below mirrors the key rules only so the arrays stay index-aligned, and
    // the two assertions after the call are the divergence test between this
    // filter and the shipping one: if they ever disagree the run stops rather
    // than silently adjudicating a different set of parcels than the writer
    // wrote. On the first live run this harness graded parcels the writer skips
    // (prop_id "0"), which is how a check ends up reporting a defect that the
    // writer had already handled.
    const seenKeys = new Set();
    const keptRows = [];
    let skippedUnusableKeyLocal = 0;
    for (const p of parcelRows) {
      const key = String(p.prop_id ?? "").trim();
      if (!key || /^0+$/.test(key)) {
        skippedUnusableKeyLocal += 1;
        continue;
      }
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      keptRows.push({ ...p, parcelKey: key });
    }

    const selection = selectPlannableParcels(
      keptRows.map((p) => ({
        parcelKey: p.parcelKey,
        geometry: p.geometry,
        bbox: {
          westLng: Number(p.west_lng),
          southLat: Number(p.south_lat),
          eastLng: Number(p.east_lng),
          northLat: Number(p.north_lat),
        },
      })),
    );
    if (selection.items.length !== keptRows.length) {
      throw new Error(
        `FAIL CLOSED: local key pre-filter kept ${keptRows.length} parcels and selectPlannableParcels kept ${selection.items.length}. The harness and the writer disagree about which parcels exist.`,
      );
    }
    if (selection.skippedUnusableKey !== 0) {
      throw new Error(
        `FAIL CLOSED: selectPlannableParcels skipped ${selection.skippedUnusableKey} keys the pre-filter admitted.`,
      );
    }

    const withPoints = [];
    const cases = [];
    for (let i = 0; i < keptRows.length; i++) {
      const p = keptRows[i];
      const item = selection.items[i];
      const parcelNodeId = `${args.county}:${item.parcelKey}`;
      const atom = atomById.get(parcelNodeId) ?? null;
      const storedPoint = Array.isArray(atom?.sample_point)
        ? [Number(atom.sample_point[0]), Number(atom.sample_point[1])]
        : null;
      // The atom's OWN point wins when it has one. Re-deriving over a stamped
      // point would hide exactly the drift this check exists to catch.
      const point = storedPoint ?? item.centroid;
      const c = {
        parcelNodeId,
        atomSamplePoint: storedPoint,
        atomContainment: atom?.containment ?? null,
        samplePointUsed: point,
        samplePointSource:
          storedPoint != null
            ? "atom-stamp"
            : point != null
              ? "re-derived"
              : "none",
        atomFloodZone: atom?.flood_zone ?? null,
        atomIsAbsence:
          atom != null &&
          (atom.absence_kind != null || atom.source_tier === "absent"),
        parcelGeometry: p.geometry,
        postgisContains: null,
        nfhlZoneAtSamplePoint: null,
        nfhlEdition: null,
        _hasGeom: p.has_geom === true,
        _derivation: item.samplePointDerivation,
        _writerGate: item.gate.decision,
        _writerReason: item.gate.reasonCode,
      };
      cases.push(c);
      if (point) {
        withPoints.push({
          parcelNodeId,
          tileKey: p.tile_key,
          featureIndex: p.feature_index,
          point,
          ref: c,
        });
      }
    }

    withPoints.sort((a, b) => a.point[1] - b.point[1] || a.point[0] - b.point[0]);

    for (let i = 0; i < withPoints.length; i += args.batch) {
      const chunk = withPoints.slice(i, i + args.batch);
      const rows = await adjudicateBatch(cortex, args.county, chunk);
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const item of chunk) {
        const r = byId.get(item.parcelNodeId);
        if (!r) continue;
        item.ref.postgisContains =
          r.postgis_contains == null ? null : Boolean(r.postgis_contains);
        item.ref.nfhlZoneAtSamplePoint = r.nfhl_zone ?? null;
        item.ref.nfhlEdition = r.nfhl_edition ?? null;
      }
      console.error(
        `  adjudicated ${Math.min(i + args.batch, withPoints.length)}/${withPoints.length}`,
      );
    }

    // Diagnostic tallies that are NOT graded, kept beside the graded legs so a
    // reader can see the shape of the population the bands were applied to.
    const derivationTally = {};
    const writerGateTally = {};
    let atomsMissing = 0;
    for (const c of cases) {
      derivationTally[c._derivation] = (derivationTally[c._derivation] ?? 0) + 1;
      const gk = `${c._writerGate}:${c._writerReason}`;
      writerGateTally[gk] = (writerGateTally[gk] ?? 0) + 1;
      if (!atomById.has(c.parcelNodeId)) atomsMissing += 1;
    }

    const graded = cases.map((c) => {
      const { _hasGeom, _derivation, _writerGate, _writerReason, ...rest } = c;
      void _hasGeom;
      void _derivation;
      void _writerGate;
      void _writerReason;
      return rest;
    });

    const result = gradeFloodAdjudication(graded, ALL_LEGS, DECLARED_BANDS);
    const snapshot = {
      mode: "live",
      county: args.county,
      parcelFeaturesRead: parcelRows.length,
      plannableParcels: keptRows.length,
      skippedUnusableKey: skippedUnusableKeyLocal,
      parcelLimit: args.limit || "(no limit)",
      floodAtomsFound: atomRows.length,
      parcelsWithNoFloodAtom: atomsMissing,
      parcelsWithPostgisGeom: cases.filter((c) => c._hasGeom).length,
      samplePointDerivation: derivationTally,
      writerContainmentGate: writerGateTally,
      elapsedMs: Date.now() - t0,
      countingRule:
        "one case per PLANNABLE parcel: DISTINCT ON (feature_index) rows of txgio_parcel capped by --limit, then the writer's own key rules applied (blank and all-zero prop_id skipped, first occurrence of a key wins). parcelFeaturesRead is the pre-filter count and plannableParcels is the graded population; both are reported rather than one being derived from the other. Not a county-complete figure unless --limit is absent.",
    };
    report(result, snapshot);
    console.error(
      `[heavy-scan] flood adjudication county ${args.county} — done in ${Date.now() - t0} ms`,
    );

    if (args.out) {
      writeJson(path.join(args.out, `flood-adjudication-${args.county}.json`), {
        resolverVersion: RESOLVER_VERSION,
        snapshot,
        result,
      });
    }

    if (args.dumpFixture) {
      // The fixture records the POSTGIS answers as expectations. The offline
      // grade then runs the JS implementation against them, which makes the CI
      // job a genuine cross-implementation divergence test rather than a
      // replay of one implementation against itself.
      writeJson(args.dumpFixture, {
        note: "Offline fixture for the flood containment standing check. Rings and PostGIS verdicts are REAL, dumped from production; the offline grade runs the JS implementation against the PostGIS expectations recorded here.",
        dumpedFrom: `txgio_parcel + ${NFHL_TABLE}, county ${args.county}`,
        dumpedAt: new Date().toISOString(),
        nfhlEdition: cases.find((c) => c.nfhlEdition)?.nfhlEdition ?? null,
        resolverVersion: RESOLVER_VERSION,
        cases: graded,
      });
      console.error(`wrote fixture ${args.dumpFixture} (${graded.length} cases)`);
    }

    return result;
  } finally {
    await atoms.end({ timeout: 5 });
    await cortex.end({ timeout: 5 });
  }
}

const args = parseArgs(process.argv);
const result = args.fixture ? runFixture(args.fixture) : await runLive(args);
if (!result.pass) {
  console.error("FLOOD ADJUDICATION STANDING CHECK FAILED");
  for (const b of result.breaches) console.error(`  - ${b}`);
  process.exit(1);
}
console.error("flood adjudication standing check: PASS");
