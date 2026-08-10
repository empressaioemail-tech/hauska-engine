#!/usr/bin/env node
/**
 * W1 atom write throughput benchmark (throwaway schemas only).
 *
 * Usage:
 *   DATABASE_URL='postgres://.../hauska_mcp?sslmode=require' \
 *     node --import tsx packages/storage/scripts/benchmark-property-atom-write.mjs
 *
 * OPS-13: strips -pooler from host; fingerprints resolved host before first write.
 */

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import postgres from "postgres";

import { InProcessIpfsPin } from "../src/in-process-cache.js";
import {
  preparePropertyAtomRows,
  upsertPropertyAtomRowsMulti,
  writePropertyAtomsBatchLegacy,
} from "../src/property-atom-batch-write.js";
import { resolveSubstrateDatabaseUrl } from "../src/pg-storage.js";

const BENCHMARK_COUNTY = process.env.BENCHMARK_COUNTY_FIPS ?? "48021";
const SAMPLE_LIMIT = Number(process.env.BENCHMARK_ATOM_LIMIT ?? "8000");

function directDatabaseUrl(raw) {
  return raw.replace("-pooler.", ".");
}

function resolveHost(url) {
  const m = url.match(/@([^/]+)\//);
  return m?.[1] ?? "unknown";
}

function peakRssMb() {
  const mu = process.memoryUsage();
  return Math.round(mu.rss / (1024 * 1024));
}

async function ensureBenchSchema(sql, schema) {
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await sql.unsafe(`DROP TABLE IF EXISTS ${schema}.atoms`);
  await sql.unsafe(`CREATE TABLE ${schema}.atoms (LIKE public.atoms INCLUDING ALL)`);
}

async function loadCountyFixtures(sql, countyFips, limit) {
  const rows = await sql`
    SELECT body
    FROM public.atoms
    WHERE entity_type = 'parcel-node'
      AND body->>'countyFips' = ${countyFips}
    ORDER BY atom_did ASC
    LIMIT ${limit}
  `;
  return rows.map((r) => r.body);
}

async function benchWrite(sql, schema, fixtures, mode, batchSize) {
  await sql.unsafe(`SET search_path TO ${schema}, public`);
  await sql.unsafe(`TRUNCATE ${schema}.atoms`);

  const ipfs = new InProcessIpfsPin();
  const rssBefore = peakRssMb();
  const t0 = performance.now();

  if (mode === "legacy") {
    const chunk = 1000;
    for (let i = 0; i < fixtures.length; i += chunk) {
      await writePropertyAtomsBatchLegacy(sql, ipfs, fixtures.slice(i, i + chunk));
    }
  } else {
    const chunk = 1000;
    for (let i = 0; i < fixtures.length; i += chunk) {
      const { rows } = await preparePropertyAtomRows(
        fixtures.slice(i, i + chunk),
        ipfs,
      );
      await upsertPropertyAtomRowsMulti(sql, rows, batchSize);
    }
  }

  const elapsedSec = (performance.now() - t0) / 1000;
  const rssAfter = peakRssMb();
  const atomsPerSec = fixtures.length / elapsedSec;

  return { atomsPerSec, elapsedSec, rssBefore, rssAfter, count: fixtures.length };
}

async function main() {
  const rawUrl = resolveSubstrateDatabaseUrl();
  if (!rawUrl) {
    console.error("FATAL: DATABASE_URL / SUBSTRATE_DATABASE_URL required");
    process.exit(1);
  }

  const url = directDatabaseUrl(rawUrl);
  const host = resolveHost(url);
  console.log(
    JSON.stringify({
      event: "benchmark.host-fingerprint",
      host,
      poolerStripped: !host.includes("-pooler"),
    }),
  );
  if (host.includes("-pooler")) {
    console.error("FATAL: resolved host still contains -pooler");
    process.exit(1);
  }

  const sql = postgres(url, { ssl: "require", max: 1 });

  try {
    const fixtures = await loadCountyFixtures(sql, BENCHMARK_COUNTY, SAMPLE_LIMIT);
    if (fixtures.length === 0) {
      console.error(
        `FATAL: no parcel-node atoms for county ${BENCHMARK_COUNTY} in public.atoms`,
      );
      process.exit(1);
    }

    console.log(
      JSON.stringify({
        event: "benchmark.fixtures-loaded",
        county: BENCHMARK_COUNTY,
        count: fixtures.length,
      }),
    );

    const legacySchema = "w1_bench_legacy";
    const newSchema = "w1_bench_new";
    await ensureBenchSchema(sql, legacySchema);
    await ensureBenchSchema(sql, newSchema);

    const legacy = await benchWrite(sql, legacySchema, fixtures, "legacy");
    await sql.unsafe(`SET search_path TO public`);

    const curve = {};
    for (const batchSize of [500, 1000, 5000]) {
      const r = await benchWrite(sql, newSchema, fixtures, "multi", batchSize);
      curve[String(batchSize)] = Math.round(r.atomsPerSec);
    }

    const bestBatch = Object.entries(curve).sort((a, b) => b[1] - a[1])[0];
    const chosenBatchSize = Number(bestBatch[0]);
    const measuredAtomsPerSec = bestBatch[1];

    const report = {
      baselineAtomsPerSec: 47,
      measuredAtomsPerSec,
      batchSizeCurve: curve,
      chosenBatchSize,
      benchmarkCounty: BENCHMARK_COUNTY,
      fixtureCount: fixtures.length,
      legacyAtomsPerSec: Math.round(legacy.atomsPerSec),
      peakRssMbBefore: legacy.rssBefore,
      peakRssMbAfter: legacy.rssAfter,
      note: "legacy RSS reflects InProcessIpfsPin pre-leak-fix on old code path in same process",
    };

    console.log(JSON.stringify({ event: "benchmark.complete", ...report }, null, 2));
  } finally {
    await sql.unsafe(`DROP SCHEMA IF EXISTS w1_bench_legacy CASCADE`);
    await sql.unsafe(`DROP SCHEMA IF EXISTS w1_bench_new CASCADE`);
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
