#!/usr/bin/env node
/**
 * warden-sweep CLI — OPS-9 S5 post-onboarding sweep (operator-authorized
 * 2026-08-04, the Warden). Same invocation style as onboard-preflight.mjs /
 * block13-cert-grade.mjs: env DATABASE_URL etc., exits on its own, prints
 * JSON. FILES-NEVER-FIXES: this script and every module it imports from
 * src/warden/** read state and report findings; none of them write an atom.
 *
 *   DATABASE_URL=... TXGIO_DATABASE_URL=... NODE_OPTIONS=--use-system-ca \
 *     pnpm --filter @hauska-engine/engine-core exec tsx scripts/warden-sweep.mjs \
 *       --row-id=Bastrop [--checks=neighborConsistency,servePathTruth] \
 *       [--sample=10] [--cert-artifact=path/to/cert.json] [--out=path/to/report.json]
 *
 * Env — THREE separate connections/endpoints, each serving a DIFFERENT store.
 * Mixing these up is the exact bug this script's header once let slip through
 * (a live prod sweep hit `PostgresError: relation "txgio_parcel" does not
 * exist` because neighborConsistency's adjacency loader was wired to the
 * wrong connection — see the git history on this comment block):
 *   DATABASE_URL — the ATOMS Neon (zoning-fact / buildable-envelope /
 *     road-node atoms). Required for neighborConsistency, crossStoreConsistency,
 *     certFreshness, envelopeSanity (all read atoms; loadZoningByParcel/
 *     loadDbTruthForParcel/loadRoadsForFips all query this connection, never
 *     txgio_parcel).
 *   TXGIO_DATABASE_URL (falls back to CORTEX_DATABASE_URL, then DATABASE_URL
 *     — see the honest-degrade note below) — the LDT DEPLOYMENT Neon carrying
 *     `txgio_parcel` (cadastral geometry + bbox). In prod this is the
 *     legacy-design-tools-prod DEPLOYMENT_DATABASE_URL secret, a DIFFERENT
 *     database from the atoms Neon. Required for neighborConsistency's
 *     adjacency load (loadParcelAdjacencyIndexFromNeon reads txgio_parcel),
 *     envelopeSanity's parcel-ring load, and crossStoreConsistency/
 *     certFreshness's situs-address lookup inside cert-grade-core.ts (also
 *     txgio_parcel, via ctx.txSql — never ctx.sql). The DATABASE_URL fallback
 *     setup (one DB carrying both tables) still runs; it is NOT a safe prod
 *     default when the two stores are actually separate deployments, which
 *     is why prod must set TXGIO_DATABASE_URL explicitly.
 *   RETRIEVAL_API_URL + RETRIEVAL_API_KEY — the deployed retrieval-api.
 *     Required for servePathTruth only (health/search, search, atom-chain
 *     probes — no DB connection).
 *   LEDGER_INGEST_URL + LEDGER_INGEST_KEY — optional; when set, findings are
 *     also POSTed to the cortex-side onboarding-ledger per the pinned
 *     contract in src/warden/ledger-write.ts. Absent, artifact-only.
 *
 * loadDbTruthForParcel (servePathTruth's DB-truth source) imports
 * isStaleBastropCitySetbackRule read-only from @hauska-engine/adapters — the
 * SAME R13 staleness predicate the retrieval-api's getPropertyAtomChain
 * applies at serve time — so the servePathTruth comparator can distinguish a
 * genuine serve defect from the DESIGNED envelope suppression that predicate
 * drives (see src/warden/serve-path-truth.ts's header for the full
 * narrowing rationale, calibration fix 2026-08-04).
 *
 * Exit code: 0 on a clean sweep OR a sweep that produced flag findings
 * (findings are DATA, not a script failure) — non-zero ONLY on a tooling
 * failure (e.g. unknown --row-id, DB connection failure at startup).
 */
import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";
import { isStaleBastropCitySetbackRule } from "@hauska-engine/adapters";

import { loadJurisdictionRegistryRowById } from "../src/registry/jurisdiction-registry.ts";
import { loadRegistryDistrictCohortByRow } from "../src/registry/parcel-cohort-loader.ts";
import { loadParcelAdjacencyIndexFromNeon, getParcelEdgeNeighbors } from "../src/boundary-primitive/index.ts";
import { roadAtomToWarmSource } from "../src/road-intake/road-to-warm-source.ts";
import bastropDescriptor from "../src/property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };

import { exteriorRingFromGeoJson } from "../src/boundary-primitive/adjacency-grid.ts";
import { classifyNeighborConsistency } from "../src/warden/neighbor-consistency.ts";
import { runServePathTruthCheck } from "../src/warden/serve-path-truth.ts";
import { runCrossStoreConsistencyCheck } from "../src/warden/cross-store-consistency.ts";
import { runCertFreshnessCheck } from "../src/warden/cert-freshness.ts";
import { classifyEnvelopeSanity } from "../src/warden/envelope-sanity.ts";
import { classifyServeTruthEdgeLabels } from "../src/warden/serve-truth-edge-labels.ts";
import { buildSweepReport, writeFindingsToJsonArtifact, postFindingsToLedger } from "../src/warden/ledger-write.ts";

const ALL_CHECK_IDS = ["neighborConsistency", "servePathTruth", "crossStoreConsistency", "certFreshness", "envelopeSanity", "serveTruthEdgeLabels"];

function parseArgs(argv) {
  const out = { rowId: null, checks: null, sample: 10, certArtifact: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--row-id") out.rowId = String(argv[++i] || "").trim();
    else if (a.startsWith("--row-id=")) out.rowId = a.slice("--row-id=".length).trim();
    else if (a === "--checks") out.checks = String(argv[++i] || "").trim();
    else if (a.startsWith("--checks=")) out.checks = a.slice("--checks=".length).trim();
    else if (a === "--sample") out.sample = Number(argv[++i]);
    else if (a.startsWith("--sample=")) out.sample = Number(a.slice("--sample=".length));
    else if (a === "--cert-artifact") out.certArtifact = String(argv[++i] || "").trim();
    else if (a.startsWith("--cert-artifact=")) out.certArtifact = a.slice("--cert-artifact=".length).trim();
    else if (a === "--out") out.out = String(argv[++i] || "").trim();
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length).trim();
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.rowId) {
  console.error("FATAL: --row-id=<rowId> required (e.g. --row-id=Bastrop)");
  process.exit(2);
}
const row = loadJurisdictionRegistryRowById(args.rowId);
if (!row) {
  console.error(`FATAL: unknown --row-id=${args.rowId} (no such row in the frozen jurisdiction registry)`);
  process.exit(2);
}

const requestedChecks = args.checks ? args.checks.split(",").map((c) => c.trim()).filter(Boolean) : ALL_CHECK_IDS;
const unknownCheck = requestedChecks.find((c) => !ALL_CHECK_IDS.includes(c));
if (unknownCheck) {
  console.error(`FATAL: unknown --checks entry "${unknownCheck}" (valid: ${ALL_CHECK_IDS.join(", ")})`);
  process.exit(2);
}
const sampleSize = Number.isFinite(args.sample) && args.sample > 0 ? args.sample : 10;

const sweepId = `warden-${row.fips}-${row.rowId.replace(/\s+/g, "_")}-${Date.now()}`;
const now = () => new Date();

console.log(`[warden-sweep] sweepId=${sweepId} rowId=${row.rowId} fips=${row.fips} checks=${requestedChecks.join(",")} sample=${sampleSize}`);

const url = resolveSubstrateDatabaseUrl();
const sql = url ? postgres(url, { ssl: "require", max: 2, prepare: false }) : null;
const txgioUrl = process.env.TXGIO_DATABASE_URL?.trim() || process.env.CORTEX_DATABASE_URL?.trim() || url;
const txSql = url && txgioUrl ? postgres(txgioUrl, { ssl: "require", max: 2, prepare: false }) : null;
const storageHandle = url ? createPgStorage({ databaseUrl: url, maxConnections: 2 }) : null;

const retrievalApiUrl = process.env.RETRIEVAL_API_URL?.trim() || null;
const retrievalApiKey = process.env.RETRIEVAL_API_KEY?.trim() || null;
const ledgerIngestUrl = process.env.LEDGER_INGEST_URL?.trim() || null;
const ledgerIngestKey = process.env.LEDGER_INGEST_KEY?.trim() || null;

/** Deterministic rowId-keyed sample — mirrors preflight-probes.ts loadDeterministicSample (#247/#248). */
async function loadDeterministicSample(registryRow, sampleSizeArg = sampleSize) {
  const cohort = await loadRegistryDistrictCohortByRow(registryRow.rowId, null);
  const DEGENERATE_SEGMENTS = new Set(["", "0", "null", "undefined", "NaN"]);
  const sortedIds = [...new Set(cohort.parcelNodeIds)]
    .filter((id) => {
      const seg = (id.split(":")[1] ?? "").trim();
      if (DEGENERATE_SEGMENTS.has(seg)) return false;
      const n = Number(seg);
      return !(Number.isFinite(n) && n <= 0);
    })
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  if (registryRow.zoningRegime !== "unzoned" || !sql) {
    return { cohort, sample: sortedIds.slice(0, sampleSizeArg) };
  }

  const picked = [];
  for (let i = 0; i < sortedIds.length && picked.length < sampleSizeArg; i += 200) {
    const chunk = sortedIds.slice(i, i + 200);
    const rows = await sql`
      SELECT DISTINCT ON (body->>'parcelNodeId')
        body->>'parcelNodeId' AS pid,
        body->>'district' AS district
      FROM atoms
      WHERE entity_type = 'zoning-fact'
        AND body->>'parcelNodeId' = ANY(${chunk})
      ORDER BY body->>'parcelNodeId', updated_at DESC NULLS LAST
    `;
    const districted = new Set(
      rows.filter((r) => r.district !== null).map((r) => r.pid),
    );
    for (const id of chunk) {
      if (districted.has(id)) continue;
      picked.push(id);
      if (picked.length >= sampleSizeArg) break;
    }
  }
  return { cohort, sample: picked };
}

async function loadRoadsForFips(fips) {
  if (!sql) return [];
  const roadRows = await sql`
    SELECT body FROM atoms WHERE entity_type = 'road-node'
      AND body->>'countyFips' = ${fips}
      AND coalesce(body->>'status', 'active') = 'active'
  `;
  return roadRows.map((r) => roadAtomToWarmSource(r.body)).filter(Boolean);
}

/** Loads zoning-fact district (or null for honest-absence) for a set of parcelNodeIds — READ ONLY. */
async function loadZoningByParcel(parcelNodeIds) {
  const map = new Map();
  if (!sql || parcelNodeIds.length === 0) return map;
  const rows = await sql`
    SELECT DISTINCT ON (body->>'parcelNodeId') body->>'parcelNodeId' AS parcel_node_id, body
    FROM atoms
    WHERE entity_type = 'zoning-fact' AND body->>'parcelNodeId' = ANY(${parcelNodeIds})
    ORDER BY body->>'parcelNodeId', updated_at DESC NULLS LAST
  `;
  for (const r of rows) {
    const district = r.body?.absence ? null : (r.body?.district ?? null);
    map.set(r.parcel_node_id, {
      parcelNodeId: r.parcel_node_id,
      propId: r.parcel_node_id.split(":")[1] ?? "",
      district,
    });
  }
  return map;
}

/**
 * DEPTH_WARM_PROMOTION_MARKER mirrors
 * packages/retrieval/src/envelope-serve-independent.ts's constant of the
 * same name — read-only string literal, no import (that module lives in
 * @hauska-engine/retrieval, which engine-core does not depend on; the value
 * itself is a stable, already-published constant referenced by
 * cert-grade-core.ts's own DEPTH_WARM_PROMOTION_MARKER in this same repo).
 */
const DEPTH_WARM_PROMOTION_MARKER = "depth-warm-promoted-v1";

/**
 * Mirrors envelopeServeIndependentOfStaleSetback
 * (packages/retrieval/src/envelope-serve-independent.ts) read-only: true
 * when a buildable-envelope row carries a marker that makes it independent
 * of stale-setback suppression (depth-warm-promoted, or a warm-verify
 * decline by string or code, or a sourceCitation mentioning
 * depth-warm-verify-decline).
 */
function envelopeIndependentOfStaleSetback(envelopeBody) {
  if (!envelopeBody || typeof envelopeBody !== "object") return false;
  if (envelopeBody.depthWarmPromotion === DEPTH_WARM_PROMOTION_MARKER) return true;
  const absenceKind = envelopeBody.absence?.kind;
  if (typeof absenceKind === "string" && absenceKind.trim().length > 0) return true;
  if (typeof envelopeBody.warmVerifyDecline === "string" && envelopeBody.warmVerifyDecline.trim().length > 0) return true;
  if (typeof envelopeBody.warmVerifyDeclineCode === "string" && envelopeBody.warmVerifyDeclineCode.trim().length > 0) return true;
  const citation = envelopeBody.sourceCitation;
  return typeof citation === "string" && citation.toLowerCase().includes("depth-warm-verify-decline");
}

/**
 * Loads DB truth for the servePathTruth body-sanity comparison: zoning-fact
 * presence + district, buildable-envelope presence, and (fix 3, 2026-08-04
 * calibration pass) two fields the comparator needs to narrow the
 * envelopePresent check to unambiguous-under-suppression cases only:
 * setbackSourceStale (isStaleBastropCitySetbackRule, imported read-only from
 * @hauska-engine/adapters — the SAME predicate getPropertyAtomChain applies
 * at serve time) and envelopeServeIndependentOfStaleSetback (mirrored
 * read-only above, since that helper lives in @hauska-engine/retrieval which
 * engine-core does not depend on).
 */
async function loadDbTruthForParcel(parcelNodeId) {
  if (!sql) {
    return {
      hasZoningFact: false,
      district: null,
      hasBuildableEnvelope: false,
      setbackSourceStale: null,
      envelopeServeIndependentOfStaleSetback: null,
    };
  }
  const [zf] = await sql`
    SELECT body FROM atoms WHERE entity_type = 'zoning-fact'
      AND body->>'parcelNodeId' = ${parcelNodeId}
    ORDER BY updated_at DESC NULLS LAST LIMIT 1
  `;
  const [env] = await sql`
    SELECT body FROM atoms WHERE entity_type = 'buildable-envelope'
      AND body->>'parcelNodeId' = ${parcelNodeId}
    ORDER BY updated_at DESC NULLS LAST LIMIT 1
  `;
  const [sr] = await sql`
    SELECT body FROM atoms WHERE entity_type = 'setback-rule'
      AND body->>'parcelNodeId' = ${parcelNodeId}
    ORDER BY updated_at DESC NULLS LAST LIMIT 1
  `;
  const hasZoningFact = !!zf;
  const districtFromFact =
    zf?.body?.absence != null ? null : (zf?.body?.district ?? null);

  let setbackSourceStale = null;
  if (sr) {
    const sourceCodeAtomDid =
      sr.body?.sourceCodeAtomRef && typeof sr.body.sourceCodeAtomRef === "object"
        ? sr.body.sourceCodeAtomRef.atomDid ?? null
        : null;
    setbackSourceStale = isStaleBastropCitySetbackRule({
      parcelNodeId,
      sourceAdapter: sr.body?.sourceAdapter ?? null,
      sourceCodeAtomDid,
    });
  }

  return {
    hasZoningFact,
    district: hasZoningFact ? districtFromFact : null,
    hasBuildableEnvelope: !!env,
    setbackSourceStale,
    envelopeServeIndependentOfStaleSetback: env ? envelopeIndependentOfStaleSetback(env.body) : null,
  };
}

/** Latest envelope decline code for crossStore consistency (Warden v1.1).
 * Prefer contract absence.kind (1.15.0+); fall back to legacy warmVerifyDeclineCode. */
async function loadEnvelopeDeclineCode(parcelNodeId) {
  if (!sql) return null;
  const [env] = await sql`
    SELECT body FROM atoms WHERE entity_type = 'buildable-envelope'
      AND body->>'parcelNodeId' = ${parcelNodeId}
    ORDER BY updated_at DESC NULLS LAST LIMIT 1
  `;
  const body = env?.body ?? null;
  const kind = body?.absence?.kind;
  if (typeof kind === "string" && kind.trim().length > 0) return kind.trim();
  const code = body?.warmVerifyDeclineCode;
  return typeof code === "string" && code.trim().length > 0 ? code.trim() : null;
}

/** Latest buildable-envelope atom body for envelopeSanity — READ ONLY. */
async function loadEnvelopeBody(parcelNodeId) {
  if (!sql) return null;
  const [env] = await sql`
    SELECT body FROM atoms WHERE entity_type = 'buildable-envelope'
      AND body->>'parcelNodeId' = ${parcelNodeId}
    ORDER BY updated_at DESC NULLS LAST LIMIT 1
  `;
  return env?.body ?? null;
}

/** txgio_parcel exterior ring for envelopeSanity — READ ONLY. */
async function loadParcelRingFromTxgio(fips, propId) {
  if (!txSql) return null;
  const [row] = await txSql`
    SELECT geometry FROM txgio_parcel
    WHERE county_fips = ${fips}
      AND regexp_replace(prop_id, '^0+', '') = regexp_replace(${propId}, '^0+', '')
    ORDER BY ingested_at DESC NULLS LAST
    LIMIT 1
  `;
  return row?.geometry ? exteriorRingFromGeoJson(row.geometry) : null;
}

/** Tolerant loader for a --cert-artifact JSON (block13-cert-grade.mjs output shape, or a Warden report). */
async function loadPriorCertVerdict(path) {
  if (!path) return undefined;
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(path, "utf8");
  const json = JSON.parse(raw);
  const passByParcel = {};
  const results = json.results ?? json.parcels ?? json.roster ?? [];
  for (const entry of Array.isArray(results) ? results : []) {
    const parcelNodeId = entry.parcelNodeId ?? entry.parcel_node_id;
    if (parcelNodeId) passByParcel[parcelNodeId] = !!entry.pass;
  }
  return {
    passByParcel,
    artifactPath: path,
    artifactTs: json.when ?? json.ts ?? json.timestamp ?? json.generatedAt ?? null,
  };
}

async function main() {
  const findings = [];
  const checksRun = [];

  const { cohort, sample } = await loadDeterministicSample(row, sampleSize);
  console.log(`[warden-sweep] cohort size=${cohort.count} sample size=${sample.length}`);

  if (requestedChecks.includes("neighborConsistency")) {
    checksRun.push("neighborConsistency");
    if (!sql || !txSql) {
      console.log("[warden-sweep] neighborConsistency: skipped, DATABASE_URL/TXGIO_DATABASE_URL not configured");
    } else {
      // txgio_parcel lives in the TXGIO Neon (the ldt deployment DB), NOT the
      // atoms Neon — the adjacency index MUST be built from txSql. zoningByParcel
      // below correctly stays on sql (the atoms DB), since zoning-fact atoms
      // live there.
      const index = await loadParcelAdjacencyIndexFromNeon(txSql, row.fips);
      const zoningByParcel = await loadZoningByParcel(cohort.parcelNodeIds);
      // Also resolve every neighbor referenced by the cohort so cross-cohort
      // edges (a cohort parcel bordering a parcel outside the row's filter,
      // e.g. a city-filtered row bordering unincorporated county) still have
      // zoning state to compare against, when present.
      const neighborIds = new Set();
      for (const parcelNodeId of cohort.parcelNodeIds) {
        const neighbors = index.entries.has(parcelNodeId)
          ? getParcelEdgeNeighbors(index, parcelNodeId)
          : null;
        for (const propId of neighbors ?? []) {
          if (propId) neighborIds.add(`${row.fips}:${propId}`);
        }
      }
      const extraZoning = await loadZoningByParcel([...neighborIds]);
      for (const [k, v] of extraZoning) if (!zoningByParcel.has(k)) zoningByParcel.set(k, v);

      const neighborFindings = classifyNeighborConsistency({
        sweepId,
        fips: row.fips,
        rowId: row.rowId,
        row,
        index,
        zoningByParcel,
        cohortParcelNodeIds: cohort.parcelNodeIds,
        now,
      });
      findings.push(...neighborFindings);
      console.log(`[warden-sweep] neighborConsistency: ${neighborFindings.length} finding(s)`);
    }
  }

  if (requestedChecks.includes("servePathTruth")) {
    checksRun.push("servePathTruth");
    if (!retrievalApiUrl || !retrievalApiKey) {
      console.log("[warden-sweep] servePathTruth: skipped, RETRIEVAL_API_URL/RETRIEVAL_API_KEY not configured");
    } else {
      const servePathFindings = await runServePathTruthCheck({
        sweepId,
        fips: row.fips,
        rowId: row.rowId,
        now,
        deps: {
          baseUrl: retrievalApiUrl,
          apiKey: retrievalApiKey,
          sample,
          loadDbTruth: loadDbTruthForParcel,
        },
      });
      findings.push(...servePathFindings);
      console.log(`[warden-sweep] servePathTruth: ${servePathFindings.length} finding(s)`);
    }
  }

  const priorVerdict = await loadPriorCertVerdict(args.certArtifact);

  if (requestedChecks.includes("crossStoreConsistency")) {
    checksRun.push("crossStoreConsistency");
    if (!sql || !txSql || !storageHandle) {
      console.log("[warden-sweep] crossStoreConsistency: skipped, DATABASE_URL/TXGIO_DATABASE_URL not configured");
    } else {
      const roads = await loadRoadsForFips(row.fips);
      const crossStoreFindings = await runCrossStoreConsistencyCheck({
        sweepId,
        fips: row.fips,
        rowId: row.rowId,
        now,
        deps: {
          ctx: { sql, txSql, storage: storageHandle.storage, roads, descriptor: bastropDescriptor },
          sample,
          row,
          priorVerdict,
          loadEnvelopeDeclineCode,
        },
      });
      findings.push(...crossStoreFindings);
      console.log(`[warden-sweep] crossStoreConsistency: ${crossStoreFindings.length} finding(s)`);
    }
  }

  if (requestedChecks.includes("certFreshness")) {
    checksRun.push("certFreshness");
    if (!sql || !txSql || !storageHandle) {
      console.log("[warden-sweep] certFreshness: skipped, DATABASE_URL/TXGIO_DATABASE_URL not configured");
    } else {
      const roads = await loadRoadsForFips(row.fips);
      const certFreshnessFindings = await runCertFreshnessCheck({
        sweepId,
        fips: row.fips,
        rowId: row.rowId,
        now,
        deps: {
          ctx: { sql, txSql, storage: storageHandle.storage, roads, descriptor: bastropDescriptor },
          sample,
          row,
          priorVerdict,
        },
      });
      findings.push(...certFreshnessFindings);
      console.log(`[warden-sweep] certFreshness: ${certFreshnessFindings.length} finding(s)`);
    }
  }

  if (requestedChecks.includes("envelopeSanity")) {
    checksRun.push("envelopeSanity");
    if (!sql || !txSql) {
      console.log("[warden-sweep] envelopeSanity: skipped, DATABASE_URL/TXGIO_DATABASE_URL not configured");
    } else {
      const zoningByParcel = await loadZoningByParcel(sample);
      const envelopeSanityInputs = [];
      for (const parcelNodeId of sample) {
        const propId = parcelNodeId.split(":")[1] ?? "";
        envelopeSanityInputs.push({
          parcelNodeId,
          district: zoningByParcel.get(parcelNodeId)?.district ?? null,
          envelopeBody: await loadEnvelopeBody(parcelNodeId),
          parcelRing: await loadParcelRingFromTxgio(row.fips, propId),
        });
      }
      const envelopeSanityFindings = classifyEnvelopeSanity({
        sweepId,
        fips: row.fips,
        rowId: row.rowId,
        now,
        parcels: envelopeSanityInputs,
      });
      findings.push(...envelopeSanityFindings);
      console.log(`[warden-sweep] envelopeSanity: ${envelopeSanityFindings.length} finding(s)`);
    }
  }

  if (requestedChecks.includes("serveTruthEdgeLabels")) {
    checksRun.push("serveTruthEdgeLabels");
    if (!sql || !txSql) {
      console.log("[warden-sweep] serveTruthEdgeLabels: skipped, DATABASE_URL/TXGIO_DATABASE_URL not configured");
    } else {
      const roads = await loadRoadsForFips(row.fips);
      const serveTruthInputs = [];
      for (const parcelNodeId of sample) {
        const propId = parcelNodeId.split(":")[1] ?? "";
        const edgeRows = await sql`
          SELECT body FROM atoms WHERE entity_type = 'property-boundary-edge'
            AND body->>'parcelNodeId' = ${parcelNodeId}
            AND COALESCE(body->>'status', 'active') = 'active'
          ORDER BY (body->>'edgeIndex')::int
        `;
        const [sr] = await sql`
          SELECT body FROM atoms WHERE entity_type = 'setback-rule'
            AND body->>'parcelNodeId' = ${parcelNodeId}
          ORDER BY updated_at DESC NULLS LAST LIMIT 1
        `;
        const [situsRow] = await txSql`
          SELECT situs_address FROM txgio_parcel
          WHERE county_fips = ${row.fips}
            AND regexp_replace(prop_id, '^0+', '') = regexp_replace(${propId}, '^0+', '')
          LIMIT 1
        `;
        serveTruthInputs.push({
          parcelNodeId,
          parcelRing: await loadParcelRingFromTxgio(row.fips, propId),
          situsAddress: situsRow?.situs_address ?? null,
          storedEdges: edgeRows.map((r) => r.body),
          setbackRule: sr?.body ?? null,
          envelopeBody: await loadEnvelopeBody(parcelNodeId),
          roads,
        });
      }
      const serveTruthFindings = await classifyServeTruthEdgeLabels({
        sweepId,
        fips: row.fips,
        rowId: row.rowId,
        now,
        parcels: serveTruthInputs,
      });
      findings.push(...serveTruthFindings);
      console.log(`[warden-sweep] serveTruthEdgeLabels: ${serveTruthFindings.length} finding(s)`);
    }
  }

  const report = buildSweepReport({
    sweepId,
    rowId: row.rowId,
    fips: row.fips,
    checksRun,
    findings,
    now,
  });

  const outPath = args.out ?? `warden-sweep-${sweepId}.json`;
  await writeFindingsToJsonArtifact(outPath, report);
  console.log(`[warden-sweep] artifact written: ${outPath}`);

  const ledgerResult = await postFindingsToLedger(ledgerIngestUrl, ledgerIngestKey, report);
  console.log(`[warden-sweep] ledger post: ${JSON.stringify(ledgerResult)}`);

  console.log(JSON.stringify({ sweepId: report.sweepId, rowId: report.rowId, fips: report.fips, clean: report.clean, findingCount: report.findings.length, checksRun: report.checksRun }, null, 2));
}

try {
  await main();
  // findings (clean or flagged) are expected DATA, never a tooling failure.
  process.exitCode = 0;
} catch (err) {
  console.error(`FATAL: warden-sweep tooling failure: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (storageHandle) await storageHandle.close();
  if (txSql) await txSql.end();
  if (sql) await sql.end();
}
