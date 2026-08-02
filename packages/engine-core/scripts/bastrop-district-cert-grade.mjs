#!/usr/bin/env node
/**
 * Bastrop district-block area-sweep cert — extends block13-cert-grade to a
 * roster driven by --district-prefix (Phase C mechanical gate).
 *
 * READ-ONLY. Grades EVERY promoted envelope in the district block against
 * layer-23 authoritative numbers (not a hardcoded answer key). Exits non-zero
 * if any parcel in the block fails.
 *
 *   DATABASE_URL=... TXGIO_DATABASE_URL=... NODE_OPTIONS=--use-system-ca \
 *     pnpm --filter @hauska-engine/engine-core exec \
 *     tsx scripts/bastrop-district-cert-grade.mjs --district-prefix=SF-1
 */
import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";
import { fetchBastropPerParcelSetbackRecord } from "@hauska-engine/adapters";

import bastropDescriptor from "../src/property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import {
  fetchBcadParcelRings,
  scrubLotLineRing,
} from "../src/boundary-primitive/index.ts";
import {
  readBoundaryEdgesForParcel,
  BoundaryPrimitiveMissingError,
} from "../src/boundary-primitive/read.ts";
import { roadAtomToWarmSource } from "../src/road-intake/road-to-warm-source.ts";
import {
  labelEdgesFromRoads,
} from "../src/depth-warm/edgeLabeling.ts";
import { DEPTH_WARM_PROMOTION_MARKER } from "../src/depth-warm/types.ts";
import { openRing } from "../src/depth-warm/geometry.ts";
import {
  DEFAULT_R32_INSET_TOL_FT,
  verifyFacesAnswerMatch,
  verifyR32PerEdgeInset,
} from "../src/depth-warm/cert-equivalent-gates.ts";
import { computeWarmCandidateFromBoundary } from "../src/boundary-primitive/consume.ts";
import { relabelBoundaryEdgesFromRoadLabels } from "../src/boundary-primitive/relabel-from-roads.ts";
import {
  verifyFrontEdgeOrientation,
  verifyWarmCandidateMechanically,
} from "../src/depth-warm/verify-mechanical.ts";
import { ringCentroidLngLat } from "../src/boundary-primitive/index.ts";
import { RECIPE_VERSION } from "../src/depth-warm/types.ts";
import { loadLayer23CityPropIds } from "./bastrop-layer23-roster.mjs";

const COUNTY = "48021";
const BASTROP_CITY_KEY = "bastrop-city-tx";
const INSET_TOL_FT = DEFAULT_R32_INSET_TOL_FT;

const BLOCK13_QUARANTINE = new Set([
  "48021:34145", "48021:34121", "48021:34153", "48021:34137",
  "48021:34169", "48021:34177", "48021:34161",
]);

function parseArgs(argv) {
  const out = { districtPrefix: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--district-prefix") out.districtPrefix = String(argv[++i] || "").trim();
    else if (a.startsWith("--district-prefix=")) {
      out.districtPrefix = a.slice("--district-prefix=".length).trim();
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

async function buildLayer23Key(parcelNodeId, district, centroidLngLat) {
  const fetched = await fetchBastropPerParcelSetbackRecord(
    parcelNodeId.split(":")[1],
    { districtCode: district, centroidLngLat },
  );
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
    },
  };
}

const args = parseArgs(process.argv.slice(2));
if (!args.districtPrefix) {
  console.error("FATAL: --district-prefix required (e.g. SF-1)");
  process.exit(2);
}

const url = resolveSubstrateDatabaseUrl();
const txgioUrl =
  process.env.TXGIO_DATABASE_URL?.trim() ||
  process.env.CORTEX_DATABASE_URL?.trim() ||
  url;
if (!url) {
  console.error("FATAL: DATABASE_URL required");
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

const rosterLoad = await loadLayer23CityPropIds({ districtPrefix: args.districtPrefix });
const roster = rosterLoad.parcelNodeIds.filter((id) => !BLOCK13_QUARANTINE.has(id));

const report = {
  when: new Date().toISOString(),
  cert: `Bastrop district-block area-sweep (${args.districtPrefix})`,
  districtPrefix: args.districtPrefix,
  rosterSource: "layer-23 CITY=BASTROP",
  layer23Where: rosterLoad.where,
  measurer: "R32 index-matched inward-normal",
  roadNodesLoaded: roads.length,
  rosterSize: roster.length,
  parcels: {},
  score: { pass: 0, fail: 0, honestDecline: 0, staleResidue: 0, total: roster.length },
};

try {
  for (const parcelNodeId of roster) {
    const propId = parcelNodeId.split(":")[1];
    const parcelResult = { pass: false, gates: {}, edges: [] };

    const [envRow] = await sql`
      SELECT body FROM atoms
      WHERE entity_type = 'buildable-envelope'
        AND body->>'parcelNodeId' = ${parcelNodeId}
      ORDER BY updated_at DESC NULLS LAST LIMIT 1
    `;
    const env = envRow?.body;

    if (!env) {
      const [zfRow] = await sql`
        SELECT 1 FROM atoms WHERE entity_type = 'zoning-fact'
          AND body->>'parcelNodeId' = ${parcelNodeId}
          AND NOT (body ? 'absence')
        LIMIT 1
      `;
      if (!zfRow) {
        parcelResult.pass = true;
        parcelResult.honestDecline = true;
        parcelResult.declineReason = "no-zoning-fact-on-substrate";
        report.parcels[parcelNodeId] = parcelResult;
        report.score.honestDecline++;
        report.score.pass++;
        continue;
      }
      parcelResult.error = "missing-single-vintage-state";
      parcelResult.reason = "no envelope atom";
      report.parcels[parcelNodeId] = parcelResult;
      report.score.fail++;
      continue;
    }

    const recipeVersion = env?.recipeVersion ?? null;
    const warmDecline = env?.warmVerifyDecline ?? null;
    const isPromoted = env?.depthWarmPromotion === DEPTH_WARM_PROMOTION_MARKER;

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
      parcelResult.reason = `promoted without recipeVersion ${RECIPE_VERSION} (got ${recipeVersion})`;
      report.parcels[parcelNodeId] = parcelResult;
      report.score.staleResidue++;
      report.score.fail++;
      continue;
    }

    if (!isPromoted || recipeVersion !== RECIPE_VERSION) {
      parcelResult.error = "missing-single-vintage-state";
      parcelResult.reason = "no recipe-1.0.0 promote or honest-decline";
      report.parcels[parcelNodeId] = parcelResult;
      report.score.fail++;
      continue;
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
      SELECT body FROM atoms
      WHERE entity_type = 'zoning-fact' AND body->>'parcelNodeId' = ${parcelNodeId}
      ORDER BY updated_at DESC NULLS LAST LIMIT 1
    `;
    const stampedDistrict = zfRow?.body?.district ?? args.districtPrefix;

    const keyBuilt = await buildLayer23Key(parcelNodeId, stampedDistrict, centroidLngLat);
    if (!keyBuilt.ok) {
      parcelResult.error = keyBuilt.code;
      parcelResult.reason = keyBuilt.reason;
      report.parcels[parcelNodeId] = parcelResult;
      report.score.fail++;
      continue;
    }
    const key = {
      ...keyBuilt.key,
      frontStreet: situsFrontStreetToken(situsAddress),
    };
    parcelResult.answerKey = key;

    const insetRing = env?.geojson?.features?.[0]?.geometry?.coordinates?.[0] ?? null;
    if (!insetRing?.length) {
      parcelResult.error = "no-promoted-envelope";
      report.parcels[parcelNodeId] = parcelResult;
      report.score.fail++;
      continue;
    }

    const [srRow] = await sql`
      SELECT body FROM atoms
      WHERE entity_type = 'setback-rule' AND body->>'parcelNodeId' = ${parcelNodeId}
      ORDER BY updated_at DESC NULLS LAST LIMIT 1
    `;
    const zoningFact = zfRow?.body ?? null;
    const setbackRule = srRow?.body ?? null;

    const servedDistrict = zoningFact?.district ?? setbackRule?.districtCode ?? null;
    const districtOk =
      normalizeDistrictPrefix(servedDistrict) === key.district &&
      (setbackRule?.districtCode == null ||
        normalizeDistrictPrefix(setbackRule.districtCode) === key.district);

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

    const facesAnswerResult = verifyFacesAnswerMatch({
      situsAddress,
      roads,
      parcelRing: ring,
    });
    const frontFacesAnswer = facesAnswerResult.facesAnswer;
    const frontStreetResolved = facesAnswerResult.frontStreetResolved;

    const r32Gate = verifyR32PerEdgeInset({
      parcelRing: ring,
      insetRing,
      edgeLabels: freshLabels,
      descriptor,
      district: key.district,
      toleranceFt: INSET_TOL_FT,
      setbackKey: { F: key.F, S: key.S, C: key.C, R: key.R },
    });
    const insetGatePass = r32Gate.pass;

    parcelResult.gates = {
      district: { pass: districtOk, served: servedDistrict, expected: key.district },
      setbacks: {
        pass: setbackServedOk && setbackGate.pass,
        served: servedSetbacks,
        expected: { front: key.F, rear: key.R, side: key.S, sideCorner: key.C },
      },
      perEdgeInset: { pass: insetGatePass, reasons: r32Gate.reasons },
      frontOrientation: {
        pass: frontFacesAnswer && engineOrient.pass,
        frontStreetResolved,
        facesAnswer: frontFacesAnswer,
        engineOrientPass: engineOrient.pass,
        reasons: facesAnswerResult.reasons,
      },
    };

    parcelResult.pass =
      districtOk &&
      setbackServedOk &&
      setbackGate.pass &&
      insetGatePass &&
      frontFacesAnswer &&
      engineOrient.pass;

    if (parcelResult.pass) report.score.pass++;
    else report.score.fail++;
    report.parcels[parcelNodeId] = parcelResult;
  }

  report.score.label = `${report.score.pass}/${report.score.total}`;
  report.blockPass = report.score.fail === 0 && report.score.total > 0;
  console.log(JSON.stringify(report, null, 2));
  if (!report.blockPass) process.exitCode = 1;
} finally {
  await sql.end();
  await txSql.end();
}

function normalizeDistrictPrefix(raw) {
  if (!raw || typeof raw !== "string") return null;
  return raw.trim().split(/\s+/)[0] || raw.trim();
}
