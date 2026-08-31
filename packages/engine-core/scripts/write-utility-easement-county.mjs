#!/usr/bin/env node
/**
 * write-utility-easement-county.mjs — `utility-easement` writer.
 *
 * Honest-absence-heavy: most counties emit ONE county-coverage absence atom
 * with provenanceScope (never fake geometry). Present-data exceptions:
 * McLennan CAD linework (48309), City of Bastrop municipal easements
 * (--scope=city-limits on 48021).
 *
 *   UTILITY_EASEMENT_PATH=1 \
 *   CORTEX_DATABASE_URL=... \
 *   DATABASE_URL=...hauska_mcp... \
 *     pnpm --filter @hauska-engine/engine-core run write-utility-easement-county -- \
 *       --county=48021 [--scope=county|city-limits] [--apply] [--batch=500] [--limit=0]
 *
 * Dry-run is the default and constructs the same atoms apply would write.
 */

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import postgres from "postgres";
import { countyCoverageParcelNodeId } from "@empressaio/atom-contract/property";
import {
  createPgStorage,
  resolveSubstrateDatabaseUrl,
  takeScopedLease,
  releaseScopedLease,
} from "@hauska-engine/storage";
import {
  consumeRunIdArg,
  railLeaseArgs,
  refuseApplyWithoutRunId,
} from "./writer-apply-lease.mjs";

import {
  buildAtomsForUtilityEasementPlan,
  fetchCadEasementFeatures,
  geoJsonRingFromEsri,
  planCountyUtilityEasement,
  resolveCountyEasementRoute,
  verifyStoredUtilityEasementAtom,
} from "../src/utility-easement/index.ts";

const SOURCE_ADAPTER_BY_KIND = {
  "honest-absence": "honest-absence-v1",
  "cad-easement-rest": "cad-easement-rest-v1",
  "municipal-easement-rest": "municipal-easement-rest-v1",
};

function parseArgs(argv) {
  const out = {
    county: null,
    scope: "county",
    apply: false,
    batch: 500,
    limit: 0,
    out: null,
    listCounties: false,
    runId: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--county") out.county = String(argv[++i] || "").trim();
    else if (a.startsWith("--county=")) out.county = a.slice("--county=".length).trim();
    else if (a === "--scope") out.scope = String(argv[++i] || "county").trim();
    else if (a.startsWith("--scope=")) out.scope = a.slice("--scope=".length).trim();
    else if (a === "--apply") out.apply = true;
    else if (a === "--list-counties") out.listCounties = true;
    else if (a === "--batch") out.batch = Number(argv[++i] || 500);
    else if (a.startsWith("--batch=")) out.batch = Number(a.slice("--batch=".length));
    else if (a === "--limit") out.limit = Number(argv[++i] || 0);
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length));
    else if (a === "--out") out.out = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length).trim() || null;
    else {
      const next = consumeRunIdArg(a, argv, i, out);
      if (next !== null) i = next;
    }
  }
  return out;
}

if (process.env.UTILITY_EASEMENT_PATH !== "1") {
  console.error(
    "FATAL: UTILITY_EASEMENT_PATH=1 required (guards against an accidental invocation).",
  );
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (refuseApplyWithoutRunId("utility-easement-county.refused", args.apply, args.runId)) {
  process.exit(2);
}

const poolUrl =
  process.env.CORTEX_DATABASE_URL?.trim() ||
  process.env.TXGIO_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();
if (!poolUrl) {
  console.error(
    "FATAL: CORTEX_DATABASE_URL required — store holding txgio_parcel for present-data joins.",
  );
  process.exit(1);
}

const sql = postgres(poolUrl, { max: 4, ssl: "require", prepare: false });

function ringFromGeoJsonGeometry(geometry) {
  if (!geometry || typeof geometry !== "object") return null;
  if (geometry.type === "Polygon" && Array.isArray(geometry.coordinates?.[0])) {
    const ring = geometry.coordinates[0].map(([lng, lat]) => [lng, lat]);
    if (ring.length < 4) return null;
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1]]);
    }
    return ring;
  }
  return null;
}

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

async function loadParcelsWithRings(countyFips, limit) {
  const parcels = [];
  let lastFeature = -1;
  while (true) {
    if (limit > 0 && parcels.length >= limit) break;
    const remaining =
      limit > 0 ? limit - parcels.length : Math.min(args.batch, 2000);
    const pageSize = Math.max(1, Math.min(args.batch, remaining, 2000));
    const page = await sql`
      SELECT DISTINCT ON (feature_index)
             feature_index, prop_id, geometry
      FROM txgio_parcel
      WHERE county_fips = ${countyFips}
        AND feature_index > ${lastFeature}
      ORDER BY feature_index
      LIMIT ${pageSize}
    `;
    if (page.length === 0) break;
    for (const p of page) {
      if (limit > 0 && parcels.length >= limit) break;
      const propId = p.prop_id?.trim?.() ?? String(p.prop_id ?? "").trim();
      const ring = ringFromGeoJsonGeometry(p.geometry);
      if (!propId || !ring) continue;
      parcels.push({
        parcelKey: propId,
        ring,
      });
    }
    lastFeature = page[page.length - 1].feature_index;
    if (page.length < pageSize) break;
  }
  return parcels;
}

async function fetchMunicipalEasements(layerUrl, bbox) {
  return fetchCadEasementFeatures({
    serviceRootUrl: layerUrl.replace(/\/\d+$/, ""),
    layerIds: [Number(layerUrl.split("/").pop())],
    westLng: bbox.westLng,
    southLat: bbox.southLat,
    eastLng: bbox.eastLng,
    northLat: bbox.northLat,
    statusFields: ["Status", "TYPE", "EasementType"],
    docNumFields: [],
  });
}

async function fetchCityLimitParcels(route, bbox, limit) {
  const envelope = {
    xmin: bbox.westLng,
    ymin: bbox.southLat,
    xmax: bbox.eastLng,
    ymax: bbox.northLat,
    spatialReference: { wkid: 4326 },
  };
  const url = new URL(`${route.parcelLayerUrl.replace(/\/$/, "")}/query`);
  url.searchParams.set("f", "json");
  url.searchParams.set("where", "1=1");
  url.searchParams.set("geometry", JSON.stringify(envelope));
  url.searchParams.set("geometryType", "esriGeometryEnvelope");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set(
    "outFields",
    `prop_id,${route.cityField}`,
  );
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("resultRecordCount", String(limit > 0 ? limit : 500));

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": "hauska-engine/1.0 (+utility-easement-writer)",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`city parcel fetch HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) {
    throw new Error(`city parcel fetch ArcGIS error: ${body.error.message ?? "unknown"}`);
  }

  const parcels = [];
  for (const raw of body.features ?? []) {
    const attrs = raw.attributes ?? {};
    const propRaw = attrs.prop_id ?? attrs.PROP_ID;
    if (propRaw == null) continue;
    const propId = String(propRaw).trim();
    const ring = geoJsonRingFromEsri(raw.geometry);
    if (!propId || !ring) continue;
    const cityVal = attrs[route.cityField];
    parcels.push({
      parcelKey: propId,
      ring,
      inCityLimits:
        cityVal != null &&
        String(cityVal).trim().toUpperCase() === route.cityLimitsValue,
    });
  }
  return parcels;
}

if (args.listCounties) {
  try {
    const roster = await readParcelRoster();
    console.log(
      JSON.stringify(
        {
          event: "utility-easement-county.roster",
          source: "txgio_parcel bbox (execution time)",
          countyCount: roster.length,
          counties: roster.map((r) => ({
            countyFips: r.county_fips,
            rows: r.rows,
            features: r.features,
            defaultRoute: resolveCountyEasementRoute(r.county_fips).adapterKind,
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
const route = resolveCountyEasementRoute(args.county, args.scope);
const summary = {
  event: "utility-easement-county.done",
  county: args.county,
  scope: args.scope,
  mode: args.apply ? "apply" : "dry-run",
  route: {
    adapterKind: route.adapterKind,
    sourceTier: route.sourceTier,
    sourceUrl: route.sourceUrl,
  },
  storeTruth: null,
  plan: null,
  atomsBuilt: 0,
  atomsWritten: 0,
  verified: 0,
  verifyFailures: [],
  errors: 0,
};

try {
  const roster = await readParcelRoster();
  const row = roster.find((r) => r.county_fips === args.county);
  const countyBbox = row
    ? {
        westLng: row.west_lng,
        southLat: row.south_lat,
        eastLng: row.east_lng,
        northLat: row.north_lat,
      }
    : null;

  summary.storeTruth = {
    parcelRows: row?.rows ?? 0,
    parcelFeatures: row?.features ?? 0,
    countyBbox,
    countyLoaded: Boolean(row),
  };

  let parcels = [];
  let easements = [];

  if (route.adapterKind === "honest-absence") {
    // No geometry fetch — county-coverage absence only.
  } else if (route.adapterKind === "cad-easement-rest") {
    if (!countyBbox) {
      throw new Error(
        `county ${args.county} has zero rows in txgio_parcel — cannot bbox-filter CAD easements`,
      );
    }
    parcels = await loadParcelsWithRings(args.county, args.limit);
    const pad = 0.02;
    easements = await fetchCadEasementFeatures({
      serviceRootUrl: route.serviceRootUrl,
      layerIds: route.layerIds,
      westLng: countyBbox.westLng - pad,
      southLat: countyBbox.southLat - pad,
      eastLng: countyBbox.eastLng + pad,
      northLat: countyBbox.northLat + pad,
    });
    summary.storeTruth.parcelsLoaded = parcels.length;
    summary.storeTruth.easementFeaturesFetched = easements.length;
  } else if (route.adapterKind === "municipal-easement-rest") {
    if (!countyBbox) {
      throw new Error(
        `county ${args.county} has zero rows in txgio_parcel — cannot derive municipal bbox`,
      );
    }
    const pad = 0.005;
    const bbox = {
      westLng: countyBbox.westLng - pad,
      southLat: countyBbox.southLat - pad,
      eastLng: countyBbox.eastLng + pad,
      northLat: countyBbox.northLat + pad,
    };
    parcels = await fetchCityLimitParcels(route, bbox, args.limit);
    easements = await fetchMunicipalEasements(route.layerUrl, bbox);
    summary.storeTruth.parcelsLoaded = parcels.length;
    summary.storeTruth.easementFeaturesFetched = easements.length;
  }

  const plan = planCountyUtilityEasement({
    countyFips: args.county,
    scope: args.scope,
    parcels,
    easements,
  });

  summary.plan = {
    adapterKind: plan.route.adapterKind,
    sourceTier: plan.route.sourceTier,
    parcelsRead: plan.parcelsRead,
    easementFeaturesRead: plan.easementFeaturesRead,
    wouldWriteTotal: plan.planned.length,
    wouldWriteCountyCoverage: plan.counts.countyCoverageAbsence,
    wouldWritePresent: plan.counts.present,
    wouldWritePerParcelAbsence: plan.counts.perParcelAbsence,
    skippedUnusableKey: plan.counts.skippedUnusableKey,
  };

  const sourceAdapter = SOURCE_ADAPTER_BY_KIND[plan.route.adapterKind] ?? plan.route.adapterKind;
  const provenance = {
    sourceAdapter,
    sourceCitation: plan.route.sourceUrl
      ? `${plan.route.adapterKind} ${plan.route.sourceUrl} (${args.county} scope=${args.scope})`
      : `honest-absence provenanceScope for ${args.county}`,
    sourceUrl: plan.route.sourceUrl ?? "provenanceScope",
    observedAt: new Date().toISOString(),
    jurisdictionTenant: `tx_${args.county}`,
    verificationStatus: "machine",
    sourceVintage: new Date().toISOString().slice(0, 10),
  };

  const atoms = buildAtomsForUtilityEasementPlan(plan, provenance);
  summary.atomsBuilt = atoms.length;

  if (!args.apply) {
    console.log(
      JSON.stringify({
        event: "utility-easement-county.dry-run-prediction",
        county: args.county,
        scope: args.scope,
        storeTruth: summary.storeTruth,
        ...summary.plan,
        atomsBuilt: atoms.length,
        sample: atoms.slice(0, 3).map((a) => ({
          atomDid: a.atomDid,
          parcelNodeId: a.parcelNodeId,
          entityId: a.entityId,
          easementId: a.easementId,
          easementClass: a.easementClass,
          sourceTier: a.sourceTier,
          verifiedAbsence: a.verifiedAbsence ?? null,
          absenceKind: a.absence?.kind ?? null,
        })),
        note: "every atom above was CONSTRUCTED and contract-validated; --apply persists exactly these",
      }),
    );
  } else {
    const lease = await takeScopedLease(
      handle.sql,
      railLeaseArgs({
        entityType: "utility-easement",
        countyFips: args.county,
        runId: args.runId,
        holderFallback: "utility-easement-writer",
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
      // every batch seq-scanned the whole atoms table (measured 229,382 ms vs
      // 373 ms per 5,000-id batch at 16.2M+ rows). StoragePort
      // (resolvePropertyAtomDid) upserts under `did:hauska:<entityType>:<entityId>`
      // whenever `body.atomDid` is not already a `did:hauska:` string -- and the
      // utility-easement contract token is `ueasm_<hex>`, so the PK is always the
      // canonical form. `a.entityId` is the exact value written to `entity_id`
      // (`${parcelNodeId}:easement:${easementId}` for all three builders:
      // present, per-parcel absence, and county-coverage absence).
      const dids = slice.map((a) => `did:hauska:utility-easement:${a.entityId}`);
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

        const expectedOutcome =
          atom.sourceTier === "absent" && atom.verifiedAbsence
            ? "county-coverage"
            : atom.absence
              ? "absent"
              : "present";

        const verdict = verifyStoredUtilityEasementAtom(back, {
          parcelNodeId: atom.parcelNodeId,
          outcome: expectedOutcome,
          easementId: atom.easementId,
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
          event: "utility-easement-county.progress",
          county: args.county,
          written: summary.atomsWritten,
          verified: summary.verified,
          ofTotal: atoms.length,
        }),
      );
    }
    } finally {
      await releaseScopedLease(handle.sql, lease);
    }
  }

  summary.wallMs = Math.round(performance.now() - t0);
  console.log(JSON.stringify(summary, null, 2));
  if (args.out) writeFileSync(args.out, JSON.stringify(summary, null, 2));
} catch (err) {
  summary.errors += 1;
  summary.error = String(err?.stack || err);
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
  if (handle) await handle.close();
}
