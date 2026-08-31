#!/usr/bin/env node
/**
 * F-11 measure — setback-rule counts per FIPS split by provenance.
 * Indexed (entity_type, entity_id) prefix ranges. Named statement_timeout.
 * Timeout is unmeasured, never 0. Does not write.
 *
 *   DATABASE_URL=... node packages/retrieval/scripts/measure-setback-provenance.mjs
 */
import postgres from "postgres";

const FIPS = ["48021", "48055", "48209", "48309", "48453", "48491"];
const TIMEOUT = "15s";
const RECONCILE = {
  48021: { label: "Bastrop", valueTarget: 7534, layer23Target: 2315 },
  48055: { label: "Caldwell/Lockhart", valueTarget: 337 },
  48209: { label: "Hays", placeholderTarget: 34454 },
  48309: { label: "McLennan", valueTarget: 0, envelopeTarget: 65814 },
  48453: { label: "Travis/Austin", valueTarget: 150702 },
  48491: { label: "Williamson", placeholderTarget: 124499 },
};

function nextEntityIdBound(fips) {
  const n = Number(fips);
  if (!Number.isInteger(n)) throw new Error(`bad fips ${fips}`);
  return `${String(n + 1).padStart(5, "0")}:`;
}

async function main() {
  const url = process.env.DATABASE_URL ?? process.env.ATOMS_DATABASE_URL;
  if (!url) {
    console.error(
      JSON.stringify({
        snapshot: "unmeasured",
        reason: "DATABASE_URL / ATOMS_DATABASE_URL unset",
      }),
    );
    process.exit(2);
  }
  const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10 });
  const rows = [];
  try {
    await sql.unsafe(`SET statement_timeout = '${TIMEOUT}'`);
    for (const fips of FIPS) {
      const start = `${fips}:`;
      const end = nextEntityIdBound(fips);
      try {
        const setbacks = await sql`
          SELECT
            CASE
              WHEN body->'sourceCodeAtomRef'->>'atomDid' LIKE '%storage-port-proof/phase-1a%'
                OR body->'fieldProvenance'->'front'->>'atomDid' LIKE '%storage-port-proof/phase-1a%'
                THEN 'placeholder'
              WHEN body->>'sourceAdapter' = 'bastrop-per-parcel-record-layer-23'
                THEN 'layer-23'
              WHEN body->>'sourceAdapter' = 'road-class-setback-table'
                THEN 'road-class-setback-table'
              ELSE 'other-dimensional'
            END AS provenance,
            count(*)::bigint AS n
          FROM atoms
          WHERE entity_type = 'setback-rule'
            AND entity_id >= ${start}
            AND entity_id < ${end}
          GROUP BY 1
        `;
        const envelopes = await sql`
          SELECT count(*)::bigint AS n
          FROM atoms
          WHERE entity_type = 'buildable-envelope'
            AND entity_id >= ${start}
            AND entity_id < ${end}
        `;
        rows.push({
          fips,
          label: RECONCILE[fips].label,
          setbackRule: Object.fromEntries(
            setbacks.map((r) => [r.provenance, Number(r.n)]),
          ),
          buildableEnvelope: Number(envelopes[0]?.n ?? 0),
          reconcile: RECONCILE[fips],
        });
      } catch (err) {
        const timedOut =
          err &&
          typeof err === "object" &&
          (String(err.message ?? "").includes("statement timeout") ||
            err.code === "57014");
        rows.push({
          fips,
          label: RECONCILE[fips].label,
          snapshot: timedOut ? "unmeasured" : "error",
          reason: timedOut
            ? `statement_timeout ${TIMEOUT}`
            : String(err?.message ?? err),
        });
      }
    }
  } finally {
    await sql.end({ timeout: 2 });
  }
  console.log(
    JSON.stringify(
      {
        snapshot: new Date().toISOString(),
        timeout: TIMEOUT,
        predicate: "entity_type = setback-rule AND entity_id >= fips: AND entity_id < nextFips:",
        rows,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ snapshot: "unmeasured", reason: String(err) }));
  process.exit(2);
});
