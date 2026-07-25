/**
 * Phase 0.3 / G1 — one honest live tally of the node-graph per Central-TX
 * county from the serving DB. Coverage IS this SELECT, not a bake summary.
 *
 * Usage:
 *   DATABASE_URL=... node packages/storage/scripts/tally-central-tx-nodes.mjs
 */

import postgres from "postgres";

const COUNTY = {
  "48021": "Bastrop",
  "48027": "Bell",
  "48029": "Bexar",
  "48055": "Caldwell",
  "48091": "Comal",
  "48187": "Guadalupe",
  "48209": "Hays",
  "48309": "McLennan",
  "48453": "Travis",
  "48491": "Williamson",
};

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL required");
  process.exit(1);
}

const sql = postgres(url, {
  ssl: "require",
  max: 1,
  connect_timeout: 30,
});

const [{ db }] = await sql`SELECT current_database() AS db`;
const cols = await sql`
  SELECT column_name
  FROM information_schema.columns
  WHERE table_name = 'atoms'
  ORDER BY ordinal_position
`;

const byType = await sql`
  SELECT entity_type, count(*)::int AS n
  FROM atoms
  GROUP BY 1
  ORDER BY n DESC
`;

const [{ atoms_total }] = await sql`SELECT count(*)::int AS atoms_total FROM atoms`;
const [{ references_total }] = await sql`
  SELECT count(*)::int AS references_total FROM atom_links
`;
const [{ jurisdiction_status_rows }] = await sql`
  SELECT count(*)::int AS jurisdiction_status_rows FROM jurisdiction_status
`;

const perCounty = await sql`
  WITH property_atoms AS (
    SELECT
      split_part(entity_id, ':', 1) AS fips,
      split_part(entity_id, ':', 2) AS prop_id,
      entity_type,
      body
    FROM atoms
    WHERE entity_type IN (
      'zoning-fact', 'setback-rule', 'buildable-envelope', 'zoning-absence'
    )
      AND entity_id ~ '^[0-9]{5}:'
  ),
  zoning AS (
    SELECT
      fips,
      prop_id,
      bool_or(entity_type = 'zoning-fact') AS has_zoning_fact,
      bool_or(entity_type = 'zoning-absence') AS has_zoning_absence,
      bool_or(
        entity_type = 'zoning-fact'
        AND coalesce(body->>'district', '') <> ''
        AND lower(coalesce(body->>'district', '')) NOT IN ('unknown', 'null')
      ) AS zoning_present_district,
      bool_or(entity_type = 'setback-rule') AS has_setback,
      bool_or(entity_type = 'buildable-envelope') AS has_envelope
    FROM property_atoms
    GROUP BY 1, 2
  )
  SELECT
    z.fips,
    count(*)::int AS nodes,
    count(*) FILTER (WHERE zoning_present_district)::int AS zoning_present,
    count(*) FILTER (
      WHERE has_zoning_absence OR (has_zoning_fact AND NOT zoning_present_district)
    )::int AS zoning_honest_absent_or_empty,
    count(*) FILTER (
      WHERE NOT has_zoning_fact AND NOT has_zoning_absence
    )::int AS zoning_slot_missing,
    count(*) FILTER (WHERE has_setback)::int AS setback_present,
    count(*) FILTER (WHERE has_envelope)::int AS envelope_present,
    count(*) FILTER (
      WHERE has_setback AND has_envelope AND zoning_present_district
    )::int AS full_chain_nodes
  FROM zoning z
  GROUP BY 1
  ORDER BY 1
`;

const refsClean = await sql`
  SELECT
    substring(from_atom_did from 'did:hauska:[^:]+:([0-9]{5}):') AS fips,
    count(*)::int AS references
  FROM atom_links
  WHERE from_atom_did ~ 'did:hauska:[^:]+:[0-9]{5}:'
  GROUP BY 1
  ORDER BY 1
`;

const typeMap = Object.fromEntries(byType.map((r) => [r.entity_type, r.n]));
const otherAtoms = byType
  .filter(
    (r) =>
      ![
        "zoning-fact",
        "setback-rule",
        "buildable-envelope",
        "zoning-absence",
      ].includes(r.entity_type),
  )
  .reduce((a, r) => a + r.n, 0);

const rows = perCounty.map((row) => {
  const fips = row.fips;
  const refs = refsClean.find((r) => r.fips === fips)?.references ?? 0;
  const name = COUNTY[fips] ?? "unknown";
  return {
    fips,
    county: name,
    nodes: row.nodes,
    zoning_present: row.zoning_present,
    zoning_honest_absent_or_empty: row.zoning_honest_absent_or_empty,
    zoning_slot_missing: row.zoning_slot_missing,
    setback_present: row.setback_present,
    envelope_present: row.envelope_present,
    full_chain_nodes: row.full_chain_nodes,
    references: refs,
    zoning_present_pct:
      row.nodes > 0
        ? Number(((100 * row.zoning_present) / row.nodes).toFixed(2))
        : 0,
    full_chain_pct:
      row.nodes > 0
        ? Number(((100 * row.full_chain_nodes) / row.nodes).toFixed(2))
        : 0,
  };
});

const central = rows.filter((r) => COUNTY[r.fips]);
const sum = (key) => central.reduce((a, r) => a + r[key], 0);

const out = {
  generatedAt: new Date().toISOString(),
  source: "live SELECT against substrate Neon atoms/atom_links (serving DB)",
  database: db,
  atoms_columns: cols.map((c) => c.column_name),
  servingRevisionNote:
    "retrieval-api postgres-serve; coverage = this tally, not a bake summary (G1)",
  totals: {
    atoms_total,
    zoning_fact: typeMap["zoning-fact"] ?? 0,
    setback_rule: typeMap["setback-rule"] ?? 0,
    buildable_envelope: typeMap["buildable-envelope"] ?? 0,
    zoning_absence: typeMap["zoning-absence"] ?? 0,
    other_atoms: otherAtoms,
    references_total,
    jurisdiction_status_rows,
    byType,
  },
  centralTx: {
    counties: central,
    rollup: {
      nodes: sum("nodes"),
      zoning_present: sum("zoning_present"),
      zoning_honest_absent_or_empty: sum("zoning_honest_absent_or_empty"),
      zoning_slot_missing: sum("zoning_slot_missing"),
      setback_present: sum("setback_present"),
      envelope_present: sum("envelope_present"),
      full_chain_nodes: sum("full_chain_nodes"),
      references: sum("references"),
      zoning_present_pct:
        sum("nodes") > 0
          ? Number(((100 * sum("zoning_present")) / sum("nodes")).toFixed(2))
          : 0,
      full_chain_pct:
        sum("nodes") > 0
          ? Number(((100 * sum("full_chain_nodes")) / sum("nodes")).toFixed(2))
          : 0,
    },
  },
  travis: central.find((r) => r.fips === "48453") ?? null,
  settles_5_8_vs_61:
    "Travis zoning_present_pct below is the live ledger number that settles the prose dispute.",
};

console.log(JSON.stringify(out, null, 2));
await sql.end({ timeout: 5 });
