#!/usr/bin/env node
/**
 * write-road-node-county.mjs — Rail roads `road-node` county writer.
 *
 * Loads county boundary from `tx_county_boundary`, extracts highways from the
 * pinned Geofabrik Texas PBF via extract_highways.py, plans `{countyFips}:road:{osmWayId}`
 * atoms, reconciles PBF-scoped orphans, and applies via supersede-aware
 * writeRoadAtomsBatch with PK atom_did write-then-verify.
 *
 *   ROAD_NODE_COUNTY_PATH=1 \
 *   CORTEX_DATABASE_URL=...ldt... \
 *   DATABASE_URL=...hauska_mcp... \
 *     pnpm --filter @hauska-engine/engine-core run write-road-node-county -- \
 *       --county=48021 [--pbf=path/to/texas-latest.osm.pbf] [--apply] [--batch=100] [--limit=0] [--out=path.json]
 *
 * DRY RUN IS THE DEFAULT and predicts apply counts. Apply additionally requires
 * PROPERTY_ATOM_PATH=1, ROAD_PBF_APPLY=1, and a direct (non-pooler) substrate URL.
 */

import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import {
  GEOFABRIK_TEXAS_PBF_URL,
  parseOsmWayElement,
} from "../src/road-intake/index.ts";
import { retireRoadNodeBody } from "../src/road-intake/road-supersede.ts";

import {
  assertNoActivePbfOrphans,
  buildAtomsForPlan,
  descriptorForCountyRoadRun,
  planCountyRoadNodes,
  reconcileCountyRoadNodes,
  verifyStoredRoadNodeAtom,
} from "../src/road-node/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const WORKER = join(REPO_ROOT, "artifacts/roads-pbf-worker/extract_highways.py");
const PINNED_MD5 = "4dd27afd6bc1c654f9b9635b709cf424";

function parseArgs(argv) {
  const out = {
    county: null,
    apply: false,
    batch: Number(process.env.ROAD_INGEST_BATCH || 100),
    limit: Number(process.env.ROAD_INGEST_LIMIT || 0),
    out: null,
    listCounties: false,
    pbf: process.env.ROADS_PBF_PATH?.trim() || null,
    workDir: null,
    skipExtract: false,
    ndjson: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--county") out.county = String(argv[++i] || "").trim();
    else if (a.startsWith("--county=")) out.county = a.slice("--county=".length).trim();
    else if (a === "--apply") out.apply = true;
    else if (a === "--list-counties") out.listCounties = true;
    else if (a === "--batch") out.batch = Number(argv[++i] || 100);
    else if (a.startsWith("--batch=")) out.batch = Number(a.slice("--batch=".length));
    else if (a === "--limit") out.limit = Number(argv[++i] || 0);
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length));
    else if (a === "--out") out.out = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length).trim() || null;
    else if (a === "--pbf") out.pbf = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--pbf=")) out.pbf = a.slice("--pbf=".length).trim() || null;
    else if (a === "--work-dir") out.workDir = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--work-dir=")) out.workDir = a.slice("--work-dir=".length).trim() || null;
    else if (a === "--ndjson") out.ndjson = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--ndjson=")) out.ndjson = a.slice("--ndjson=".length).trim() || null;
    else if (a === "--skip-extract") out.skipExtract = true;
  }
  return out;
}

function resolvePython() {
  return (
    process.env.ROADS_PBF_PYTHON?.trim() ||
    process.env.HYDROLOGY_PYTHON?.trim() ||
    (process.platform === "win32" ? "python" : "python3")
  );
}

function runWorker({ python, pbf, countyGeojson, outNdjson, reportJson, expectedMd5 }) {
  return new Promise((resolvePromise, reject) => {
    const args = [
      WORKER,
      "--pbf",
      pbf,
      "--county-geojson",
      countyGeojson,
      "--out-ndjson",
      outNdjson,
      "--report-json",
      reportJson,
      "--expected-md5",
      expectedMd5,
      "--pbf-url",
      GEOFABRIK_TEXAS_PBF_URL,
    ];
    const child = spawn(python, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (c) => {
      const s = c.toString("utf8");
      stderr += s;
      process.stderr.write(s);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `roads-pbf-worker exited ${code}\nstderr tail:\n${stderr.slice(-2000)}`,
          ),
        );
        return;
      }
      resolvePromise(undefined);
    });
  });
}

function countyBoundaryToGeoJson(row) {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          countyFips: row.county_fips,
          countyName: row.county_name,
        },
        geometry: row.geometry,
      },
    ],
  };
}

if (process.env.ROAD_NODE_COUNTY_PATH !== "1") {
  console.error("FATAL: ROAD_NODE_COUNTY_PATH=1 required (guards against accidental invocation).");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

const cortexUrl =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.TXGIO_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();
if (!cortexUrl) {
  console.error(
    "FATAL: CORTEX_DATABASE_URL required — store holding tx_county_boundary.",
  );
  process.exit(1);
}

const cortexSql = postgres(cortexUrl, { max: 4, ssl: "require", prepare: false });

async function readCountyRosterFromStore() {
  return cortexSql`
    SELECT county_fips, county_name,
           west_lng::float8 AS west_lng, south_lat::float8 AS south_lat,
           east_lng::float8 AS east_lng, north_lat::float8 AS north_lat
    FROM tx_county_boundary
    WHERE state_fips = '48'
    ORDER BY county_fips
  `;
}

async function loadCountyBoundary(countyFips) {
  const rows = await cortexSql`
    SELECT county_fips, county_name, geometry,
           west_lng::float8 AS west_lng, south_lat::float8 AS south_lat,
           east_lng::float8 AS east_lng, north_lat::float8 AS north_lat
    FROM tx_county_boundary
    WHERE state_fips = '48' AND county_fips = ${countyFips}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function readPriorActiveRoadNodes(sql, countyFips) {
  const rows = await sql`
    SELECT body
    FROM atoms
    WHERE entity_type = 'road-node'
      AND body->>'countyFips' = ${countyFips}
  `;
  return rows.map((r) => ({
    roadNodeId: r.body?.roadNodeId,
    osmWayId: Number(r.body?.osmWayId),
    sourceAdapter: r.body?.sourceAdapter ?? "",
    status: r.body?.status === "retired" ? "retired" : "active",
  }));
}

if (args.listCounties) {
  try {
    const roster = await readCountyRosterFromStore();
    console.log(
      JSON.stringify(
        {
          event: "road-node.roster",
          source: "tx_county_boundary (read at execution time)",
          countyCount: roster.length,
          counties: roster.map((r) => ({
            countyFips: r.county_fips,
            countyName: r.county_name,
            bbox: {
              westLng: r.west_lng,
              southLat: r.south_lat,
              eastLng: r.east_lng,
              northLat: r.north_lat,
            },
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    await cortexSql.end({ timeout: 5 });
  }
  process.exit(0);
}

if (!args.county || !/^\d{5}$/.test(args.county)) {
  console.error("FATAL: --county=<5-digit FIPS> required (or --list-counties).");
  await cortexSql.end({ timeout: 5 });
  process.exit(1);
}

if (args.apply) {
  if (process.env.PROPERTY_ATOM_PATH !== "1") {
    console.error("FATAL: --apply requires PROPERTY_ATOM_PATH=1");
    process.exit(1);
  }
  if (process.env.ROAD_PBF_APPLY !== "1") {
    console.error("FATAL: --apply requires ROAD_PBF_APPLY=1");
    process.exit(1);
  }
}

const substrateUrl = resolveSubstrateDatabaseUrl();
if (args.apply && !substrateUrl) {
  console.error("FATAL: --apply requires DATABASE_URL / SUBSTRATE_DATABASE_URL (the ATOMS store).");
  await cortexSql.end({ timeout: 5 });
  process.exit(1);
}
if (args.apply && substrateUrl.includes("-pooler.")) {
  console.error("FATAL: refuse pooler DATABASE_URL for apply; use direct Neon host");
  process.exit(1);
}

const handle = args.apply
  ? createPgStorage({ databaseUrl: substrateUrl, maxConnections: 8 })
  : null;

const t0 = performance.now();
const summary = {
  event: "road-node-county.done",
  county: args.county,
  mode: args.apply ? "apply" : "dry-run",
  storeTruth: null,
  extract: null,
  plan: null,
  reconcile: null,
  atomsBuilt: 0,
  atomsWritten: 0,
  atomsSkippedProtected: 0,
  verified: 0,
  orphansRetired: 0,
  collisionCandidates: [],
  verifyFailures: [],
  errors: 0,
};

try {
  const boundary = await loadCountyBoundary(args.county);
  if (!boundary) {
    console.error(
      JSON.stringify({
        event: "road-node-county.boundary-not-loaded",
        county: args.county,
        message: "county has no row in tx_county_boundary — NOT-YET for roads rail",
      }),
    );
    process.exitCode = 1;
  } else {
    summary.storeTruth = {
      countyFips: boundary.county_fips,
      countyName: boundary.county_name,
      bbox: {
        westLng: boundary.west_lng,
        southLat: boundary.south_lat,
        eastLng: boundary.east_lng,
        northLat: boundary.north_lat,
      },
      note: "read from tx_county_boundary at execution time",
    };

    if (!args.skipExtract && !args.pbf) {
      console.error(
        "FATAL: --pbf=<path> or ROADS_PBF_PATH required (or --skip-extract --ndjson=...)",
      );
      process.exit(1);
    }

    const workDir =
      args.workDir ||
      mkdtempSync(join(tmpdir(), `road-node-county-${args.county}-`));
    mkdirSync(workDir, { recursive: true });
    const countyGeojson = join(workDir, `${args.county}_county.geojson`);
    const outNdjson = args.ndjson || join(workDir, "highways.ndjson");
    const reportJson = join(workDir, "extract_report.json");

    writeFileSync(countyGeojson, JSON.stringify(countyBoundaryToGeoJson(boundary)));

    if (!args.skipExtract) {
      if (!existsSync(args.pbf)) {
        console.error(`FATAL: pbf missing ${args.pbf}`);
        process.exit(2);
      }
      await runWorker({
        python: resolvePython(),
        pbf: args.pbf,
        countyGeojson,
        outNdjson,
        reportJson,
        expectedMd5: PINNED_MD5,
      });
      summary.extract = JSON.parse(readFileSync(reportJson, "utf8"));
    } else if (!existsSync(outNdjson)) {
      console.error(`FATAL: --skip-extract but ndjson missing: ${outNdjson}`);
      process.exit(2);
    }

    console.log(
      JSON.stringify({
        event: "road-node-county.start",
        county: args.county,
        mode: summary.mode,
        storeTruth: summary.storeTruth,
        ndjson: outNdjson,
      }),
    );

    const extractedAt = new Date().toISOString();
    const wayInputs = [];
    let waysRead = 0;

    const rl = createInterface({
      input: createReadStream(outNdjson, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      waysRead += 1;
      if (args.limit > 0 && wayInputs.length >= args.limit) break;

      const el = JSON.parse(line);
      const hits = Array.isArray(el.countyHits) ? el.countyHits : [];
      const inCounty =
        hits.length === 0 ||
        hits.some((h) => String(h.countyFips).padStart(5, "0") === args.county);
      if (!inCounty) continue;

      const obs = parseOsmWayElement(
        { type: "way", id: el.id, tags: el.tags, geometry: el.geometry },
        extractedAt,
      );
      if (!obs) continue;

      wayInputs.push({ osmWayId: obs.osmWayId, observation: obs });
    }

    let priorRows = [];
    if (substrateUrl) {
      const reconcileHandle =
        handle ?? createPgStorage({ databaseUrl: substrateUrl, maxConnections: 2 });
      try {
        priorRows = await readPriorActiveRoadNodes(reconcileHandle.sql, args.county);
      } finally {
        if (!handle) await reconcileHandle.close();
      }
    }

    const plan = planCountyRoadNodes(wayInputs, { countyFips: args.county }, priorRows);
    summary.collisionCandidates = plan.collisionCandidates.slice(0, 20);
    summary.plan = {
      waysRead,
      waysParsed: wayInputs.length,
      wouldWriteTotal: plan.planned.length,
      ...plan.counts,
      collisionSample: plan.collisionCandidates.slice(0, 5),
    };

    if (plan.collisionCandidates.length > 0) {
      console.error(
        JSON.stringify({
          event: "road-node-county.collision-fail-closed",
          county: args.county,
          collisionCount: plan.collisionCandidates.length,
          sample: plan.collisionCandidates.slice(0, 5),
          message:
            "legacy synthetic band / prior-adapter collisions block apply until migration (48021 first)",
        }),
      );
      process.exitCode = 1;
    }

    const descriptor = descriptorForCountyRoadRun(
      args.county,
      boundary.county_name,
      PINNED_MD5,
    );
    const atoms = buildAtomsForPlan(plan, descriptor);
    summary.atomsBuilt = atoms.length;

    let reconcile = null;
    let retireAtoms = [];
    if (substrateUrl) {
      const reconcileHandle =
        handle ?? createPgStorage({ databaseUrl: substrateUrl, maxConnections: 2 });
      try {
        reconcile = reconcileCountyRoadNodes(
          priorRows.map((r) => ({
            roadNodeId: r.roadNodeId,
            sourceAdapter: r.sourceAdapter,
            status: r.status,
          })),
          plan,
        );

        if (reconcile.orphans.length > 0) {
          const orphanIds = reconcile.orphans.map((o) => o.roadNodeId);
          const retiredAt = new Date().toISOString();
          for (let i = 0; i < orphanIds.length; i += 500) {
            const idSlice = orphanIds.slice(i, i + 500);
            const orphanDids = idSlice.map((id) => `did:hauska:road-node:${id}`);
            const stored = await reconcileHandle.sql`
              SELECT body FROM atoms
              WHERE atom_did IN ${reconcileHandle.sql(orphanDids)}
            `;
            for (const s of stored) {
              const orphan = reconcile.orphans.find(
                (o) => o.roadNodeId === s.body?.roadNodeId,
              );
              if (!orphan) continue;
              retireAtoms.push(
                retireRoadNodeBody(s.body, orphan.reason, retiredAt),
              );
            }
          }
        }

        summary.reconcile = {
          priorActive: reconcile.priorActive,
          priorPbfActive: reconcile.priorPbfActive,
          plannedIds: reconcile.plannedIds,
          ...reconcile.counts,
          orphanSample: reconcile.orphans.slice(0, 5),
          retireAtomsBuilt: retireAtoms.length,
        };
      } finally {
        if (!handle) await reconcileHandle.close();
      }
    } else {
      summary.reconcile = {
        skipped: true,
        reason:
          "no DATABASE_URL / SUBSTRATE_DATABASE_URL configured; prior active set unknown",
      };
    }

    if (!args.apply) {
      console.log(
        JSON.stringify({
          event: "road-node-county.dry-run-prediction",
          county: args.county,
          ...summary.plan,
          atomsBuilt: atoms.length,
          reconcile: summary.reconcile,
          sample: atoms.slice(0, 3).map((a) => ({
            atomDid: a.atomDid,
            entityId: a.entityId,
            roadNodeId: a.roadNodeId,
            osmWayId: a.osmWayId,
            sourceAdapter: a.sourceAdapter,
          })),
          note:
            "every atom above was CONSTRUCTED via emitRoadNode; --apply persists via writeRoadAtomsBatch with supersede",
        }),
      );
    } else {
      const plannedIds = new Set(plan.planned.map((p) => p.roadNodeId));

      for (let i = 0; i < atoms.length; i += args.batch) {
        const slice = atoms.slice(i, i + args.batch);
        const before = slice.length;
        await handle.storage.writeRoadAtomsBatch(slice);
        summary.atomsWritten += slice.length;

        const dids = slice.map((a) => a.atomDid);
        const stored = await handle.sql`
          SELECT body FROM atoms
          WHERE atom_did IN ${handle.sql(dids)}
        `;
        const storedByDid = new Map(stored.map((s) => [s.body?.atomDid, s.body]));
        for (const atom of slice) {
          const back = storedByDid.get(atom.atomDid);
          if (!back) {
            summary.verifyFailures.push({
              roadNodeId: atom.roadNodeId,
              problem: "atom not readable back via atom_did column after write",
            });
            continue;
          }
          const verdict = verifyStoredRoadNodeAtom(back, {
            roadNodeId: atom.roadNodeId,
            entityId: atom.entityId,
            atomDid: atom.atomDid,
          });
          if (verdict.ok) summary.verified += 1;
          else summary.verifyFailures.push(verdict);
        }

        if (summary.verifyFailures.length > 0) {
          throw new Error(
            `write-then-verify FAILED on ${summary.verifyFailures.length} atom(s); ` +
              `first: ${JSON.stringify(summary.verifyFailures[0])}`,
          );
        }

        console.log(
          JSON.stringify({
            event: "road-node-county.progress",
            county: args.county,
            batchSize: before,
            written: summary.atomsWritten,
            verified: summary.verified,
            ofTotal: atoms.length,
          }),
        );
      }

      if (retireAtoms.length > 0) {
        for (let i = 0; i < retireAtoms.length; i += args.batch) {
          const slice = retireAtoms.slice(i, i + args.batch);
          await handle.storage.writeRoadAtomsBatch(slice);
          summary.orphansRetired += slice.length;
        }
        console.log(
          JSON.stringify({
            event: "road-node-county.orphans-retired",
            county: args.county,
            retired: summary.orphansRetired,
          }),
        );
      }

      if (reconcile) {
        const remaining = await handle.sql`
          SELECT body->>'roadNodeId' AS road_node_id,
                 body->>'sourceAdapter' AS source_adapter
          FROM atoms
          WHERE entity_type = 'road-node'
            AND body->>'countyFips' = ${args.county}
            AND coalesce(body->>'status', 'active') <> 'retired'
        `;
        const verdict = assertNoActivePbfOrphans(
          reconcile,
          plannedIds,
          remaining.map((r) => ({
            roadNodeId: r.road_node_id,
            sourceAdapter: r.source_adapter,
          })),
        );
        summary.orphanVerdict = verdict;
        if (!verdict.ok) {
          throw new Error(
            `PBF ORPHAN RETIREMENT FAILED: ${verdict.problem}; ` +
              `still active: ${JSON.stringify(verdict.stillActivePbfOrphans)}`,
          );
        }
      }
    }
  }

  summary.wallMs = Math.round(performance.now() - t0);
  console.log(JSON.stringify(summary, null, 2));
  if (args.out) {
    writeFileSync(args.out, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ event: "road-node-county.artifact", path: args.out }));
  }
} catch (err) {
  summary.errors += 1;
  summary.error = String(err?.stack || err);
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  await cortexSql.end({ timeout: 5 });
  if (handle) await handle.close();
}
