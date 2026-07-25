#!/usr/bin/env node
/**
 * depth-warm-bastrop-pilot.mjs — R3 warm-then-verify over named Bastrop parcels.
 *
 * Depth-over-breadth: only parcels that already have zoning-facts on the ledger.
 * Warm → mechanical verify → promote when pass. Logs reject reasons for bad warm.
 *
 *   PROPERTY_ATOM_PATH=1 DATABASE_URL=... \
 *     pnpm --filter @hauska-engine/engine-core run depth-warm-bastrop-pilot
 *
 * Dry-run (no storage write):
 *   pnpm --filter @hauska-engine/engine-core run depth-warm-bastrop-pilot -- --dry-run
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import bastropDescriptor from "../src/property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import {
  PARCEL_714_SPRING_33512,
} from "../src/depth-warm/fixtures/parcelRings.ts";
import { projectRing } from "../src/depth-warm/geometry.ts";
import {
  injectBadWarmCandidate,
} from "../src/depth-warm/warm-compute.ts";
import { verifyWarmCandidateMechanically } from "../src/depth-warm/verify-mechanical.ts";
import { warmThenVerify } from "../src/depth-warm/warm-then-verify.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROAD_FIXTURE = join(
  HERE,
  "../src/road-intake/fixtures/bastrop-road-pilot.json",
);

const dryRun = process.argv.includes("--dry-run");
const demoBad = process.argv.includes("--demo-bad-reject");

const PILOT_PARCELS = [
  {
    parcelNodeId: "48021:33512",
    district: "P-5",
    ring: PARCEL_714_SPRING_33512,
    situsStreet: "Spring Street",
  },
];

function edgeLabelsForSpring714() {
  const n = projectRing(PARCEL_714_SPRING_33512).points.length;
  return Array.from({ length: n }, (_, index) => ({
    index,
    label: "front",
    roadClass: "residential",
    osmHighwayTag: "residential",
  }));
}

async function main() {
  const roadPilot = JSON.parse(readFileSync(ROAD_FIXTURE, "utf8"));
  const springWay = roadPilot.elements[0];
  const springRoad = {
    osmWayId: springWay.id,
    osmHighwayTag: springWay.tags.highway,
    name: springWay.tags.name,
    classification: "residential",
    polyline: springWay.geometry.map((g) => [g.lon, g.lat]),
  };

  let storage = null;
  let close = async () => {};
  if (!dryRun) {
    if (process.env.PROPERTY_ATOM_PATH !== "1") {
      console.error("FATAL: PROPERTY_ATOM_PATH=1 required for promote.");
      process.exit(1);
    }
    const url = resolveSubstrateDatabaseUrl();
    if (!url) {
      console.error("FATAL: DATABASE_URL or SUBSTRATE_DATABASE_URL required.");
      process.exit(1);
    }
    const handle = createPgStorage({ databaseUrl: url, maxConnections: 1 });
    storage = handle.storage;
    close = () => handle.close();
  }

  if (demoBad) {
    const parcel = PILOT_PARCELS[0];
    const good = {
      parcelNodeId: parcel.parcelNodeId,
      district: parcel.district,
      parcelRing: parcel.ring,
      descriptor: bastropDescriptor,
      roads: [springRoad],
      edgeLabels: edgeLabelsForSpring714(),
      zoningFactAtomDid: `did:hauska:zoning-fact:${parcel.parcelNodeId}`,
      promote: false,
    };
    const result = await warmThenVerify(good);
    const bad = injectBadWarmCandidate(result.candidate);
    const reject = verifyWarmCandidateMechanically(bad, bastropDescriptor);
    console.log(
      JSON.stringify(
        {
          event: "depth-warm.demo-bad-reject",
          pass: reject.pass,
          geometryReasons: reject.gates.geometry.reasons,
        },
        null,
        2,
      ),
    );
    await close();
    process.exit(reject.pass ? 1 : 0);
  }

  const results = [];
  for (const parcel of PILOT_PARCELS) {
    const result = await warmThenVerify({
      parcelNodeId: parcel.parcelNodeId,
      district: parcel.district,
      parcelRing: parcel.ring,
      descriptor: bastropDescriptor,
      roads: [springRoad],
      edgeLabels: edgeLabelsForSpring714(),
      zoningFactAtomDid: `did:hauska:zoning-fact:${parcel.parcelNodeId}`,
      storage: storage ?? undefined,
      promote: !dryRun && !!storage,
    });
    results.push({
      parcelNodeId: parcel.parcelNodeId,
      verifyPass: result.verify.pass,
      promoted: result.promoted,
      buildableAreaSqFt: result.candidate.buildableAreaSqFt,
      rejectReasons: result.verify.pass
        ? []
        : [
            ...result.verify.gates.geometry.reasons,
            ...result.verify.gates.roadClassification.reasons,
            ...result.verify.gates.setbackEdgeDistance.reasons,
          ],
    });
  }

  console.log(JSON.stringify({ event: "depth-warm-bastrop-pilot.done", dryRun, results }, null, 2));
  await close();
  const failed = results.filter((r) => !r.verifyPass);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("depth-warm-bastrop-pilot FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
