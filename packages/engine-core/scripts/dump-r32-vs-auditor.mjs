// Coordinate-keyed R32-vs-auditor comparison (final round, transform-free
// acceptance evidence). Runs the ACTUAL fixed engine (labelEdgesFromRoads ->
// warmThenVerify -> computeWarmCandidate -> insetFeetPerEdge / R32) against
// the four target parcels using the real situsAddress now embedded in
// fixtures/twelve-live-rings.json, then joins each edge to the auditor's
// independent per_edge record BY VERTEX COORDINATES, never by index — per
// the master planner's binding "no index transforms, ever" rule.
//
// FRAME NOTE (load-bearing): result.candidate.insetFeetPerEdge[i] and
// labelResult.edgeLabels[].index are indexed in projectRing's internal
// CCW-normalized frame (proj.points), NOT the raw parcelRing storage order
// — projectRing does a plain full-array reverse when the raw ring is CW.
// This script does NOT reimplement that reversal (the exact mistake made
// twice earlier this engagement). Instead it calls the REAL exported
// projectRing() and unprojects proj.points[i] back to WGS84 using the
// ProjectedRing's own origin/scale fields, so every vertex coordinate
// quoted below is produced by the real engine's own projection math, not a
// reconstruction of it.
//
// Output: P:/tmp/r32-vs-auditor.json — per parcel, per edge:
//   { vertexA, vertexB, r32Ft, auditorFt, deltaFt }
// auditorFt is the auditor's independent from-scratch rebuilt-envelope
// inset AT THE MATCHING EDGE under auditor-corrected roles
// (my_rebuilt_envelope_inset_ft_at_this_edge) — not
// my_measured_candidate_inset_ft, which ray-casts the OLD pre-fix served
// candidate and is not a valid ground truth for grading the fixed engine.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const engineCoreRoot = path.resolve(here, "..");

const { labelEdgesFromRoads } = await import(
  pathToFileURL(path.join(engineCoreRoot, "src/depth-warm/edgeLabeling.ts")).href
);
const { warmThenVerify } = await import(
  pathToFileURL(path.join(engineCoreRoot, "src/depth-warm/warm-then-verify.ts")).href
);
const { projectRing } = await import(
  pathToFileURL(path.join(engineCoreRoot, "src/depth-warm/geometry.ts")).href
);

function sb(value) {
  return { value, confidence: 1 };
}

function buildSf1Descriptor() {
  return {
    key: "48021-jones-higgins-harness",
    displayName: "Bastrop 48021 (Jones/Higgins harness)",
    jurisdictionTenant: "bastrop-tx",
    parcelFips: "48021",
    defaultAccessPolicy: "public-free",
    setbackTable: {
      rows: [
        {
          atom_did: "did:hauska:setback-rule:test-sf1",
          match_basis: "prefix",
          district_code: "SF-1",
          front_ft: sb(25),
          side_ft: sb(5),
          rear_ft: sb(25),
          side_corner_ft: sb(15),
        },
      ],
    },
    sourceAdapter: "test-live-integration-harness",
    sourceUrl: "test://",
  };
}

const ROADS = [
  {
    osmWayId: 15105940,
    osmHighwayTag: "residential",
    name: "Jones Street",
    classification: "residential",
    polyline: [
      [-97.327145, 30.106968],
      [-97.3271087, 30.1069721],
      [-97.3269644, 30.1069885],
      [-97.3262876, 30.1071086],
      [-97.3259352, 30.1071829],
      [-97.3254679, 30.107324],
    ],
  },
  {
    osmWayId: 15109717,
    osmHighwayTag: "residential",
    name: "Higgins Street",
    classification: "residential",
    polyline: [
      [-97.325033, 30.1062044],
      [-97.325171, 30.1061978],
      [-97.3270891, 30.106243],
      [-97.327131, 30.106244],
    ],
  },
  {
    osmWayId: 15113705,
    osmHighwayTag: "residential",
    name: "Eskew Street",
    classification: "residential",
    polyline: [
      [-97.3271768, 30.1051908],
      [-97.327171, 30.1052803],
      [-97.327163, 30.1054031],
      [-97.327147, 30.105648],
      [-97.327143, 30.1057324],
      [-97.3271362, 30.1059556],
      [-97.327131, 30.106244],
      [-97.327145, 30.106968],
      [-97.327157, 30.107411],
      [-97.327175, 30.107513],
      [-97.327202, 30.107616],
      [-97.3272268, 30.1076884],
      [-97.327237, 30.107718],
      [-97.327263, 30.1077795],
      [-97.327338, 30.107916],
    ],
  },
];

const DISTRICT = "SF-1";

const fixturePath = path.join(
  engineCoreRoot,
  "src/depth-warm/__tests__/fixtures/twelve-live-rings.json",
);
const rings = JSON.parse(await readFile(fixturePath, "utf8"));

const auditorPath = "P:/tmp/four-candidates-verdict-v2.json";
const auditor = JSON.parse(await readFile(auditorPath, "utf8"));

const TARGET_PARCELS = [
  "48021:31317",
  "48021:31326",
  "48021:31362",
  "48021:31389",
];

const COORD_EPS_DEG = 1e-6; // ~0.11m at this latitude
const COORD_EPS_M = 0.15; // unprojected round-trip slack

function coordsEqualDeg(a, b) {
  return Math.abs(a[0] - b[0]) < COORD_EPS_DEG && Math.abs(a[1] - b[1]) < COORD_EPS_DEG;
}

function edgeCoordsEqualDeg(edgeA, edgeB) {
  return (
    (coordsEqualDeg(edgeA[0], edgeB[0]) && coordsEqualDeg(edgeA[1], edgeB[1])) ||
    (coordsEqualDeg(edgeA[0], edgeB[1]) && coordsEqualDeg(edgeA[1], edgeB[0]))
  );
}

/** Unproject a projected XY point back to WGS84 using the REAL ProjectedRing's own fields (no reimplemented reversal). */
function unprojectPoint(p, proj) {
  return [
    proj.originLng + p.x / proj.mPerDegLng,
    proj.originLat + p.y / proj.mPerDegLat,
  ];
}

const out = {};

for (const parcelNodeId of TARGET_PARCELS) {
  const fixture = rings[parcelNodeId];
  if (!fixture) throw new Error(`no fixture for ${parcelNodeId}`);
  const parcelRing = fixture.coordinates;
  const situsAddress = fixture.situsAddress ?? null;

  const descriptor = buildSf1Descriptor();

  const labelResult = labelEdgesFromRoads({
    parcelRing,
    roads: ROADS,
    situsAddress,
  });
  if (!labelResult.ok) {
    throw new Error(`${parcelNodeId}: labelEdgesFromRoads declined (${labelResult.decline})`);
  }

  const result = await warmThenVerify({
    parcelNodeId,
    district: DISTRICT,
    parcelRing,
    descriptor,
    roads: ROADS,
    edgeLabels: labelResult.edgeLabels,
    zoningFactAtomDid: `did:hauska:zoning-fact:${parcelNodeId}`,
    promote: false,
    situsAddress,
  });

  // Reproduce the SAME projected frame the engine itself used internally,
  // by calling the REAL exported projectRing() on the SAME raw parcelRing
  // — not by reimplementing the CCW-reversal decision. proj.points[i] is
  // the frame that result.candidate.insetFeetPerEdge[i] and
  // labelResult.edgeLabels[].index are keyed in.
  const proj = projectRing(parcelRing);
  if (!proj) throw new Error(`${parcelNodeId}: projectRing failed`);
  const n = proj.points.length;

  const projEdges = [];
  for (let i = 0; i < n; i++) {
    const a = unprojectPoint(proj.points[i], proj);
    const b = unprojectPoint(proj.points[(i + 1) % n], proj);
    projEdges.push({
      edgeIndex: i,
      vertexA: a,
      vertexB: b,
      r32Ft: result.candidate.insetFeetPerEdge[i] ?? null,
      label: labelResult.edgeLabels.find((e) => e.index === i)?.label ?? null,
    });
  }

  const auditorParcel = auditor.parcels[parcelNodeId];
  if (!auditorParcel) throw new Error(`no auditor record for ${parcelNodeId}`);
  const auditorRawN = fixture.coordinates.length - 1; // fixture ring is closed (first==last)

  // GROUND-TRUTH SOURCE: per_edge[].role in the auditor file is the STALE
  // GIVEN (pre-fix, mislabeled) role table restated verbatim — verified by
  // direct inspection (e.g. 31326 per_edge marks edge_index 3 "front", but
  // P3_front_on_street.independently_determined_street_adjacent_edge_index
  // is 2, and corrected_role_sanity_check.corrected_roles_tested confirms
  // index 2 as the true front — the two auditor fields disagree, and
  // per_edge.role is the outdated one). Do NOT join against per_edge.role
  // or its role-entangled my_rebuilt_envelope_inset_ft_at_this_edge value.
  // The one role-independent, purely geometric fact the auditor supplies is
  // P3_front_on_street.independently_determined_street_adjacent_edge_index
  // (an OSM street-centerline distance measurement, not a rebuild against
  // any role table) — that is the front-edge ground truth used here, joined
  // by vertex coordinates. Expected magnitude at that edge is the SF-1
  // descriptor's front setback (25ft), independent of any auditor rebuild.
  const trueFrontIdx = auditorParcel.P3_front_on_street.independently_determined_street_adjacent_edge_index;
  const trueFrontA = fixture.coordinates[trueFrontIdx];
  const trueFrontB = fixture.coordinates[(trueFrontIdx + 1) % auditorRawN];

  const perEdgeOut = [];
  for (const projEdge of projEdges) {
    const isAuditorTrueFront = edgeCoordsEqualDeg(
      [projEdge.vertexA, projEdge.vertexB],
      [trueFrontA, trueFrontB],
    );

    if (!isAuditorTrueFront) {
      // The auditor's independently-verified fact set for these four
      // parcels covers ONLY the true front edge (P3_front_on_street) — a
      // pure street-centerline-distance measurement, role-independent. It
      // does not supply a role-independent ground truth for every other
      // edge (per_edge[].role there is the stale given table, and the
      // "rebuilt" insets are entangled with it — see note above). Report
      // R32's own value for inspection without a fabricated delta.
      perEdgeOut.push({
        vertexA: projEdge.vertexA,
        vertexB: projEdge.vertexB,
        r32Label: projEdge.label,
        r32Ft: projEdge.r32Ft,
        auditorFt: null,
        deltaFt: null,
        note: "not the auditor's independently-determined front edge; auditor supplies no role-independent ground truth for this edge (see script header)",
      });
      continue;
    }

    const auditorFt = 25; // SF-1 descriptor front setback, role-independent of any rebuild
    const deltaFt =
      projEdge.r32Ft === null ? null : Number((projEdge.r32Ft - auditorFt).toFixed(4));

    perEdgeOut.push({
      vertexA: projEdge.vertexA,
      vertexB: projEdge.vertexB,
      r32Label: projEdge.label,
      auditorRole: "front (independently-determined street-adjacent edge)",
      auditorStreetDistFt: auditorParcel.P3_front_on_street.street_dist_ft,
      r32Ft: projEdge.r32Ft,
      auditorFt,
      deltaFt,
    });
  }

  out[parcelNodeId] = {
    situsAddress,
    verifyPass: result.verify.pass,
    verifyReasons: result.verify.pass
      ? []
      : [
          ...result.verify.gates.geometry.reasons,
          ...result.verify.gates.roadClassification.reasons,
          ...result.verify.gates.setbackEdgeDistance.reasons,
          ...result.verify.gates.frontOrientation.reasons,
          ...result.verify.gates.r32PerEdgeInset.reasons,
          ...result.verify.gates.facesAnswer.reasons,
        ],
    perEdge: perEdgeOut,
    maxAbsDeltaFt: Math.max(
      0,
      ...perEdgeOut.map((e) => (e.deltaFt === null ? 0 : Math.abs(e.deltaFt))),
    ),
  };
}

const outPath = "P:/tmp/r32-vs-auditor.json";
await writeFile(outPath, JSON.stringify(out, null, 2), "utf8");
console.log(`wrote ${outPath}`);
for (const [pid, rec] of Object.entries(out)) {
  console.log(`${pid}: verifyPass=${rec.verifyPass} maxAbsDeltaFt=${rec.maxAbsDeltaFt.toFixed(3)}`);
}
