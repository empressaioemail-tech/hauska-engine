/**
 * Central-TX node-graph live tally (G1 / WDLL 9).
 * Same SELECT shape as packages/storage/scripts/tally-central-tx-nodes.mjs.
 * Coverage IS this query against the serving DB — never a bake summary.
 */

import postgres from "postgres";

export const CENTRAL_TX_COUNTIES: Record<string, string> = {
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

export interface CountyTallyRow {
  fips: string;
  county: string;
  nodes: number;
  zoning_present: number;
  zoning_honest_absent_or_empty: number;
  zoning_slot_missing: number;
  setback_present: number;
  envelope_present: number;
  full_chain_nodes: number;
  references: number;
  zoning_present_pct: number;
  full_chain_pct: number;
}

export interface RoadTallyRow {
  fips: string;
  county: string;
  road_nodes: number;
  named_roads: number;
}

export interface CentralTxNodeGraphTally {
  generatedAt: string;
  source: string;
  database: string;
  servingRevisionNote: string;
  totals: {
    atoms_total: number;
    zoning_fact: number;
    setback_rule: number;
    buildable_envelope: number;
    zoning_absence: number;
    road_node: number;
    other_atoms: number;
    references_total: number;
    jurisdiction_status_rows: number;
    byType: Array<{ entity_type: string; n: number }>;
  };
  roadRollup: {
    road_nodes: number;
    named_roads: number;
    byCounty: RoadTallyRow[];
    /** Named probe roads for WDLL 3 grading (e.g. Bastrop Spring Street). */
    sampleNamed: Array<{ roadNodeId: string; displayName: string | null }>;
  };
  centralTx: {
    counties: CountyTallyRow[];
    rollup: {
      nodes: number;
      zoning_present: number;
      zoning_honest_absent_or_empty: number;
      zoning_slot_missing: number;
      setback_present: number;
      envelope_present: number;
      full_chain_nodes: number;
      references: number;
      zoning_present_pct: number;
      full_chain_pct: number;
    };
  };
  travis: CountyTallyRow | null;
  settles_5_8_vs_61: string;
}

export async function runCentralTxNodeGraphTally(
  databaseUrl: string,
): Promise<CentralTxNodeGraphTally> {
  const sql = postgres(databaseUrl, {
    ssl: "require",
    max: 1,
    connect_timeout: 30,
    idle_timeout: 5,
    onnotice: () => {},
  });

  try {
    const dbRows = await sql<{ db: string }[]>`SELECT current_database() AS db`;
    const db = dbRows[0]?.db;
    if (!db) throw new Error("current_database() returned no row");

    const byType = await sql<{ entity_type: string; n: number }[]>`
      SELECT entity_type, count(*)::int AS n
      FROM atoms
      GROUP BY 1
      ORDER BY n DESC
    `;

    const atomsRows = await sql<{ atoms_total: number }[]>`
      SELECT count(*)::int AS atoms_total FROM atoms
    `;
    const atoms_total = atomsRows[0]?.atoms_total ?? 0;

    const refsRows = await sql<{ references_total: number }[]>`
      SELECT count(*)::int AS references_total FROM atom_links
    `;
    const references_total = refsRows[0]?.references_total ?? 0;

    const jsRows = await sql<{ jurisdiction_status_rows: number }[]>`
      SELECT count(*)::int AS jurisdiction_status_rows FROM jurisdiction_status
    `;
    const jurisdiction_status_rows = jsRows[0]?.jurisdiction_status_rows ?? 0;

    const perCounty = await sql<{
      fips: string;
      nodes: number;
      zoning_present: number;
      zoning_honest_absent_or_empty: number;
      zoning_slot_missing: number;
      setback_present: number;
      envelope_present: number;
      full_chain_nodes: number;
    }[]>`
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

    const roadPerCounty = await sql<{
      fips: string;
      road_nodes: number;
      named_roads: number;
    }[]>`
      SELECT
        split_part(body->>'roadNodeId', ':', 1) AS fips,
        count(*)::int AS road_nodes,
        count(*) FILTER (
          WHERE coalesce(body->>'displayName', '') <> ''
        )::int AS named_roads
      FROM atoms
      WHERE entity_type = 'road-node'
        AND body->>'roadNodeId' ~ '^[0-9]{5}:road:[0-9]+$'
      GROUP BY 1
      ORDER BY 1
    `;

    const sampleNamed = await sql<{
      road_node_id: string;
      display_name: string | null;
    }[]>`
      SELECT
        body->>'roadNodeId' AS road_node_id,
        nullif(body->>'displayName', '') AS display_name
      FROM atoms
      WHERE entity_type = 'road-node'
        AND coalesce(body->>'displayName', '') <> ''
      ORDER BY updated_at DESC
      LIMIT 10
    `;

    const refsClean = await sql<{ fips: string; references: number }[]>`
      SELECT
        substring(from_atom_did from 'did:hauska:[^:]+:([0-9]{5}):') AS fips,
        count(*)::int AS references
      FROM atom_links
      WHERE from_atom_did ~ 'did:hauska:[^:]+:[0-9]{5}:'
      GROUP BY 1
      ORDER BY 1
    `;

    const typeMap = Object.fromEntries(
      byType.map((r) => [String(r.entity_type), Number(r.n)]),
    );
    const otherAtoms = byType
      .filter(
        (r) =>
          ![
            "zoning-fact",
            "setback-rule",
            "buildable-envelope",
            "zoning-absence",
            "road-node",
          ].includes(String(r.entity_type)),
      )
      .reduce((a, r) => a + Number(r.n), 0);

    const roadRows: RoadTallyRow[] = roadPerCounty.map((row) => {
      const fips = String(row.fips);
      return {
        fips,
        county: CENTRAL_TX_COUNTIES[fips] ?? "unknown",
        road_nodes: Number(row.road_nodes),
        named_roads: Number(row.named_roads),
      };
    });

    const roadRollup = {
      road_nodes: roadRows.reduce((a, r) => a + r.road_nodes, 0),
      named_roads: roadRows.reduce((a, r) => a + r.named_roads, 0),
      byCounty: roadRows.filter((r) => CENTRAL_TX_COUNTIES[r.fips]),
      sampleNamed: sampleNamed.map((r) => ({
        roadNodeId: String(r.road_node_id),
        displayName: r.display_name,
      })),
    };

    const rows: CountyTallyRow[] = perCounty.map((row) => {
      const fips = String(row.fips);
      const refs =
        refsClean.find((r) => String(r.fips) === fips)?.references ?? 0;
      const name = CENTRAL_TX_COUNTIES[fips] ?? "unknown";
      const nodes = Number(row.nodes);
      const zoning_present = Number(row.zoning_present);
      const full_chain_nodes = Number(row.full_chain_nodes);
      return {
        fips,
        county: name,
        nodes,
        zoning_present,
        zoning_honest_absent_or_empty: Number(row.zoning_honest_absent_or_empty),
        zoning_slot_missing: Number(row.zoning_slot_missing),
        setback_present: Number(row.setback_present),
        envelope_present: Number(row.envelope_present),
        full_chain_nodes,
        references: Number(refs),
        zoning_present_pct:
          nodes > 0 ? Number(((100 * zoning_present) / nodes).toFixed(2)) : 0,
        full_chain_pct:
          nodes > 0
            ? Number(((100 * full_chain_nodes) / nodes).toFixed(2))
            : 0,
      };
    });

    const central = rows.filter((r) => CENTRAL_TX_COUNTIES[r.fips]);
    const sum = (key: keyof CountyTallyRow) =>
      central.reduce((a, r) => a + (Number(r[key]) || 0), 0);

    return {
      generatedAt: new Date().toISOString(),
      source: "live SELECT against substrate Neon atoms/atom_links (serving DB)",
      database: String(db),
      servingRevisionNote:
        "retrieval-api postgres-serve; coverage = this tally, not a bake summary (G1)",
      totals: {
        atoms_total,
        zoning_fact: typeMap["zoning-fact"] ?? 0,
        setback_rule: typeMap["setback-rule"] ?? 0,
        buildable_envelope: typeMap["buildable-envelope"] ?? 0,
        zoning_absence: typeMap["zoning-absence"] ?? 0,
        road_node: typeMap["road-node"] ?? 0,
        other_atoms: otherAtoms,
        references_total,
        jurisdiction_status_rows,
        byType: byType.map((r) => ({
          entity_type: String(r.entity_type),
          n: Number(r.n),
        })),
      },
      roadRollup,
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
              ? Number(
                  ((100 * sum("full_chain_nodes")) / sum("nodes")).toFixed(2),
                )
              : 0,
        },
      },
      travis: central.find((r) => r.fips === "48453") ?? null,
      settles_5_8_vs_61:
        "Travis zoning_present_pct below is the live ledger number that settles the prose dispute.",
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
