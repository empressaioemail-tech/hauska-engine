#!/usr/bin/env node
/**
 * migrate-bastrop-road-legacy-synthetic-ids.mjs — F5: rewrite positive legacy county
 * synthetic osmWayId bands to the negative F5 namespace (newOsmWayId = -oldOsmWayId).
 *
 *   ROAD_LEGACY_MIGRATION_PATH=1 SUBSTRATE_DATABASE_URL=...direct... \
 *     pnpm --filter @hauska-engine/engine-core exec tsx \
 *       scripts/migrate-bastrop-road-legacy-synthetic-ids.mjs [--apply]
 *
 * Default dry-run. --apply executes delete-old + insert-new (PK atom_did change).
 */

import { performance } from "node:perf_hooks";

import { buildAtomDid, isRoadNodeAtomInstance, roadNodeIdFromParts } from "@hauska-engine/atoms";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import { sha256HexCanonical } from "../src/property-reasoning/confidence.ts";
import { verifyStoredRoadNodeAtom } from "../src/road-node/index.ts";
import {
  COUNTY_ROAD_ID_OFFSET,
  COUNTY_ROADWAY_ID_OFFSET,
  isReservedPositiveSyntheticMintWindow,
  LEGACY_COUNTY_ROADWAY_ID_MAX,
  LEGACY_COUNTY_ROADWAY_ID_MIN,
  LEGACY_COUNTY_SURVEYED_ID_MAX,
  LEGACY_COUNTY_SURVEYED_ID_MIN,
} from "../src/road-intake/classify-county-street.ts";

const COUNTY_FIPS = "48021";

function directDatabaseUrl(raw) {
  return raw.replace("-pooler.", ".");
}

function parseArgs(argv) {
  return { apply: argv.includes("--apply") };
}

function osmWayBand(osmWayId) {
  const w = Number(osmWayId);
  if (!Number.isFinite(w)) return "invalid";
  if (w >= LEGACY_COUNTY_ROADWAY_ID_MIN && w <= LEGACY_COUNTY_ROADWAY_ID_MAX) {
    return "legacyPositiveRoadway";
  }
  if (w >= LEGACY_COUNTY_SURVEYED_ID_MIN && w <= LEGACY_COUNTY_SURVEYED_ID_MAX) {
    return "legacyPositiveSurveyed";
  }
  if (w < 0 && w <= COUNTY_ROADWAY_ID_OFFSET && w > COUNTY_ROAD_ID_OFFSET) {
    return "f5NegativeRoadway";
  }
  if (w < 0 && w <= COUNTY_ROAD_ID_OFFSET) {
    return "f5NegativeSurveyed";
  }
  return "other";
}

function emptyBandCounts() {
  return {
    legacyPositiveRoadway: 0,
    legacyPositiveSurveyed: 0,
    f5NegativeRoadway: 0,
    f5NegativeSurveyed: 0,
    other: 0,
  };
}

function tallyBand(counts, osmWayId) {
  const band = osmWayBand(osmWayId);
  if (band in counts) counts[band] += 1;
  else counts.other += 1;
}

function rewriteLegacyRoadNode(body) {
  if (!isRoadNodeAtomInstance(body)) {
    throw new Error(`row is not a road-node instance: ${body?.atomDid ?? "unknown"}`);
  }
  const oldOsmWayId = Number(body.osmWayId);
  if (!isReservedPositiveSyntheticMintWindow(oldOsmWayId)) {
    throw new Error(
      `osmWayId ${oldOsmWayId} outside reserved legacy windows for ${body.atomDid}`,
    );
  }
  const newOsmWayId = -oldOsmWayId;
  if (newOsmWayId !== -oldOsmWayId) {
    throw new Error(`newOsmWayId invariant failed for ${body.atomDid}`);
  }

  const roadNodeId = roadNodeIdFromParts(COUNTY_FIPS, newOsmWayId);
  const entityId = roadNodeId;
  const atomDid = buildAtomDid("road-node", entityId).raw;

  const next = {
    ...body,
    osmWayId: newOsmWayId,
    roadNodeId,
    entityId,
    atomDid,
  };

  if (typeof next.versionStamp === "string") {
    const suffixMatch = next.versionStamp.match(/:road-node:(.*)$/);
    if (suffixMatch) {
      next.versionStamp = `${roadNodeId}:road-node:${suffixMatch[1]}`;
    }
  }

  next.contentHash = sha256HexCanonical(JSON.stringify({ ...next, contentHash: "" }));
  return {
    oldAtomDid: body.atomDid,
    newAtomDid: atomDid,
    oldOsmWayId,
    newOsmWayId,
    migrated: next,
  };
}

if (process.env.ROAD_LEGACY_MIGRATION_PATH !== "1") {
  console.error("FATAL: ROAD_LEGACY_MIGRATION_PATH=1 required.");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const rawUrl = resolveSubstrateDatabaseUrl();
if (!rawUrl) {
  console.error("FATAL: SUBSTRATE_DATABASE_URL (or DATABASE_URL) required.");
  process.exit(1);
}

const substrateUrl = directDatabaseUrl(rawUrl);
if (args.apply && substrateUrl.includes("-pooler.")) {
  console.error("FATAL: refuse pooler URL for --apply; strip -pooler. from host.");
  process.exit(1);
}

if (args.apply && process.env.PROPERTY_ATOM_PATH !== "1") {
  console.error("FATAL: PROPERTY_ATOM_PATH=1 required for --apply writes.");
  process.exit(1);
}

const t0 = performance.now();
const handle = createPgStorage({ databaseUrl: substrateUrl, maxConnections: 4 });

const bastropActiveRows = await handle.sql`
  SELECT atom_did, body
  FROM atoms
  WHERE entity_type = 'road-node'
    AND body->>'countyFips' = ${COUNTY_FIPS}
    AND COALESCE(body->>'status', 'active') = 'active'
`;

const bastropCountBefore = bastropActiveRows.length;
const bandBefore = emptyBandCounts();
for (const row of bastropActiveRows) {
  tallyBand(bandBefore, row.body?.osmWayId);
}

const legacyRows = bastropActiveRows.filter((row) => {
  const w = Number(row.body?.osmWayId);
  return isReservedPositiveSyntheticMintWindow(w);
});

const migrations = [];
const collisionNewDids = [];

for (const row of legacyRows) {
  const plan = rewriteLegacyRoadNode(row.body);
  migrations.push(plan);
}

if (migrations.length > 0) {
  const newDids = migrations.map((m) => m.newAtomDid);
  const existing = await handle.sql`
    SELECT atom_did FROM atoms WHERE atom_did = ANY(${newDids})
  `;
  for (const ex of existing) {
    collisionNewDids.push(ex.atom_did);
  }
}

if (collisionNewDids.length > 0) {
  console.error(
    JSON.stringify({
      event: "f5.bastrop-road-legacy-migration.collision",
      collisionNewDids,
      count: collisionNewDids.length,
    }),
  );
  await handle.close();
  process.exit(1);
}

let linksUpdated = 0;
let verifyPass = true;
let rowsMigrated = 0;

if (args.apply) {
  for (const plan of migrations) {
    await handle.storage.writeRoadAtom(plan.migrated);

    const linkFrom = await handle.sql`
      UPDATE atom_links SET from_atom_did = ${plan.newAtomDid}
      WHERE from_atom_did = ${plan.oldAtomDid}
      RETURNING 1
    `;
    const linkTo = await handle.sql`
      UPDATE atom_links SET to_atom_did = ${plan.newAtomDid}
      WHERE to_atom_did = ${plan.oldAtomDid}
      RETURNING 1
    `;
    linksUpdated += linkFrom.length + linkTo.length;

    await handle.sql`
      DELETE FROM atoms WHERE atom_did = ${plan.oldAtomDid}
    `;

    const stored = await handle.sql`
      SELECT body FROM atoms WHERE atom_did = ${plan.newAtomDid}
    `;
    const back = stored[0]?.body;
    const verdict = verifyStoredRoadNodeAtom(back, {
      roadNodeId: plan.migrated.roadNodeId,
      entityId: plan.migrated.entityId,
      atomDid: plan.migrated.atomDid,
    });
    if (!verdict.ok) {
      verifyPass = false;
      console.error(
        JSON.stringify({
          event: "f5.bastrop-road-legacy-migration.verify-fail",
          oldAtomDid: plan.oldAtomDid,
          newAtomDid: plan.newAtomDid,
          verdict,
        }),
      );
      break;
    }
    if (Number(back?.osmWayId) !== plan.newOsmWayId) {
      verifyPass = false;
      console.error(
        JSON.stringify({
          event: "f5.bastrop-road-legacy-migration.osm-verify-fail",
          newAtomDid: plan.newAtomDid,
          expected: plan.newOsmWayId,
          actual: back?.osmWayId,
        }),
      );
      break;
    }
    rowsMigrated += 1;
  }

  if (!verifyPass) {
    await handle.close();
    process.exit(1);
  }
}

const bastropAfterRows = args.apply
  ? await handle.sql`
      SELECT body->>'osmWayId' AS osm_way_id
      FROM atoms
      WHERE entity_type = 'road-node'
        AND body->>'countyFips' = ${COUNTY_FIPS}
        AND COALESCE(body->>'status', 'active') = 'active'
    `
  : bastropActiveRows.map((r) => ({ osm_way_id: String(r.body?.osmWayId) }));

const bastropCountAfter = bastropAfterRows.length;
const bandAfter = emptyBandCounts();
for (const row of bastropAfterRows) {
  if (args.apply) {
    tallyBand(bandAfter, row.osm_way_id);
  } else {
    const w = Number(row.osm_way_id ?? row.body?.osmWayId);
    if (isReservedPositiveSyntheticMintWindow(w)) {
      tallyBand(bandAfter, -w);
    } else {
      tallyBand(bandAfter, w);
    }
  }
}

const report = {
  event: "f5.bastrop-road-legacy-migration.done",
  dryRun: !args.apply,
  countyFips: COUNTY_FIPS,
  rowsMigrated: args.apply ? rowsMigrated : migrations.length,
  linksUpdated: args.apply ? linksUpdated : null,
  bandBefore,
  bandAfter,
  verifyPass: args.apply ? verifyPass : null,
  bastropCountBefore,
  bastropCountAfter: args.apply ? bastropCountAfter : bastropCountBefore,
  bastropCountAfterPredicted: args.apply
    ? bastropCountAfter
    : bastropCountBefore,
  legacyWindows: {
    roadway: [LEGACY_COUNTY_ROADWAY_ID_MIN, LEGACY_COUNTY_ROADWAY_ID_MAX],
    surveyed: [LEGACY_COUNTY_SURVEYED_ID_MIN, LEGACY_COUNTY_SURVEYED_ID_MAX],
  },
  elapsedMs: Math.round(performance.now() - t0),
  sample: migrations.slice(0, 3).map((m) => ({
    oldAtomDid: m.oldAtomDid,
    newAtomDid: m.newAtomDid,
    oldOsmWayId: m.oldOsmWayId,
    newOsmWayId: m.newOsmWayId,
    roadNodeId: m.migrated.roadNodeId,
  })),
};

console.log(JSON.stringify(report));
await handle.close();


