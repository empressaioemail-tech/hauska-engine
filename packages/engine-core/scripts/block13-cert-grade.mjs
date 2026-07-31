#!/usr/bin/env node
/**
 * Block-13 CERT-RESTORE mechanical grade — read-only, durable cert script.
 *
 * Grades the 7 downtown-Bastrop Block-13 parcels against the answer key on four
 * mechanical gates per parcel, all fail-closed:
 *   1. district           — served zoning-fact + setback-rule districtCode ==
 *                           answer key.
 *   2. setbacks           — served setback-rule per-role numbers == answer key
 *                           (F/S/corner/R) read directly off the served atom.
 *   3. per-edge inset      — R32 INDEX-MATCHED inward-normal inset (the shipped
 *                           measurePerEdgeInsetForRings, NOT perpendicular-to-
 *                           nearest-edge) matches the role's expected setback on
 *                           each edge. Index-matched is the only method that
 *                           recovers correct insets on the irregular lots
 *                           (34121 L-hexagon, 34177 MU notch).
 *   4. front orientation   — the FRESH labelEdgesFromRoads front edge's backing
 *                           road name token-matches the answer-key front street,
 *                           using the SAME situs-street-match / road-node data
 *                           the engine's labelEdgesFromRoads uses. No ad-hoc
 *                           nearest-street re-derivation (that returned null in
 *                           read-only runs).
 *
 * READ-ONLY. No prod writes, no re-warm. Rings come from live BCAD ArcGIS;
 * envelopes + roads + situs come from serving Neon (DATABASE_URL atoms,
 * CORTEX_DATABASE_URL / TXGIO_DATABASE_URL txgio situs). Exits non-zero if the
 * block does not grade 7/7 so callers can gate on it.
 *
 * Run:
 *   DATABASE_URL=... CORTEX_DATABASE_URL=... \
 *     pnpm --filter @hauska-engine/engine-core exec \
 *     tsx scripts/block13-cert-grade.mjs
 */
import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

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
  normalizeStreetNameForMatch,
} from "../src/depth-warm/edgeLabeling.ts";
import { DEPTH_WARM_PROMOTION_MARKER } from "../src/depth-warm/types.ts";
import { openRing } from "../src/depth-warm/geometry.ts";
import { measurePerEdgeInsetForRings } from "../src/depth-warm/measure-inset.ts";
import { computeWarmCandidateFromBoundary } from "../src/boundary-primitive/consume.ts";
import { relabelBoundaryEdgesFromRoadLabels } from "../src/boundary-primitive/relabel-from-roads.ts";
import {
  verifyFrontEdgeOrientation,
  verifyWarmCandidateMechanically,
} from "../src/depth-warm/verify-mechanical.ts";

const COUNTY = "48021";

/** The 7 Block-13 parcels. */
const BLOCK13 = [
  "48021:34145",
  "48021:34121",
  "48021:34153",
  "48021:34137",
  "48021:34169",
  "48021:34177",
  "48021:34161",
];

/** Answer key: district, setbacks (F/S/corner/R ft), front street. */
const ANSWER_KEY = {
  "48021:34145": { situs: "909 Pecan", district: "GC", F: 20, S: 5, C: null, R: 20, frontStreet: "Pecan" },
  "48021:34121": { situs: "907 Chestnut", district: "GC", F: 20, S: 5, C: null, R: 20, frontStreet: "Chestnut" },
  "48021:34153": { situs: "909 Chestnut", district: "GC", F: 20, S: 5, C: null, R: 20, frontStreet: "Chestnut" },
  "48021:34137": { situs: "908 Pine", district: "SF-1", F: 25, S: 5, C: 15, R: 25, frontStreet: "Pine" },
  "48021:34169": { situs: "906 Pine", district: "SF-1", F: 25, S: 5, C: 15, R: 25, frontStreet: "Pine" },
  "48021:34177": { situs: "901 Pecan", district: "MU", F: 15, S: 5, C: null, R: 15, frontStreet: "Pecan" },
  "48021:34161": { situs: "905 Pecan", district: "MU", F: 15, S: 5, C: null, R: 15, frontStreet: "Pecan" },
};

/** Expected inset (ft) for an edge role given the answer-key setbacks. */
function expectedFtForRole(role, key) {
  if (role === "front") return key.F;
  if (role === "rear") return key.R;
  if (role === "side_corner") return key.C ?? key.S;
  return key.S;
}

const INSET_TOL_FT = 1.0;

const url = resolveSubstrateDatabaseUrl();
const txgioUrl =
  process.env.TXGIO_DATABASE_URL?.trim() ||
  process.env.CORTEX_DATABASE_URL?.trim() ||
  url;
if (!url) {
  console.error("FATAL: DATABASE_URL (atoms) required");
  process.exit(2);
}

const sql = postgres(url, { ssl: "require", max: 2, prepare: false });
const txSql = postgres(txgioUrl, { ssl: "require", max: 2, prepare: false });
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

const report = {
  when: new Date().toISOString(),
  cert: "BLOCK-13 CERT-RESTORE mechanical grade",
  measurer: "R32 index-matched inward-normal (measurePerEdgeInsetForRings)",
  orientationGate: "fresh labelEdgesFromRoads front-edge road-name token-match vs answer key",
  roadNodesLoaded: roads.length,
  parcels: {},
  score: { pass: 0, total: BLOCK13.length },
};

try {
  for (const parcelNodeId of BLOCK13) {
    const propId = parcelNodeId.split(":")[1];
    const key = ANSWER_KEY[parcelNodeId];
    const parcelResult = {
      situs: null,
      district: key.district,
      answerKey: key,
      gates: {},
      edges: [],
      pass: false,
    };

    // Situs (front-street source) from txgio (CORTEX/TXGIO Neon).
    const [situsRow] = await txSql`
      SELECT situs_address FROM txgio_parcel
      WHERE county_fips = ${COUNTY} AND prop_id = ${propId} LIMIT 1
    `;
    const situsAddress = situsRow?.situs_address?.trim() ?? null;
    parcelResult.situs = situsAddress;

    // Authoritative parcel ring from live BCAD ArcGIS.
    const bcad = await fetchBcadParcelRings([propId]);
    const ring = scrubLotLineRing(bcad[0]?.ring);
    if (!ring) {
      parcelResult.error = "no-ring";
      report.parcels[parcelNodeId] = parcelResult;
      continue;
    }

    // Served promoted envelope (read-only) from atoms Neon.
    const [envRow] = await sql`
      SELECT body FROM atoms
      WHERE entity_type = 'buildable-envelope'
        AND body->>'parcelNodeId' = ${parcelNodeId}
        AND body->>'depthWarmPromotion' = ${DEPTH_WARM_PROMOTION_MARKER}
      ORDER BY updated_at DESC NULLS LAST LIMIT 1
    `;
    const env = envRow?.body;
    const insetRing = env?.geojson?.features?.[0]?.geometry?.coordinates?.[0] ?? null;
    if (!insetRing?.length) {
      parcelResult.error = "no-promoted-envelope-geojson";
      report.parcels[parcelNodeId] = parcelResult;
      continue;
    }

    // Served district + setbacks come off the actual served atoms:
    // zoning-fact.district and setback-rule.districtCode / per-role fields.
    const [zfRow] = await sql`
      SELECT body FROM atoms
      WHERE entity_type = 'zoning-fact' AND body->>'parcelNodeId' = ${parcelNodeId}
      ORDER BY updated_at DESC NULLS LAST LIMIT 1
    `;
    const [srRow] = await sql`
      SELECT body FROM atoms
      WHERE entity_type = 'setback-rule' AND body->>'parcelNodeId' = ${parcelNodeId}
      ORDER BY updated_at DESC NULLS LAST LIMIT 1
    `;
    const zoningFact = zfRow?.body ?? null;
    const setbackRule = srRow?.body ?? null;

    const servedDistrict = zoningFact?.district ?? setbackRule?.districtCode ?? null;
    const districtOk =
      servedDistrict === key.district &&
      (setbackRule?.districtCode == null || setbackRule.districtCode === key.district);

    // Served per-role setbacks (from the served setback-rule atom) vs answer key.
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

    // Fresh road/situs labeling — the SAME data path the engine promotes with.
    const labelResult = labelEdgesFromRoads({ parcelRing: ring, roads, situsAddress });
    const freshLabels = labelResult.ok ? labelResult.edgeLabels : [];

    // Stored boundary edges → relabel from fresh road labels (mirrors re-warm).
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

    // Gate 2 (setbacks) + engine front-orientation gate — engine's own verifiers.
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

    // Gate 4 (front orientation) — clean, road-node-backed, read-only-safe:
    // take the FRESH front edge, resolve its backing road by osmWayId, and
    // confirm the road name token-matches the answer-key front street using the
    // engine's own street normalizer. No ad-hoc nearest-street measurement.
    const freshFront = freshLabels.find((e) => e.label === "front");
    const answerFrontKey = normalizeStreetNameForMatch(key.frontStreet);
    let frontStreetResolved = null;
    let frontFacesAnswer = false;
    if (freshFront) {
      const backingRoad =
        roads.find((r) => r.osmWayId === freshFront.osmWayId) ?? null;
      frontStreetResolved = backingRoad?.name ?? null;
      if (frontStreetResolved) {
        const roadKey = normalizeStreetNameForMatch(frontStreetResolved);
        frontFacesAnswer =
          roadKey === answerFrontKey ||
          roadKey.includes(answerFrontKey) ||
          answerFrontKey.includes(roadKey);
      }
    }

    // Gate 3 (per-edge inset) — R32 index-matched inward-normal.
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
        servedAtomMatch: setbackServedOk,
        engineVerifyPass: setbackGate.pass,
        engineVerifyReasons: setbackGate.reasons?.slice(0, 3),
      },
      perEdgeInset: { pass: insetGatePass },
      frontOrientation: {
        pass: frontFacesAnswer && engineOrient.pass,
        freshFrontEdgeIndex: freshFront?.index ?? null,
        frontBasis: freshFront?.frontBasis ?? null,
        frontStreetResolved,
        answerFrontStreet: key.frontStreet,
        facesAnswer: frontFacesAnswer,
        engineOrientPass: engineOrient.pass,
        engineOrientReasons: engineOrient.reasons?.slice(0, 3),
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
    report.parcels[parcelNodeId] = parcelResult;
  }

  report.score.label = `${report.score.pass}/${report.score.total}`;
  const clean = report.score.pass === report.score.total;
  report.certRestore = clean ? "7/7 — CERT-RESTORE ELIGIBLE" : "STOP — not 7/7";
  console.log(JSON.stringify(report, null, 2));
  if (!clean) process.exitCode = 1;
} finally {
  await sql.end();
  await txSql.end();
}
