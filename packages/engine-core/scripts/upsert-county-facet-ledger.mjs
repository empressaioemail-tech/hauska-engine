/**
 * Post-block county_facet_coverage upsert (Phase C STEP 2 — ledger WRITE path).
 * Targets cortex Neon (CORTEX_DATABASE_URL / TXGIO_DATABASE_URL).
 */
import postgres from "postgres";

const DEFAULT_FACETS = ["zoning", "envelope"];

/**
 * @param {object} input
 * @param {string} input.countyFips
 * @param {string} input.databaseUrl cortex Neon URL
 * @param {number} input.rosterSize layer-23 city block roster
 * @param {number} input.promotedCount recipe-1.0.0 promotes
 * @param {number} input.honestDeclineCount verify-fail / decline writes
 * @param {string} [input.districtPrefix]
 * @param {string} [input.recipeVersion]
 * @param {string} [input.certState]
 * @param {number} [input.costUsd]
 */
export async function upsertCountyFacetLedger(input) {
  const {
    countyFips,
    databaseUrl,
    rosterSize,
    promotedCount,
    honestDeclineCount = 0,
    districtPrefix = null,
    recipeVersion = "1.0.0",
    certState = "uncerted",
    costUsd = null,
  } = input;

  const served = promotedCount + honestDeclineCount;
  const pct = rosterSize > 0 ? Number(((served / rosterSize) * 100).toFixed(2)) : 0;
  const vintage = districtPrefix
    ? `layer-23-city-${districtPrefix.toLowerCase()}`
    : "layer-23-city";

  const sql = postgres(databaseUrl, { ssl: "require", max: 2, prepare: false });
  const now = new Date().toISOString();

  try {
    for (const facet of DEFAULT_FACETS) {
      await sql`
        INSERT INTO county_facet_coverage (
          county_fips, facet, honest_coverage_pct, integrity_verdict,
          owner_match_rate, source, source_vintage, sampled, classification,
          recipe_version, cert_state, last_rewarm_at, onboarded, cost_usd, checked_at
        ) VALUES (
          ${countyFips},
          ${facet},
          ${pct},
          'n/a',
          NULL,
          'deterministic',
          ${vintage},
          ${rosterSize},
          'real-at-ceiling',
          ${recipeVersion},
          ${certState},
          ${now},
          true,
          ${costUsd},
          ${now}
        )
        ON CONFLICT (county_fips, facet) DO UPDATE SET
          honest_coverage_pct = EXCLUDED.honest_coverage_pct,
          source = EXCLUDED.source,
          source_vintage = EXCLUDED.source_vintage,
          sampled = EXCLUDED.sampled,
          recipe_version = EXCLUDED.recipe_version,
          cert_state = EXCLUDED.cert_state,
          last_rewarm_at = EXCLUDED.last_rewarm_at,
          onboarded = EXCLUDED.onboarded,
          cost_usd = COALESCE(EXCLUDED.cost_usd, county_facet_coverage.cost_usd),
          checked_at = EXCLUDED.checked_at
      `;
    }
    return { countyFips, honestCoveragePct: pct, rosterSize, promotedCount, honestDeclineCount };
  } finally {
    await sql.end();
  }
}
