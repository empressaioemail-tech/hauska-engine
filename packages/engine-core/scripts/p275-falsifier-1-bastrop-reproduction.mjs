/**
 * P-275 FALSIFIER 1 + the reader's own controls, in one re-runnable instrument.
 *
 *   FALSIFIER 1: "Pointed at Bastrop, the new sources' review reproduces P-212's live count within
 *   1 percent."
 *
 * P-212 retired 57,704 Bastrop parcel nodes, found 56,691 live (98.244%) and reactivated them; the
 * 1,013 residual is what P-275 classifies. Today's candidate set is ONLY that residual, so the
 * falsifier can only be tested by re-running the same reading over the population P-212 judged --
 * the 56,691 nodes carrying `reactivatedAt` are the positive controls, read straight from the
 * atoms store rather than from a scratch file.
 *
 * What it measures, with the registered reader and nothing else:
 *   reactivatedSample  live share over the P-212-reactivated population   (98.244% to reproduce)
 *   residual           live share over the 1,013 residual                 (0 to corroborate)
 *   planRowSample      live share over 300 random current plan rows       (the county baseline)
 *   negativeControl    a fabricated id must read ABSENT, never live
 *
 * A reader that called everything live would pass the first row and fail the last; a reader that
 * called everything absent would pass "residual" and fail the reactivated sample. Both controls
 * are in the same process, against the same service, in the same run.
 *
 * Run (read-only; DATABASE_URL = hauska_mcp atoms, TXGIO_DATABASE_URL = neondb serving):
 *   NODE_OPTIONS=--use-system-ca npx tsx scripts/p275-falsifier-1-bastrop-reproduction.mjs
 */
import postgres from "postgres";
import { LIVE_CURRENCY_SOURCES } from "./county-live-currency-sources.mjs";

const atoms = postgres(process.env.DATABASE_URL, { max: 2 }); // hauska_mcp, never neondb
const serving = postgres(process.env.TXGIO_DATABASE_URL, { max: 2 });

const SAMPLE = Number(process.env.P275_SAMPLE ?? 5000);

// ---- the population P-212 reactivated, as the store records it
const reactivated = await atoms`
  SELECT body->>'parcelNodeId' AS node_id
  FROM atoms
  WHERE entity_type = 'parcel-node' AND body->>'countyFips' = '48021'
    AND body->>'status' = 'active' AND body ? 'reactivatedAt'
  ORDER BY md5(body->>'parcelNodeId') LIMIT ${SAMPLE}
`;
const reactivatedTotal = await atoms`
  SELECT count(*)::int AS n FROM atoms
  WHERE entity_type = 'parcel-node' AND body->>'countyFips' = '48021'
    AND body->>'status' = 'active' AND body ? 'reactivatedAt'
`;

// ---- the 1,013 residual this lane classifies
const residualRows = await atoms`
  SELECT body->>'parcelNodeId' AS node_id
  FROM atoms
  WHERE entity_type = 'parcel-node' AND body->>'countyFips' = '48021'
    AND body->>'status' = 'retired'
`;

// ---- 300 random current plan rows: the county baseline the reader has no memory of
const planSample = await serving`
  SELECT prop_id FROM txgio_parcel
  WHERE county_fips = '48021' ORDER BY md5(prop_id || tile_key) LIMIT 300
`;

const strip = (ids) => ids.map((id) => String(id).split(":").pop());
const source = LIVE_CURRENCY_SOURCES["48021"];

const readAll = async (ids) => {
  const readings = await source(ids);
  const tally = { live: 0, absent: 0, unmeasured: 0, missing: 0 };
  for (const id of ids) {
    const key = String(id).replace(/^0+(?=\d)/, "");
    const r = readings.get(key);
    tally[r ? r.reading : "missing"] += 1;
  }
  return tally;
};

const reactivatedIds = strip(reactivated.map((r) => r.node_id));
const reactivatedTally = await readAll(reactivatedIds);
const residualTally = await readAll(strip(residualRows.map((r) => r.node_id)));
const planTally = await readAll(planSample.map((r) => r.prop_id));
const negative = await source(["999999999"]);

const P212 = { retired: 57704, live: 56691, share: 56691 / 57704 };
const measuredShare = reactivatedTally.live / reactivatedIds.length;

console.log(JSON.stringify({
  requestsMade: source.requests,
  reader: source.describe,
  p212Claim: {
    ...P212,
    source: "_inbox/2026-09-15_p212-bastrop-false-retirement_close.json (P-212, 2026-09-15)",
  },
  storeSays: {
    reactivatedAtNodes: reactivatedTotal[0].n,
    meansP212ReactivatedClosedOnTheSameCount: reactivatedTotal[0].n === P212.live,
    residualRetiredNodes: residualRows.length,
  },
  reactivatedSample: { n: reactivatedIds.length, ...reactivatedTally, share: measuredShare },
  residual: { n: residualRows.length, ...residualTally },
  planRowSample: { n: planSample.length, ...planTally },
  negativeControl: negative.get("999999999")?.reading ?? "MISSING",
  falsifier1: {
    liveShareClaimed: P212.share,
    liveShareMeasured: measuredShare,
    differencePercentagePoints: (P212.share - measuredShare) * 100,
    literalWithinOnePercent: Math.abs(P212.share - measuredShare) <= 0.01,
  },
}, null, 2));

await atoms.end();
await serving.end();
