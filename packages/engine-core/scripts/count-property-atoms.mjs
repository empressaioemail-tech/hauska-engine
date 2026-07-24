#!/usr/bin/env node
import postgres from "postgres";
import { resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

const url = resolveSubstrateDatabaseUrl();
const fips = process.argv[2] || null;
const sql = postgres(url, { ssl: "require", max: 1, prepare: false });
try {
  const rows = fips
    ? await sql`
        SELECT entity_type,
               count(*)::int AS n,
               count(*) FILTER (WHERE body ? 'absence')::int AS with_absence
        FROM atoms
        WHERE entity_type IN ('zoning-fact','setback-rule','buildable-envelope')
          AND body->>'parcelNodeId' LIKE ${fips + ":%"}
        GROUP BY 1 ORDER BY 1`
    : await sql`
        SELECT substring(body->>'parcelNodeId' from 1 for 5) AS fips,
               entity_type,
               count(*)::int AS n,
               count(*) FILTER (WHERE body ? 'absence')::int AS with_absence
        FROM atoms
        WHERE entity_type IN ('zoning-fact','setback-rule','buildable-envelope')
        GROUP BY 1, 2 ORDER BY 1, 2`;
  console.log(JSON.stringify(rows, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}
