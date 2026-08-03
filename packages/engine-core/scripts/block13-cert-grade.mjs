#!/usr/bin/env node
/**
 * Bastrop mechanical cert grade — THE proven Block-13 harness, generalized by roster.
 *
 * Default (--roster-from=block13): grades the frozen 7-parcel Block-13 regression 7/7.
 * Query (--roster-from=query --district-prefix=SF-1): dominant-district roster (R26),
 * per-parcel layer-23 answer key, same 4 gates. Honest-decline = PASS-or-decline.
 *
 * READ-ONLY. Exits non-zero if any roster parcel fails (promoted must pass all gates).
 *
 *   # Block-13 regression (must stay 7/7):
 *   DATABASE_URL=... CORTEX_DATABASE_URL=... NODE_OPTIONS=--use-system-ca \
 *     pnpm --filter @hauska-engine/engine-core exec tsx scripts/block13-cert-grade.mjs
 *
 *   # District block sweep (dominant-district cohort):
 *   ... exec tsx scripts/block13-cert-grade.mjs --roster-from=query --district-prefix=SF-1
 */
import fs from "node:fs";
import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";
import { fetchBastropPerParcelSetbackRecord } from "@hauska-engine/adapters";

import bastropDescriptor from "../src/property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import {
  fetchBcadParcelRings,
  scrubLotLineRing,
  ringCentroidLngLat,
} from "../src/boundary-primitive/index.ts";
import {
  readBoundaryEdgesForParcel,
  BoundaryPrimitiveMissingError,
} from "../src/boundary-primitive/read.ts";
import { roadAtomToWarmSource } from "../src/road-intake/road-to-warm-source.ts";
import { labelEdgesFromRoads } from "../src/depth-warm/edgeLabeling.ts";
import { DEPTH_WARM_PROMOTION_MARKER, RECIPE_VERSION } from "../src/depth-warm/types.ts";
import { openRing } from "../src/depth-warm/geometry.ts";
import { measurePerEdgeInsetForRings } from "../src/depth-warm/measure-inset.ts";
import { computeWarmCandidateFromBoundary } from "../src/boundary-primitive/consume.ts";
import { computeWarmCandidate } from "../src/depth-warm/warm-compute.ts";
import { relabelBoundaryEdgesFromRoadLabels } from "../src/boundary-primitive/relabel-from-roads.ts";
import {
  primitiveNormalsAgreeWithRing,
  recomputeBoundaryEdgesForRing,
} from "../src/boundary-primitive/recompute-for-ring.ts";
import {
  verifyFrontEdgeOrientation,
  verifyWarmCandidateMechanically,
} from "../src/depth-warm/verify-mechanical.ts";
import {
  streetNamesMatchForFacesAnswer,
  isNoDeterminableFrontageSitus,
  R35_ORIENTATION_DECLINE,
} from "../src/depth-warm/cert-equivalent-gates.ts";
import {
  loadDominantDistrictRoster,
  BLOCK13_QUARANTINE,
} from "./bastrop-dominant-district-roster.mjs";
import {
  runOnboardPreflight,
  deriveScopeAnnotations,
} from "../src/registry/onboard-preflight.ts";

const COUNTY = "48021";
const INSET_TOL_FT = 1.0;

/** Frozen Block-13 regression roster + answer key. */
const BLOCK13 = [
  "48021:34145",
  "48021:34121",
  "48021:34153",
  "48021:34137",
  "48021:34169",
  "48021:34177",
  "48021:34161",
];

const ANSWER_KEY_BLOCK13 = {
  "48021:34145": { situs: "909 Pecan", district: "GC", F: 20, S: 5, C: null, R: 20, frontStreet: "Pecan" },
  "48021:34121": { situs: "907 Chestnut", district: "GC", F: 20, S: 5, C: null, R: 20, frontStreet: "Chestnut" },
  "48021:34153": { situs: "909 Chestnut", district: "GC", F: 20, S: 5, C: null, R: 20, frontStreet: "Chestnut" },
  "48021:34137": { situs: "908 Pine", district: "SF-1", F: 25, S: 5, C: 15, R: 25, frontStreet: "Pine" },
  "48021:34169": { situs: "906 Pine", district: "SF-1", F: 25, S: 5, C: 15, R: 25, frontStreet: "Pine" },
  "48021:34177": { situs: "901 Pecan", district: "MU", F: 15, S: 5, C: null, R: 15, frontStreet: "Pecan" },
  "48021:34161": { situs: "905 Pecan", district: "MU", F: 15, S: 5, C: null, R: 15, frontStreet: "Pecan" },
};

function parseArgs(argv) {
  const out = {
    rosterFrom: "block13",
    districtPrefix: null,
    rosterFile: null,
    // SCOPE 3 (cert-with-scope-annotation): optional rowId to look up a
    // pre-flight row report for. Absent by default — the existing Bastrop
    // full-coverage invocation never sets this, so scopeAnnotations stays
    // empty/absent and the report is byte-identical to before.
    preflightRowId: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--roster-from") out.rosterFrom = String(argv[++i] || "block13").trim();
    else if (a.startsWith("--roster-from=")) out.rosterFrom = a.slice("--roster-from=".length).trim();
    else if (a === "--district-prefix") out.districtPrefix = String(argv[++i] || "").trim();
    else if (a.startsWith("--district-prefix=")) {
      out.districtPrefix = a.slice("--district-prefix=".length).trim();
    } else if (a === "--roster-file") out.rosterFile = String(argv[++i] || "").trim();
    else if (a.startsWith("--roster-file=")) out.rosterFile = a.slice("--roster-file=".length).trim();
    else if (a === "--preflight-row-id") out.preflightRowId = String(argv[++i] || "").trim();
    else if (a.startsWith("--preflight-row-id=")) {
      out.preflightRowId = a.slice("--preflight-row-id=".length).trim();
    }
  }
  return out;
}

function expectedFtForRole(role, key) {
  if (role === "front") return key.F;
  if (role === "rear") return key.R;
  if (role === "side_corner") return key.C ?? key.S;
  return key.S;
}

function situsFrontStreetToken(situs) {
  if (!situs?.trim()) return null;
  const streetPart = situs.split(",")[0]?.trim() ?? situs.trim();
  const m = /^\d+\s+(.+)$/.exec(streetPart);
  return m ? m[1].trim() : streetPart;
}

async function buildLayer23Key(parcelNodeId, district, centroidLngLat, zoningStamp) {
  const fetched = await fetchBastropPerParcelSetbackRecord(parcelNodeId.split(":")[1], {
    districtCode: zoningStamp ?? district,
    centroidLngLat,
  });
  if (fetched.kind !== "parsed") {
    return { ok: false, code: fetched.code, reason: fetched.reason };
  }
  const d = (fetched.resolvedDistrictCode ?? district).trim() || district;
  const C =
    fetched.sideCornerFt != null &&
    fetched.sideInteriorFt != null &&
    fetched.sideCornerFt !== fetched.sideInteriorFt
      ? fetched.sideCornerFt
      : null;
  return {
    ok: true,
    key: {
      district: d.split(/\s+/)[0],
      F: fetched.frontFt,
      S: fetched.sideInteriorFt ?? fetched.sideCornerFt,
      C,
      R: fetched.rearFt,
      frontStreet: null,
    },
  };
}

async function loadRoster(args) {
  if (args.rosterFrom === "block13") {
    return { parcelNodeIds: BLOCK13, mode: "block13", source: "BLOCK13 constant" };
  }
  if (args.rosterFrom === "file") {
    if (!args.rosterFile) throw new Error("--roster-file required for --roster-from=file");
    const raw = fs.readFileSync(args.rosterFile, "utf8");
    const ids = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    return { parcelNodeIds: ids, mode: "query", source: `file:${args.rosterFile}` };
  }
  if (args.rosterFrom === "query") {
    if (!args.districtPrefix) throw new Error("--district-prefix required for --roster-from=query");
    const loaded = await loadDominantDistrictRoster(args.districtPrefix);
    return {
      parcelNodeIds: loaded.parcelNodeIds,
      mode: "query",
      source: `dominant-district:${args.districtPrefix} (${loaded.source})`,
      districtPrefix: args.districtPrefix,
    };
  }
  throw new Error(`Unknown --roster-from=${args.rosterFrom}`);
}

function resolveBlock13Key(parcelNodeId) {
  const key = ANSWER_KEY_BLOCK13[parcelNodeId];
  if (!key) return { ok: false, reason: "not in BLOCK13 answer key" };
  return { ok: true, key };
}

const args = parseArgs(process.argv.slice(2));
const rosterLoad = await loadRoster(args);

const url = resolveSubstrateDatabaseUrl();
const txgioUrl =
  process.env.TXGIO_DATABASE_URL?.trim() ||
  process.env.CORTEX_DATABASE_URL?.trim() ||
  url;
if (!url) {
  console.error("FATAL: DATABASE_URL (atoms) required");
  process.exit(2);
}

const sql = postgres(url, { ssl: "require", max: 4, prepare: false });
const txSql = postgres(txgioUrl, { ssl: "require", max: 4, prepare: false });
const storage = createPgStorage({ databaseUrl: url, maxConnections: 2 });

const roadRows = await sql`
  SELECT body FROM atoms WHERE entity_type = 'road-node'
    AND body->>'countyFips' = ${COUNTY}
    AND coalesce(body->>'status', 'active') = 'active'
`;
const roads = roadRows.map((r) => roadAtomToWarmSource(r.body)).filter(Boolean);

const descriptor = {
  ...bastropDescriptor,
  sourceAdapter: "bastrop-per-parcel-record-layer-23",
};

// SCOPE 3 (cert-with-scope-annotation, operator-ruled 2026-08-03): when the
// caller names a pre-flight row (--preflight-row-id), attach scopeAnnotations
// derived from that row's declined CORE rails. Absent by default — the
// existing Bastrop full-coverage invocation never sets --preflight-row-id,
// so the report carries no scopeAnnotations key at all (byte-identical to
// before this change).
let scopeAnnotations;
if (args.preflightRowId) {
  const rowForFips = await import("../src/registry/jurisdiction-registry.ts").then((m) =>
    Object.values(m).find(
      (v) => v && typeof v === "object" && "rowId" in v && v.rowId === args.preflightRowId,
    ),
  );
  if (rowForFips) {
    const { report: preflightReport } = await runOnboardPreflight(rowForFips.fips, {});
    const rowReport = preflightReport.rows.find((r) => r.rowId === args.preflightRowId);
    const annotations = deriveScopeAnnotations(rowReport);
    if (annotations.length > 0) scopeAnnotations = annotations;
  }
}

const report = {
  when: new Date().toISOString(),
  cert:
    rosterLoad.mode === "block13"
      ? "BLOCK-13 CERT-RESTORE mechanical grade"
      : `Bastrop dominant-district mechanical grade (${rosterLoad.districtPrefix ?? "file"})`,
  rosterFrom: args.rosterFrom,
  rosterSource: rosterLoad.source,
  measurer: "R32 index-matched inward-normal (measurePerEdgeInsetForRings)",
  orientationGate: "fresh labelEdgesFromRoads front-edge road-name token-match (R33 normalization)",
  roadNodesLoaded: roads.length,
  rosterSize: rosterLoad.parcelNodeIds.length,
  parcels: {},
  score: { pass: 0, fail: 0, honestDecline: 0, staleResidue: 0, total: rosterLoad.parcelNodeIds.length },
  ...(scopeAnnotations ? { scopeAnnotations } : {}),
};

try {
  for (const parcelNodeId of rosterLoad.parcelNodeIds) {
    const propId = parcelNodeId.split(":")[1];
    const parcelResult = { pass: false, gates: {}, edges: [] };

    if (rosterLoad.mode === "query") {
      const [envRow] = await sql`
        SELECT body FROM atoms
        WHERE entity_type = 'buildable-envelope' AND body->>'parcelNodeId' = ${parcelNodeId}
        ORDER BY updated_at DESC NULLS LAST LIMIT 1
      `;
      const env = envRow?.body;
      const warmDecline = env?.warmVerifyDecline ?? null;
      const isPromoted = env?.depthWarmPromotion === DEPTH_WARM_PROMOTION_MARKER;
      const recipeVersion = env?.recipeVersion ?? null;

      if (warmDecline && recipeVersion === RECIPE_VERSION && !isPromoted) {
        parcelResult.pass = true;
        parcelResult.honestDecline = true;
        parcelResult.declineReason = warmDecline;
        report.parcels[parcelNodeId] = parcelResult;
        report.score.honestDecline++;
        report.score.pass++;
        continue;
      }

      if (isPromoted && recipeVersion !== RECIPE_VERSION) {
        parcelResult.error = "stale-residue";
        report.parcels[parcelNodeId] = parcelResult;
        report.score.staleResidue++;
        report.score.fail++;
        continue;
      }

      if (!isPromoted || recipeVersion !== RECIPE_VERSION) {
        const [zf] = await sql`
          SELECT 1 FROM atoms WHERE entity_type = 'zoning-fact'
            AND body->>'parcelNodeId' = ${parcelNodeId} AND NOT (body ? 'absence') LIMIT 1
        `;
        if (!zf) {
          parcelResult.pass = true;
          parcelResult.honestDecline = true;
          parcelResult.declineReason = "no-zoning-fact-on-substrate";
          report.parcels[parcelNodeId] = parcelResult;
          report.score.honestDecline++;
          report.score.pass++;
          continue;
        }
        parcelResult.error = "missing-single-vintage-state";
        report.parcels[parcelNodeId] = parcelResult;
        report.score.fail++;
        continue;
      }
    }

    let key;
    if (rosterLoad.mode === "block13") {
      const resolved = resolveBlock13Key(parcelNodeId);
      if (!resolved.ok) {
        parcelResult.error = resolved.reason;
        report.parcels[parcelNodeId] = parcelResult;
        report.score.fail++;
        continue;
      }
      key = { ...resolved.key };
      parcelResult.district = key.district;
      parcelResult.answerKey = key;
    }

    const [situsRow] = await txSql`
      SELECT situs_address FROM txgio_parcel
      WHERE county_fips = ${COUNTY} AND prop_id = ${propId} LIMIT 1
    `;
    const situsAddress = situsRow?.situs_address?.trim() ?? null;
    parcelResult.situs = situsAddress;

    let ring = null;
    try {
      const bcad = await fetchBcadParcelRings([propId]);
      ring = scrubLotLineRing(bcad[0]?.ring);
    } catch (err) {
      parcelResult.error = "bcad-fetch-failed";
      parcelResult.reason = err instanceof Error ? err.message : String(err);
      report.parcels[parcelNodeId] = parcelResult;
      report.score.fail++;
      continue;
    }
    if (!ring) {
      parcelResult.error = "no-ring";
      report.parcels[parcelNodeId] = parcelResult;
      report.score.fail++;
      continue;
    }

    const centroidLngLat = ringCentroidLngLat(ring);

    const [zfRow] = await sql`
      SELECT body FROM atoms WHERE entity_type = 'zoning-fact'
        AND body->>'parcelNodeId' = ${parcelNodeId}
      ORDER BY updated_at DESC NULLS LAST LIMIT 1
    `;
    const stampedDistrict = zfRow?.body?.district ?? rosterLoad.districtPrefix ?? null;

    if (rosterLoad.mode === "query") {
      const keyBuilt = await buildLayer23Key(parcelNodeId, stampedDistrict, centroidLngLat, stampedDistrict);
      if (!keyBuilt.ok) {
        parcelResult.error = keyBuilt.code;
        parcelResult.reason = keyBuilt.reason;
        report.parcels[parcelNodeId] = parcelResult;
        report.score.fail++;
        continue;
      }
      key = {
        ...keyBuilt.key,
        frontStreet: situsFrontStreetToken(situsAddress),
      };
      parcelResult.answerKey = key;
    }

    const [envRow] = await sql`
      SELECT body FROM atoms
      WHERE entity_type = 'buildable-envelope'
        AND body->>'parcelNodeId' = ${parcelNodeId}
        AND body->>'depthWarmPromotion' = ${DEPTH_WARM_PROMOTION_MARKER}
      ORDER BY updated_at DESC NULLS LAST LIMIT 1
    `;
    const insetRing =
      envRow?.body?.geojson?.features?.[0]?.geometry?.coordinates?.[0] ??
      (rosterLoad.mode === "query"
        ? (
            await sql`
              SELECT body FROM atoms
              WHERE entity_type = 'buildable-envelope' AND body->>'parcelNodeId' = ${parcelNodeId}
              ORDER BY updated_at DESC NULLS LAST LIMIT 1
            `
          )[0]?.body?.geojson?.features?.[0]?.geometry?.coordinates?.[0]
        : null);
    if (!insetRing?.length) {
      parcelResult.error = "no-promoted-envelope-geojson";
      report.parcels[parcelNodeId] = parcelResult;
      report.score.fail++;
      continue;
    }

    const [srRow] = await sql`
      SELECT body FROM atoms WHERE entity_type = 'setback-rule'
        AND body->>'parcelNodeId' = ${parcelNodeId}
      ORDER BY updated_at DESC NULLS LAST LIMIT 1
    `;
    const zoningFact = zfRow?.body ?? null;
    const setbackRule = srRow?.body ?? null;

    const servedDistrict = zoningFact?.district ?? setbackRule?.districtCode ?? null;
    const districtOk =
      (setbackRule?.districtCode == null ||
        setbackRule.districtCode.split(/\s+/)[0] === key.district) &&
      (zoningFact?.district == null ||
        zoningFact.district.split(/\s+/)[0] === key.district ||
        setbackRule?.districtCode?.split(/\s+/)[0] === key.district);

    const servedSetbacks = setbackRule
      ? {
          front: setbackRule.front,
          rear: setbackRule.rear,
          side: setbackRule.sideInteriorFt ?? setbackRule.side,
          sideCorner: setbackRule.sideCornerFt,
        }
      : null;
    const setbackServedOk =
      !!servedSetbacks &&
      servedSetbacks.front === key.F &&
      servedSetbacks.rear === key.R &&
      servedSetbacks.side === key.S &&
      (key.C == null || servedSetbacks.sideCorner === key.C);

    const labelResult = labelEdgesFromRoads({ parcelRing: ring, roads, situsAddress });
    const freshLabels = labelResult.ok ? labelResult.edgeLabels : [];

    let boundaryEdges = null;
    try {
      boundaryEdges = await readBoundaryEdgesForParcel(storage.storage, parcelNodeId);
    } catch (e) {
      if (!(e instanceof BoundaryPrimitiveMissingError)) throw e;
    }
    if (boundaryEdges?.length) {
      const ringVerts = openRing(ring).length;
      if (boundaryEdges.length > ringVerts) {
        boundaryEdges = boundaryEdges.filter((e) => e.edgeIndex < ringVerts);
      } else if (boundaryEdges.length < ringVerts) {
        boundaryEdges = null;
      }
    }
    // R28 — recompute primitive when stored normals disagree with BCAD ring.
    if (boundaryEdges?.length) {
      const ringVerts = openRing(ring).length;
      if (boundaryEdges.length === ringVerts) {
        const agree = primitiveNormalsAgreeWithRing(boundaryEdges, ring);
        if (!agree.ok) {
          const rebuilt = recomputeBoundaryEdgesForRing({
            storedEdges: boundaryEdges,
            ring,
            roads,
          });
          const rebuiltAgree = primitiveNormalsAgreeWithRing(rebuilt, ring);
          boundaryEdges = rebuiltAgree.ok ? rebuilt : null;
        }
      }
    }
    if (boundaryEdges?.length && labelResult.ok) {
      boundaryEdges = relabelBoundaryEdgesFromRoadLabels({
        storedEdges: boundaryEdges,
        edgeLabels: freshLabels,
        roads,
        countyFips: COUNTY,
      });
    }

    let warmCandidate = null;
    if (boundaryEdges?.length) {
      warmCandidate = computeWarmCandidateFromBoundary({
        parcelNodeId,
        district: key.district,
        parcelRing: ring,
        boundaryEdges,
        roads,
        descriptor,
      });
    }
    // Edge-count mismatch (TXGIO primitive vs BCAD ring): warm uses road-label path.
    if ((!warmCandidate || warmCandidate.empty) && labelResult.ok) {
      warmCandidate = computeWarmCandidate({
        parcelNodeId,
        district: key.district,
        parcelRing: ring,
        descriptor,
        roads,
        edgeLabels: freshLabels.map((e) => ({
          index: e.index,
          label: e.label,
          roadClass: e.roadClass,
          osmHighwayTag: e.osmHighwayTag,
          osmSurfaceTag: e.osmSurfaceTag,
          roadProvenanceKind: e.roadProvenanceKind,
        })),
      });
    }

    let setbackGate = { pass: false, reasons: ["no-warm-candidate"] };
    let engineOrient = { pass: false, reasons: ["no-warm-candidate"] };
    if (warmCandidate) {
      const full = verifyWarmCandidateMechanically(warmCandidate, descriptor, {
        situsAddress,
        roads,
      });
      setbackGate = full.gates.setbackEdgeDistance;
      engineOrient = verifyFrontEdgeOrientation(warmCandidate, descriptor, {
        situsAddress,
        roads,
      });
    }

    const freshFront = freshLabels.find((e) => e.label === "front");
    const answerFrontToken =
      rosterLoad.mode === "block13"
        ? key.frontStreet
        : key.frontStreet ?? situsFrontStreetToken(situsAddress);
    let frontStreetResolved = null;
    let frontFacesAnswer = !answerFrontToken;
    if (freshFront && answerFrontToken) {
      const backingRoad = roads.find((r) => r.osmWayId === freshFront.osmWayId) ?? null;
      frontStreetResolved = backingRoad?.name ?? null;
      if (frontStreetResolved) {
        frontFacesAnswer = streetNamesMatchForFacesAnswer(answerFrontToken, frontStreetResolved);
      }
    }

    const r32Measured = measurePerEdgeInsetForRings(ring, insetRing) ?? [];
    const nEdges = openRing(ring).length;
    let insetGatePass = true;
    for (let i = 0; i < nEdges; i++) {
      const role =
        freshLabels.find((e) => e.index === i)?.label ??
        warmCandidate?.edges.find((e) => e.index === i)?.label ??
        boundaryEdges?.find((e) => e.edgeIndex === i)?.role ??
        "?";
      const expected = expectedFtForRole(role, key);
      const r32 = r32Measured[i]?.insetFeet ?? null;
      const edgeOk = r32 != null && Math.abs(r32 - expected) <= INSET_TOL_FT;
      if (!edgeOk) insetGatePass = false;
      parcelResult.edges.push({
        edgeIndex: i,
        role,
        expectedFt: expected,
        r32IndexMatched_ft: r32 == null ? null : Number(r32.toFixed(2)),
        insetPass: edgeOk,
      });
    }

    const r35NoFrontage = isNoDeterminableFrontageSitus(situsAddress);

    parcelResult.gates = {
      district: {
        pass: districtOk,
        served: servedDistrict,
        servedSetbackRuleDistrict: setbackRule?.districtCode ?? null,
        expected: key.district,
      },
      setbacks: {
        pass: setbackServedOk && setbackGate.pass,
        served: servedSetbacks,
        expected: { front: key.F, rear: key.R, side: key.S, sideCorner: key.C },
        engineVerifyPass: setbackGate.pass,
      },
      perEdgeInset: { pass: insetGatePass },
      frontOrientation: {
        pass: r35NoFrontage || (frontFacesAnswer && engineOrient.pass),
        frontStreetResolved,
        answerFrontStreet: answerFrontToken,
        facesAnswer: frontFacesAnswer,
        engineOrientPass: engineOrient.pass,
        orientationHonestDecline: r35NoFrontage ? R35_ORIENTATION_DECLINE : null,
      },
    };

    if (r35NoFrontage) {
      parcelResult.orientationHonestDecline = R35_ORIENTATION_DECLINE;
    }

    parcelResult.pass =
      districtOk &&
      setbackServedOk &&
      setbackGate.pass &&
      insetGatePass &&
      (r35NoFrontage || (frontFacesAnswer && engineOrient.pass));

    if (parcelResult.pass) report.score.pass++;
    else report.score.fail++;
    report.parcels[parcelNodeId] = parcelResult;
  }

  report.score.label = `${report.score.pass}/${report.score.total}`;
  report.blockPass = report.score.fail === 0 && report.score.total > 0;
  if (rosterLoad.mode === "block13") {
    report.certRestore =
      report.score.pass === report.score.total ? "7/7 — CERT-RESTORE ELIGIBLE" : "STOP — not 7/7";
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.blockPass) process.exitCode = 1;
} finally {
  await sql.end();
  await txSql.end();
}
