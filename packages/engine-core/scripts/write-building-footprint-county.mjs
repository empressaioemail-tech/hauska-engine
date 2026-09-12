#!/usr/bin/env node
/**
 * write-building-footprint-county.mjs — `building-footprint` writer (T3 WS4 / ADR-029).
 *
 * Default matching path (OPS-16 A-004 / P-09): staged `tx_building_footprint`
 * + geometry-true attach. Envelope ST_Intersects is a GiST candidate prefilter
 * only; attach is footprintParcelOverlapRatio >=10% / >=50% primary.
 * Missing table, empty county, or unready geom HALT with named errors — never
 * fall back to ML zip, never emit absence atoms for an empty staged county.
 *
 *   BUILDING_FOOTPRINT_PATH=1 \
 *   CORTEX_DATABASE_URL=... \
 *   DATABASE_URL=...hauska_mcp... \
 *     pnpm --filter @hauska-engine/engine-core run write-building-footprint-county -- \
 *       --county=48021 [--apply] [--batch=500] [--limit=0] \
 *       [--fixture=path/to/ml-footprints.geojson]
 *
 * Dry-run is the default and constructs the same atoms apply would write.
 * `--fixture` / `--ml-probe-only` remain for probes; they are not the county path.
 */

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import postgres from "postgres";
import {
  createPgStorage,
  resolveSubstrateDatabaseUrl,
  takeScopedLease,
  releaseScopedLease,
} from "@hauska-engine/storage";
import {
  consumeRunIdArg,
  railLeaseArgs,
  refuseApplyOutsideCloudRunJob,
  refuseApplyWithoutRunId,
} from "./writer-apply-lease.mjs";

import {
  FOOTPRINT_WRITER_ADAPTER,
  GLOBAL_ML_TEXAS_ZIP_URL,
  ML_FOOTPRINT_SOURCE_CITATION,
  ML_FOOTPRINT_SOURCE_VINTAGE,
  STAGED_FOOTPRINT_COUNTY_EMPTY,
  STAGED_FOOTPRINT_GEOM_UNREADY,
  STAGED_FOOTPRINT_TABLE_MISSING,
  StagedFootprintError,
  assertStagedFootprintCountyReady,
  buildAtomsForBuildingFootprintPlan,
  envelopeOfRing,
  geometryOuterRing,
  loadMlFootprintsForBbox,
  planCountyBuildingFootprints,
  planCountyStagedFootprints,
  probeMlFootprintsForBbox,
  verifyStoredBuildingFootprintAtom,
} from "../src/building-footprint/index.ts";

/** Fixture / ml-probe-only only. Default county path must not call this. */
async function loadMlForFixtureOrProbe(opts) {
  if (opts.probeOnly) return probeMlFootprintsForBbox(opts);
  return loadMlFootprintsForBbox(opts);
}

function failClosedStaged(code, extra) {
  const payload = {
    event: "building-footprint-county.fail-closed",
    code,
    ...extra,
  };
  console.error(JSON.stringify(payload, null, 2));
  process.exitCode = 1;
}

function parseArgs(argv) {
  const out = {
    county: null,
    apply: false,
    batch: 500,
    limit: 0,
    out: null,
    listCounties: false,
    fixture: null,
    adapterKind: null,
    mlProbeOnly: false,
    runId: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--county") out.county = String(argv[++i] || "").trim();
    else if (a.startsWith("--county=")) out.county = a.slice("--county=".length).trim();
    else if (a === "--apply") out.apply = true;
    else if (a === "--list-counties") out.listCounties = true;
    else if (a === "--batch") out.batch = Number(argv[++i] || 500);
    else if (a.startsWith("--batch=")) out.batch = Number(a.slice("--batch=".length));
    else if (a === "--limit") out.limit = Number(argv[++i] || 0);
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length));
    else if (a === "--out") out.out = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length).trim() || null;
    else if (a === "--fixture") out.fixture = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--fixture="))
      out.fixture = a.slice("--fixture=".length).trim() || null;
    else if (a === "--adapter-kind") out.adapterKind = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--adapter-kind="))
      out.adapterKind = a.slice("--adapter-kind=".length).trim() || null;
    else if (a === "--ml-probe-only") out.mlProbeOnly = true;
    else {
      const next = consumeRunIdArg(a, argv, i, out);
      if (next !== null) i = next;
    }
  }
  return out;
}

if (process.env.BUILDING_FOOTPRINT_PATH !== "1") {
  console.error(
    "FATAL: BUILDING_FOOTPRINT_PATH=1 required (guards against an accidental invocation).",
  );
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (refuseApplyWithoutRunId("building-footprint-county.refused", args.apply, args.runId)) {
  process.exit(2);
}
// P-169 / A-132: --run-id alone is a caller-supplied string, not proof this
// process runs inside the job (the exact gap the 2026-09-07 no-execution-log
// write left open, per P-171). This checks the actual execution environment.
if (refuseApplyOutsideCloudRunJob("building-footprint-county.refused", args.apply)) {
  process.exit(2);
}

const poolUrl =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.TXGIO_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();
if (!poolUrl) {
  console.error(
    "FATAL: CORTEX_DATABASE_URL (or TXGIO_DATABASE_URL / DATABASE_URL) required — the store holding txgio_parcel.",
  );
  process.exit(1);
}

const sql = postgres(poolUrl, { max: 4, ssl: "require", prepare: false });

async function readParcelRoster() {
  return sql`
    SELECT county_fips,
           count(*)::int AS rows,
           count(DISTINCT feature_index)::int AS features,
           min(west_lng)::float8 AS west_lng,
           min(south_lat)::float8 AS south_lat,
           max(east_lng)::float8 AS east_lng,
           max(north_lat)::float8 AS north_lat
    FROM txgio_parcel
    GROUP BY county_fips
    ORDER BY county_fips
  `;
}

// Same aggregate, scoped to one county via WHERE instead of GROUP BY over
// the whole table. The unscoped roster query aggregates all 253 counties'
// rows every time even though the county path only ever reads ONE row back
// out of it -- measured in isolation at 309.7s against the live txgio_parcel
// table (a --limit=200 dry-run that only built 5 atoms still took 306.7s
// wall time, all of it this query). WHERE on the already-indexed county_fips
// column this script's own per-page parcel reads already rely on.
async function readParcelRosterForCounty(countyFips) {
  const [row] = await sql`
    SELECT county_fips,
           count(*)::int AS rows,
           count(DISTINCT feature_index)::int AS features,
           min(west_lng)::float8 AS west_lng,
           min(south_lat)::float8 AS south_lat,
           max(east_lng)::float8 AS east_lng,
           max(north_lat)::float8 AS north_lat
    FROM txgio_parcel
    WHERE county_fips = ${countyFips}
    GROUP BY county_fips
  `;
  return row ?? null;
}

if (args.listCounties) {
  try {
    const roster = await readParcelRoster();
    console.log(
      JSON.stringify(
        {
          event: "building-footprint.roster",
          source:
            "txgio_parcel bbox (read at execution time — no hardcoded allowlist)",
          defaultAdapter: "ml-global-building-footprints",
          defaultSourceTier: "ml-derived",
          countyCount: roster.length,
          counties: roster.map((r) => ({
            countyFips: r.county_fips,
            rows: r.rows,
            features: r.features,
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
    await sql.end({ timeout: 5 });
  }
  process.exit(0);
}

if (!args.county || !/^\d{5}$/.test(args.county)) {
  console.error("FATAL: --county=<5-digit FIPS> required (or --list-counties).");
  await sql.end({ timeout: 5 });
  process.exit(1);
}

const substrateUrl = resolveSubstrateDatabaseUrl();
if (args.apply && !substrateUrl) {
  console.error("FATAL: --apply requires DATABASE_URL / SUBSTRATE_DATABASE_URL (the ATOMS store).");
  await sql.end({ timeout: 5 });
  process.exit(1);
}

const handle = args.apply
  ? createPgStorage({ databaseUrl: substrateUrl, maxConnections: 8 })
  : null;

const t0 = performance.now();
const summary = {
  event: "building-footprint-county.done",
  county: args.county,
  mode: args.apply ? "apply" : "dry-run",
  storeTruth: null,
  footprint: null,
  plan: null,
  atomsBuilt: 0,
  atomsWritten: 0,
  verified: 0,
  verifyFailures: [],
  errors: 0,
  supersededAbsenceAtomsDeleted: 0,
};

try {
  const row = await readParcelRosterForCounty(args.county);
  if (!row) {
    // Fall back to the full unscoped roster only to build the diagnostic
    // "here's what IS loaded" list -- this is the rare (typo / genuinely
    // not-yet-loaded county) path, so paying the full-table aggregate cost
    // here is fine; the common, fast path above never touches it.
    const roster = await readParcelRoster();
    console.error(
      JSON.stringify({
        event: "building-footprint-county.parcels-not-loaded",
        county: args.county,
        message:
          "county has zero rows in txgio_parcel — it is NOT-YET for this rail. " +
          "Do not invent verified-absence unless a source probe documented no geometry.",
        loadedCounties: roster.map((r) => r.county_fips),
      }),
    );
    process.exitCode = 1;
  } else {
    const countyBbox = {
      westLng: row.west_lng,
      southLat: row.south_lat,
      eastLng: row.east_lng,
      northLat: row.north_lat,
    };

    summary.storeTruth = {
      parcelRows: row.rows,
      parcelFeatures: row.features,
      countyBbox,
      mlFixture: args.fixture,
      note: "read from txgio_parcel at execution time",
    };

    const parcelInputs = [];
    let lastFeature = -1;
    while (true) {
      if (args.limit > 0 && parcelInputs.length >= args.limit) break;
      const remaining =
        args.limit > 0 ? args.limit - parcelInputs.length : Math.min(args.batch, 2000);
      const pageSize = Math.max(1, Math.min(args.batch, remaining, 2000));
      const page = await sql`
        SELECT DISTINCT ON (feature_index)
               feature_index, prop_id, geometry,
               west_lng, south_lat, east_lng, north_lat
        FROM txgio_parcel
        WHERE county_fips = ${args.county}
          AND feature_index > ${lastFeature}
        ORDER BY feature_index
        LIMIT ${pageSize}
      `;
      if (page.length === 0) break;
      for (const p of page) {
        if (args.limit > 0 && parcelInputs.length >= args.limit) break;
        const ring = geometryOuterRing(p.geometry);
        const hasBbox = [p.west_lng, p.south_lat, p.east_lng, p.north_lat].every(
          (n) => Number.isFinite(Number(n)),
        );
        parcelInputs.push({
          parcelKey: p.prop_id ?? `_feature-${p.feature_index}`,
          ring,
          envelope: hasBbox
            ? {
                westLng: Number(p.west_lng),
                southLat: Number(p.south_lat),
                eastLng: Number(p.east_lng),
                northLat: Number(p.north_lat),
              }
            : ring
              ? envelopeOfRing(ring)
              : null,
        });
      }
      lastFeature = page[page.length - 1].feature_index;
      if (page.length < pageSize) break;
    }

    if (args.mlProbeOnly) {
      const mlLoad = await loadMlForFixtureOrProbe({
        bbox: countyBbox,
        probeOnly: true,
        ...(args.fixture ? { fixturePath: args.fixture } : {}),
      });
      summary.storeTruth.mlSourceLabel = mlLoad.sourceLabel;
      summary.storeTruth.mlStream = {
        partitionsStreamed: mlLoad.partitionsStreamed,
        featuresScanned: mlLoad.featuresScanned,
        featuresRead: mlLoad.featuresRead,
        peakQueueDepth: mlLoad.peakQueueDepth,
      };
      summary.footprint = {
        adapterKind: "ml-global-building-footprints",
        sourceTier: "ml-derived",
        sourceUrl: GLOBAL_ML_TEXAS_ZIP_URL,
        featuresRead: mlLoad.featuresRead,
        featuresScanned: mlLoad.featuresScanned,
        partitionsStreamed: mlLoad.partitionsStreamed,
        peakQueueDepth: mlLoad.peakQueueDepth,
        mode: "ml-probe-only",
      };
      summary.wallMs = Math.round(performance.now() - t0);
      console.log(JSON.stringify(summary, null, 2));
      if (args.out) writeFileSync(args.out, JSON.stringify(summary, null, 2));
    } else {
    let plan;
    if (args.fixture) {
      const mlLoad = await loadMlForFixtureOrProbe({
        bbox: countyBbox,
        probeOnly: false,
        fixturePath: args.fixture,
      });
      summary.storeTruth.mlSourceLabel = mlLoad.sourceLabel;
      summary.storeTruth.mlStream = {
        partitionsStreamed: mlLoad.partitionsStreamed,
        featuresScanned: mlLoad.featuresScanned,
        featuresRead: mlLoad.featuresRead,
        peakQueueDepth: mlLoad.peakQueueDepth,
      };
      plan = planCountyBuildingFootprints(parcelInputs, mlLoad.features, {
        countyFips: args.county,
        ...(args.adapterKind ? { footprintAdapterKind: args.adapterKind } : {}),
      });
    } else {
      const ready = await assertStagedFootprintCountyReady(sql, args.county);
      summary.storeTruth.stagedTable = "tx_building_footprint";
      summary.storeTruth.stagedCountyRows = ready.countyRowCount;
      summary.storeTruth.gistIndexName = ready.gistIndexName;
      summary.storeTruth.join = "geometry-true";
      summary.storeTruth.prefilter =
        "ST_Intersects(fp.geom, ST_MakeEnvelope(west,south,east,north,4326))";

      const staged = await planCountyStagedFootprints(sql, parcelInputs, {
        countyFips: args.county,
      });
      summary.storeTruth.envelopeCandidates = staged.envelopeCandidates;
      summary.storeTruth.uniqueCandidateFootprints =
        staged.uniqueCandidateFootprints;
      plan = staged.plan;
    }

    summary.footprint = {
      adapterKind: plan.route.adapterKind,
      sourceTier: plan.route.sourceTier,
      sourceUrl: plan.route.sourceUrl,
      featuresRead: plan.featuresRead,
      footprintsJoined: plan.joinStats.footprintsJoined,
      parcelsWithFootprint: plan.joinStats.parcelsWithFootprint,
      parcelsAbsentSentinel: plan.joinStats.parcelsAbsentSentinel,
      orphanRejected: plan.joinStats.orphanRejected,
      mlEmptyBbox: plan.mlEmptyBbox,
      atomsWouldWrite: plan.planned.length,
    };

    // Touch-rate: of every footprint STAGED for this county, what fraction
    // touched at least one parcel's envelope at all (regardless of whether
    // the eventual overlap-ratio attach succeeded)? This is a coverage
    // signal distinct from the present-atom ratio (present atoms / parcels):
    // a low touch-rate means the staged ML layer itself barely reaches this
    // county's parcels (a real, upstream coverage gap), whereas a low
    // present-ratio with a HIGH touch-rate would point at the join/attach
    // logic instead. Only meaningful on the staged county path -- the
    // --fixture/ml-probe path has no staged-county total to divide by.
    if (!args.fixture && summary.storeTruth.stagedCountyRows > 0) {
      summary.footprint.touchRate = {
        footprintsStagedTotal: summary.storeTruth.stagedCountyRows,
        footprintsTouchingAnyParcel: summary.storeTruth.uniqueCandidateFootprints,
        rate:
          Math.round(
            (summary.storeTruth.uniqueCandidateFootprints /
              summary.storeTruth.stagedCountyRows) *
              10000,
          ) / 10000,
      };
    }

    // P-158: absentPerParcel was one number for three causes. Denominator
    // for each count below is wouldWriteAbsentPerParcel itself (every
    // absent-per-parcel entry falls into exactly one of these three, or
    // "unsplit" when planCountyFromStagedGeometryTrueJoin was called
    // without diagnostics -- never on this county path after P-158).
    const absentPerParcelEntries = plan.planned.filter(
      (p) => p.outcome === "absent-per-parcel",
    );
    const absentByJoinOutcome = { unsplit: 0 };
    for (const entry of absentPerParcelEntries) {
      const kind = entry.joinOutcome?.kind ?? "unsplit";
      absentByJoinOutcome[kind] = (absentByJoinOutcome[kind] ?? 0) + 1;
    }

    summary.plan = {
      parcelsRead: plan.parcelsRead,
      wouldWriteTotal: plan.planned.length,
      wouldWritePresent: plan.counts.present,
      wouldWriteAbsentPerParcel: plan.counts.absentPerParcel,
      wouldWriteAbsentPerParcelByJoinOutcome: absentByJoinOutcome,
      wouldWriteCountyCoverageAbsent: plan.counts.countyCoverageAbsent,
      skippedUnusableKey: plan.counts.skippedUnusableKey,
      skippedNoRing: plan.counts.skippedNoRing,
    };

    const provenance = {
      sourceAdapter: FOOTPRINT_WRITER_ADAPTER,
      sourceCitation: ML_FOOTPRINT_SOURCE_CITATION,
      sourceUrl: GLOBAL_ML_TEXAS_ZIP_URL,
      sourceVintage: ML_FOOTPRINT_SOURCE_VINTAGE,
      observedAt: new Date().toISOString(),
      jurisdictionTenant: `tx_${args.county}`,
      verificationStatus: "machine",
    };
    const atoms = buildAtomsForBuildingFootprintPlan(plan, provenance);
    summary.atomsBuilt = atoms.length;

    if (!args.apply) {
      console.log(
        JSON.stringify({
          event: "building-footprint-county.dry-run-prediction",
          county: args.county,
          mode: "dry-run",
          storeTruth: summary.storeTruth,
          footprint: summary.footprint,
          ...summary.plan,
          atomsBuilt: atoms.length,
          sample: atoms.slice(0, 3).map((a) => ({
            atomDid: a.atomDid,
            parcelNodeId: a.parcelNodeId,
            footprintId: a.footprintId,
            entityId: a.entityId,
            sourceTier: a.sourceTier,
            absenceKind: a.absence?.kind ?? null,
            verifiedAbsence: a.verifiedAbsence?.evaluated ?? null,
          })),
          note: "every atom above was CONSTRUCTED and contract-validated; --apply persists exactly these",
        }),
      );
    } else {
      const lease = await takeScopedLease(
        handle.sql,
        railLeaseArgs({
          entityType: "building-footprint",
          countyFips: args.county,
          runId: args.runId,
          holderFallback: "building-footprint-writer",
        }),
      );
      summary.lease = {
        holder_token: lease.holder_token,
        scope: lease.scope,
        stolen_from: lease.stolen_from,
      };
      try {
      for (let i = 0; i < atoms.length; i += args.batch) {
        const slice = atoms.slice(i, i + args.batch);
        await handle.storage.writePropertyAtomsBatch(slice, lease);
        summary.atomsWritten += slice.length;

        // Look rows up by the atoms PRIMARY KEY (`atom_did`), never by the
        // `body->>'atomDid'` jsonb expression: no index serves the expression, so
        // every batch seq-scanned the whole atoms table. StoragePort upserts under
        // the canonical `did:hauska:<entityType>:<entityId>` form (body.atomDid
        // stays the contract `bfoot_<hex>` token), so the canonical did is what
        // the PK holds. `a.entityId` is the exact value written to `entity_id`.
        const dids = slice.map((a) => `did:hauska:building-footprint:${a.entityId}`);
        const stored = await handle.sql`
          SELECT body FROM atoms
          WHERE atom_did IN ${handle.sql(dids)}
        `;
        const storedByDid = new Map(stored.map((s) => [s.body?.atomDid, s.body]));
        for (const atom of slice) {
          const back = storedByDid.get(atom.atomDid);
          if (!back) {
            summary.verifyFailures.push({
              atomDid: atom.atomDid,
              problem: "atom not readable back via body->>'atomDid' after write",
            });
            continue;
          }
          const outcome =
            atom.absence || atom.sourceTier === "absent" || atom.verifiedAbsence
              ? "absent"
              : "present";
          const verdict = verifyStoredBuildingFootprintAtom(back, {
            parcelNodeId: atom.parcelNodeId,
            footprintId: atom.footprintId,
            outcome,
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
            event: "building-footprint-county.progress",
            county: args.county,
            written: summary.atomsWritten,
            verified: summary.verified,
            ofTotal: atoms.length,
          }),
        );
      }

      // Present and per-parcel-absence atoms for the SAME parcel carry
      // DIFFERENT entity_id values (`{parcelNodeId}:footprint:{footprintId}`
      // vs `{parcelNodeId}:footprint:none`, packages/atoms/src/building-footprint-writer.ts),
      // so atoms_entity_composite_unique / the ON CONFLICT (atom_did) upsert
      // does NOT collide them and does NOT supersede a stale absence atom
      // when a present one is minted for the same parcel later -- confirmed
      // live 2026-09-12: after this county's write, `48021:34049:footprint`
      // (present, new) and `48021:34049:footprint:none` (absence, from the
      // unattributed 2026-09-07 run) coexisted as two separate rows.
      // listBuildingFootprintsNearBbox already filters `body->'absence' IS
      // NULL`, so near-bbox is unaffected either way, but a facets reader
      // that walks by parcelNodeId without that filter could read either
      // row. This is a delete-and-mint supersede, scoped to entity_ids this
      // writer's own county prefix owns, deleting ONLY an absence atom that
      // now has a present sibling for the identical parcelNodeId -- never a
      // present atom, never an absence atom with no present sibling (a
      // parcel that is genuinely still absent keeps its absence atom).
      const supersededRows = await handle.sql`
        DELETE FROM atoms stale
        WHERE stale.entity_type = 'building-footprint'
          AND stale.entity_id LIKE ${args.county + ":%:footprint:none"}
          AND EXISTS (
            SELECT 1 FROM atoms present
            WHERE present.entity_type = 'building-footprint'
              AND present.body->>'parcelNodeId' = stale.body->>'parcelNodeId'
              AND NOT (present.body ? 'absence')
          )
        RETURNING stale.entity_id
      `;
      summary.supersededAbsenceAtomsDeleted = supersededRows.length;
      if (supersededRows.length > 0) {
        console.log(
          JSON.stringify({
            event: "building-footprint-county.superseded-absence-deleted",
            county: args.county,
            count: supersededRows.length,
            sample: supersededRows.slice(0, 5).map((r) => r.entity_id),
          }),
        );
      }
      } finally {
        await releaseScopedLease(handle.sql, lease);
      }
    }
    }
  }

  if (!args.mlProbeOnly) {
  summary.wallMs = Math.round(performance.now() - t0);
  console.log(JSON.stringify(summary, null, 2));
  if (args.out) {
    writeFileSync(args.out, JSON.stringify(summary, null, 2));
  }
  }
} catch (err) {
  summary.errors += 1;
  const code =
    err instanceof StagedFootprintError
      ? err.code
      : err?.code &&
          [
            STAGED_FOOTPRINT_TABLE_MISSING,
            STAGED_FOOTPRINT_COUNTY_EMPTY,
            STAGED_FOOTPRINT_GEOM_UNREADY,
          ].includes(err.code)
        ? err.code
        : null;
  if (code) {
    summary.code = code;
    summary.error = err.message ?? String(err);
    failClosedStaged(code, {
      county: args.county,
      error: summary.error,
    });
  } else {
    summary.error = String(err?.stack || err);
    console.error(JSON.stringify(summary, null, 2));
    process.exitCode = 1;
  }
} finally {
  await sql.end({ timeout: 5 });
  if (handle) await handle.close();
}
