/**
 * P-210 (OPS-24) — "is this locality served by the serving path" check.
 *
 * Ruling (2026-09-16, `_decisions/2026-09-16_texas_scaleup_sequence_and_four_rulings.md`,
 * ruling 2): "covered" means what actually serves the customer, not the
 * search index (`txgio_parcel`/`txgio_address`) and not the Factory ledger
 * (`parcel_record`/`parcel_gate_verdict`). Traced live (CP1): `get_smart_site`
 * (legacy-design-tools `artifacts/smartsite-mcp`) calls
 * `POST /api/property-explorer/v1/research/brief`, whose `assembleNodeBriefBody`
 * (legacy-design-tools `artifacts/api-server/src/routes/propertyExplorer.ts`)
 * unconditionally gates on `loadBakedNodeFacetSnapshot` finding a Tier-1 row —
 * `if (!snapshot) return null` before any individual fact loader's result is
 * used. That function's own query is
 * `place_layer_snapshots WHERE adapter_key IN (tier1,tier2) AND place_key = 'node:{fips}:{propId}'`.
 * This module lifts that per-parcel gate to a county-level EXISTS: a county
 * with at least one Tier-1 row has at least one parcel `get_smart_site` can
 * serve something for (proven live against a real Bell County parcel during
 * CP1, not merely inferred from the row count).
 *
 * `TIER1_ADAPTER_KEY` below is a literal duplicated from that OTHER repo's
 * `lib/nodeFacetTier1Constants.ts` (`"node-facets:tier1"`) — this service
 * cannot import from legacy-design-tools, and the dispatch that authorizes
 * this endpoint forbids touching it. It is the value the bake writer stamps
 * on every row it writes, not a coverage roster this lane maintains; if that
 * repo ever renames it, this check silently stops matching new rows (named
 * as a leave_behind coupling in the close).
 *
 * GEO-RESOLUTION (city/state/zip -> county FIPS) has no index to lean on:
 * `txgio_address` (post_comm/post_code/county_fips) covers only 6 counties —
 * zero rows for many out-of-CTX counties, e.g. Bell. `txgio_parcel`
 * (situs_zip/situs_city) covers all 253 counties but carries NO index on
 * either column (confirmed live: `\d txgio_parcel` lists no situs_zip or
 * situs_city index; `EXPLAIN ANALYZE` on an unindexed `situs_zip = $1 LIMIT
 * 1` took 14.0s on an early-positioned match after a sequential scan removed
 * 1.34M of 16.4M/29GB rows; this module's own GROUP BY, which cannot use a
 * LIMIT shortcut because it must see every matching row to judge dominance,
 * measured 2-3 minutes per COLD zip). Building an index would mean editing
 * legacy-design-tools' own drizzle schema, which this dispatch forbids
 * touching. `GEO_RESOLUTION_STATEMENT_TIMEOUT_MS` is set from that measured
 * worst case with headroom under Cloud Run's configured 300s request
 * timeout for this service, so a slow scan still fails closed to
 * `indeterminate` (one of the dispatch's own required falsifier-3 behaviors)
 * rather than hanging past the platform's own cutoff into a raw connection
 * reset. This is a genuine, unresolved LATENCY problem this lane is
 * disclosing, not solving: a customer-facing request should not take up to
 * two minutes on a cache miss. The long `LOCALITY_RESOLUTION_TTL_MS` below
 * is deliberate mitigation (pay the scan once per locality, not once per
 * request) but does not fix a cold lookup's own cost. See the close's
 * leave_behind for the recommended follow-on (an index owned by
 * legacy-design-tools, out of this lane's scope).
 *
 * RE-MEASURED 2026-09-16 (P-205b, read-only, under a P-281 heavy-scan lease, psql
 * `\timing`): the first, cold `78654` GROUP BY took 67.8s and the warm repeats took
 * 15.4s and 3.3s. That is LOWER than the 2-3 minute figure above, not higher, and both
 * numbers are kept rather than one being overwritten by the other: the 2-3 minute figure
 * is what the 150s timeout was sized against and remains the worst case this module is
 * willing to declare, while 67.8s is what one cold run actually cost on this date. A
 * timeout sized to a measured worst case that is not always reached is doing its job; a
 * timeout sized to the best observed run would not be.
 *
 * P-205b (OPS-24) -- NARROW BEFORE GIVING UP, AND A UNANIMOUS ANSWER NEEDS NO WINNER.
 * Ruling (integration seat, 2026-09-16), because a ZIP-only grouping made the Phase 1
 * county unreachable: `78654` is Marble Falls, and Marble Falls is Burnet (48053, 11391
 * rows) plus a Travis tail (48453, 1850) plus five stowaways, so the ZIP alone sits at
 * 85.3 percent -- below DOMINANCE_SHARE -- and `find_parcel` refused with
 * `coverage_check_unavailable` for EVERY Burnet address in a split ZIP. Measured live
 * against this service's own deployed revision before the change, 2026-09-16:
 * `?city=Marble+Falls&state=TX&zip=78654` answered exactly
 * `"locality resolves to multiple candidate counties with no dominant match: 48053 (11391),
 * 48453 (1850), 48031 (61), 48319 (46), 48015 (2), 48501 (2), 48299 (1)"`.
 *
 * Two rules were added, and nothing else changed:
 *
 *   1. When the ZIP ALONE is ambiguous and a city is also given, the search is narrowed to
 *      that ZIP AND that city and the SAME 90 percent rule is applied. When only one of the
 *      two is given, behaviour is unchanged, and the 90 percent rule itself is unchanged.
 *   2. When the locality is STILL ambiguous, every candidate county's serving status is
 *      read. All covered -> `covered`. None covered -> `not-covered` naming the plurality
 *      county, carrying the candidate list. They disagree -> `indeterminate`, carrying the
 *      list with each candidate's own status. A unanimous answer does not need a winner
 *      picked out of a vote that was not close.
 *
 * ONE SCAN, TWO SPLITS. The narrowing does NOT cost a second scan of `txgio_parcel`. That
 * table is unindexed on `situs_zip`/`situs_city` and a cold GROUP BY over it measured 67.8s
 * live (2026-09-16); two of them would exceed this service's 300s Cloud Run request timeout
 * and would make the narrowed answer unreachable for precisely the cold ZIP this rule exists
 * for. Instead, when a ZIP and a city are both given, ONE statement is issued whose WHERE is
 * the ZIP predicate and whose second GROUP BY key is "does this row's situs_city equal the
 * given city". Summing across that key reproduces the ZIP-only split from the same rows
 * (same WHERE), and selecting only the matching rows is the ZIP-and-city split. The ZIP-only
 * split is judged first, so a ZIP that resolves on its own behaves exactly as it did before,
 * and the narrowed split is consulted only when the first is ambiguous. Verified live: the
 * ZIP-only fold of that one statement returned 48053 (11391) / 48453 (1850) / 48031 (61) /
 * 48319 (46) / 48015 (2) / 48501 (2) / 48299 (1), identical to a separate ZIP-only GROUP BY
 * and to the candidate list the deployed revision itself had already printed.
 *
 * AN EMPTY NARROWING IS NOT AN ABSENCE (DEV-PROCESS 4.3). If the given city matches no row
 * in that ZIP, the module keeps the ZIP-only resolution and lets rule 2 decide it, rather
 * than reporting the locality as not found. `situs_city` is a CAD situs city, not the postal
 * city, so a whole ZIP whose CAD spelling differs would otherwise be declared non-existent --
 * a false absence, and fail-closed is not a licence to be wrong. A narrowing that returns
 * rows and STILL fails 90 percent is a positive determination of continued ambiguity, and
 * that one is reported with the narrowed candidate list.
 */

import postgres from "postgres";

/** The bake writer's literal adapter_key for a Tier-1 node-facets row. */
export const TIER1_ADAPTER_KEY = "node-facets:tier1";

/** county resolution query timeout: bounded, unindexed, see module doc.
 * Measured worst case (cold, GROUP BY over the full unindexed table): 2-3
 * minutes. 150s leaves headroom under Cloud Run's 300s request timeout. */
export const GEO_RESOLUTION_STATEMENT_TIMEOUT_MS = 150_000;
/** coverage/name lookups are indexed point/prefix reads; should be fast. */
export const FAST_LOOKUP_STATEMENT_TIMEOUT_MS = 5_000;

/** A locality resolves to exactly one county when one candidate holds this share of matching rows. */
export const DOMINANCE_SHARE = 0.9;

/**
 * A candidate county for an ambiguous locality, with its OWN serving-path status
 * (P-205b). Carried on the `not-covered` and `indeterminate` bodies so a caller can
 * see which counties the locality spans and which of them the serving path holds,
 * instead of being handed a bare refusal string. `covered` stays a plain
 * `{ status: "covered" }` -- rule 2 enumerates what travels with the two
 * candidate-bearing answers and not with the unanimous-covered one, and leaving the
 * hot in-coverage path's body byte-identical to P-210's is the safer shape.
 */
export interface CountyCandidateCoverage {
  countyFips: string;
  n: number;
  covered: boolean;
}

export type CoverageVerdict =
  | { status: "covered" }
  | {
      status: "not-covered";
      countyFips: string;
      countyName: string;
      state: string;
      /** Present when the county was chosen from an ambiguous locality by rule 2. */
      candidates?: readonly CountyCandidateCoverage[];
    }
  | {
      status: "indeterminate";
      reason: string;
      /**
       * Present only when every candidate was positively read and they disagreed;
       * never on a failure to read them (see readCandidateCoverage).
       */
      candidates?: readonly CountyCandidateCoverage[];
    };

export interface CoverageCheckInput {
  city: string | null;
  state: string | null;
  zip: string | null;
}

export interface CountyMatchCount {
  countyFips: string;
  n: number;
}

export type CountyResolution =
  | { kind: "resolved"; countyFips: string }
  | { kind: "not-found" }
  | { kind: "ambiguous"; candidates: readonly CountyMatchCount[] };

/**
 * Pure dominance rule, exported for direct unit testing against fixture
 * counts (e.g. the live-measured Bell/76541 split: 6897 rows in 48027 vs 3
 * mis-keyed rows in 48319 — a single distinct-county-count check would call
 * that "ambiguous" and wrongly refuse a real, unambiguous locality).
 */
export function chooseDominantCounty(
  rows: readonly CountyMatchCount[],
): CountyResolution {
  if (rows.length === 0) return { kind: "not-found" };
  if (rows.length === 1) return { kind: "resolved", countyFips: rows[0]!.countyFips };
  const sorted = [...rows].sort((a, b) => b.n - a.n);
  const total = sorted.reduce((sum, r) => sum + r.n, 0);
  const top = sorted[0]!;
  if (total > 0 && top.n / total >= DOMINANCE_SHARE) {
    return { kind: "resolved", countyFips: top.countyFips };
  }
  return { kind: "ambiguous", candidates: sorted };
}

/**
 * The narrowing rule (P-205b rule 1), as ONE pure decision.
 *
 * Judged in this order, and for these reasons: the ZIP-only split first, so a ZIP that
 * resolves on its own is answered exactly as it was before this change; the ZIP-and-city
 * split only when the ZIP alone was ambiguous; and, when the narrowing returned NO rows,
 * the ZIP-only ambiguity stands rather than becoming `not-found`, because an empty result
 * is not an absence (DEV-PROCESS 4.3) -- `situs_city` is a CAD situs city, so a city
 * spelling that matches nothing is evidence about the string, not about whether the
 * locality exists.
 *
 * A pure function with two callers on purpose (the real store and the fixture store).
 * DEV-PROCESS 2.4 is explicit that two implementations of one rule drift and that the
 * divergence test is then the only control; the cheaper fix is to have one implementation.
 */
export function narrowByCity(
  zipOnly: CountyResolution,
  cityMatched: readonly CountyMatchCount[],
): CountyResolution {
  if (zipOnly.kind !== "ambiguous") return zipOnly;
  if (cityMatched.length === 0) return zipOnly;
  return chooseDominantCounty(cityMatched);
}

/**
 * Rule 2 (P-205b): a unanimous answer needs no winner. Pure, and shared by the real
 * store and the fixture store for the same reason as narrowByCity.
 *
 * Returns `covered` when the serving path holds every candidate, `not-covered` (with the
 * PLURALITY county named) when it holds none, and `mixed` when the candidates disagree.
 * `candidates` is already sorted by count descending (`chooseDominantCounty`), so index 0
 * is the plurality; ties keep the order the split produced, which is the database's or the
 * fixture's, and are never broken by a second sort here.
 *
 * This function deliberately does NOT look up the plurality's name: that read is
 * store-specific (a table in one, a fixture map in the other), and the caller must be able
 * to fail closed on its own if the name is missing.
 */
export type AmbiguousLocalityDecision =
  | { kind: "covered" }
  | { kind: "not-covered"; countyFips: string; candidates: readonly CountyCandidateCoverage[] }
  | { kind: "mixed"; candidates: readonly CountyCandidateCoverage[] };

export function decideAmbiguousLocality(
  candidates: readonly CountyCandidateCoverage[],
): AmbiguousLocalityDecision {
  const coveredCount = candidates.filter((c) => c.covered).length;
  if (coveredCount === candidates.length) return { kind: "covered" };
  if (coveredCount === 0) {
    return { kind: "not-covered", countyFips: candidates[0]!.countyFips, candidates };
  }
  return { kind: "mixed", candidates };
}

/**
 * Folds the one-scan ZIP+city result into the two splits it carries: the ZIP-only totals
 * (every row, matching or not) and the ZIP-AND-city totals (matching rows only). Pure and
 * exported so the fold can be tested against a real statement's rows rather than only
 * through the store.
 *
 * `city_match` is a boolean to postgres.js; the text spellings are tolerated so that a
 * driver or type-parser change cannot silently stop the narrowing from firing. A NULL
 * `situs_city` is not a match.
 */
export function splitCityMatch(
  rows: readonly { county_fips: string; city_match: boolean | string | null; n: number }[],
): { zipRows: CountyMatchCount[]; cityMatchedRows: CountyMatchCount[] } {
  const zipTotals = new Map<string, number>();
  const matchedTotals = new Map<string, number>();
  for (const row of rows) {
    const n = Number(row.n);
    zipTotals.set(row.county_fips, (zipTotals.get(row.county_fips) ?? 0) + n);
    if (row.city_match === true || row.city_match === "t" || row.city_match === "true") {
      matchedTotals.set(row.county_fips, (matchedTotals.get(row.county_fips) ?? 0) + n);
    }
  }
  return {
    zipRows: [...zipTotals.entries()].map(([countyFips, n]) => ({ countyFips, n })),
    cityMatchedRows: [...matchedTotals.entries()].map(([countyFips, n]) => ({ countyFips, n })),
  };
}

const NON_TEXAS_HINT_RE = /^(?!tx$|texas$).+$/i;

/** Cheap, no-DB rejection for a locality that names a state other than Texas. */
export function isDeclaredNonTexas(state: string | null): boolean {
  if (!state) return false;
  const trimmed = state.trim();
  if (trimmed === "") return false;
  return NON_TEXAS_HINT_RE.test(trimmed);
}

export function normalizeZip(zip: string | null): string | null {
  if (!zip) return null;
  const trimmed = zip.trim();
  return /^\d{5}$/.test(trimmed) ? trimmed : null;
}

export function normalizeCity(city: string | null): string | null {
  if (!city) return null;
  const trimmed = city.trim();
  return trimmed === "" ? null : trimmed;
}

/** Read-only access this module needs; real impl below, fixture impl in tests. */
export interface CoverageCheckStore {
  checkCoverage(input: CoverageCheckInput): Promise<CoverageVerdict>;
  close(): Promise<void>;
}

interface CacheEntry {
  verdict: CoverageVerdict;
  expiresAt: number;
}

/**
 * County -> covered/not-covered/name is cheap to recompute (indexed) but
 * changes only on a Factory/bake publish (CONTRACT: "a few minutes" TTL is
 * correct). Locality -> county is expensive (unindexed scan) and never
 * changes (geography), so it gets a much longer TTL — the cost this module
 * is protecting is the 14s-to-minutes scan, not staleness.
 */
export const COUNTY_VERDICT_TTL_MS = 5 * 60_000;
export const LOCALITY_RESOLUTION_TTL_MS = 24 * 60 * 60_000;
/** A failed/indeterminate result is cached only briefly, so a transient DB
 * hiccup or a cold-scan timeout doesn't wedge a real locality for a day. */
export const INDETERMINATE_TTL_MS = 30_000;

function cacheKey(input: CoverageCheckInput): string {
  const zip = normalizeZip(input.zip) ?? "";
  const city = (normalizeCity(input.city) ?? "").toUpperCase();
  const state = (input.state ?? "").trim().toUpperCase();
  return `${zip}|${city}|${state}`;
}

export interface CreateCoverageCheckStoreOptions {
  databaseUrl: string;
  /** postgres.js factory, injected so tests can supply a fake without a real connection. */
  openSql?: (databaseUrl: string, statementTimeoutMs: number) => Promise<postgres.Sql>;
}

/**
 * Real connection opener. `statement_timeout` is enforced with an explicit
 * `SET` query, NOT the `postgres.js` `connection` startup-parameter option —
 * verified live (2026-09-16) against this exact CORTEX_DATABASE_URL that the
 * `connection: { statement_timeout }` option is silently dropped (`SHOW
 * statement_timeout` read back `0` after connecting with it set to 2000),
 * almost certainly stripped by Neon's connection proxy; a `pg_sleep(5)` with
 * that option set completed in full rather than cancelling at 2s. An
 * explicit `SET statement_timeout = $1` query on the same connection was
 * verified to cancel a `pg_sleep(5)` at ~2.0s with `57014 canceling
 * statement due to statement timeout`. Same SSL-detection convention as this
 * service's `spine-health/run-pack.ts` `openSql`.
 */
export async function openCoverageSql(
  databaseUrl: string,
  statementTimeoutMs: number,
): Promise<postgres.Sql> {
  const ssl =
    databaseUrl.includes("sslmode=require") || databaseUrl.includes("neon.tech")
      ? ("require" as const)
      : false;
  const sql = postgres(databaseUrl, { ssl, max: 2, idle_timeout: 5 });
  // `SET` does not accept a bound parameter for its value (`SET
  // statement_timeout = $1` is a syntax error, verified live) -- `.unsafe`
  // is safe here because the value is always one of this module's own two
  // exported numeric constants, never request input.
  const safeMs = Math.trunc(statementTimeoutMs);
  await sql.unsafe(`SET statement_timeout = ${safeMs}`);
  return sql;
}

export function createCoverageCheckStore(
  options: CreateCoverageCheckStoreOptions,
): CoverageCheckStore {
  const cache = new Map<string, CacheEntry>();
  const localityCache = new Map<string, { resolution: CountyResolution; expiresAt: number }>();
  const openSql = options.openSql ?? openCoverageSql;

  async function resolveLocality(input: CoverageCheckInput): Promise<CountyResolution> {
    const zip = normalizeZip(input.zip);
    const city = normalizeCity(input.city);
    if (!zip && !city) return { kind: "not-found" };

    // The narrowed lookup gets its OWN cache entry (P-205b): a cached ZIP-only ambiguity
    // must never be served as a narrowed answer, nor a narrowed answer as a ZIP-only one.
    const localityKey =
      zip && city
        ? `zip:${zip}|city:${city.toUpperCase()}`
        : zip
          ? `zip:${zip}`
          : `city:${(city as string).toUpperCase()}`;
    const cached = localityCache.get(localityKey);
    if (cached && cached.expiresAt > Date.now()) return cached.resolution;

    const sql = await openSql(options.databaseUrl, GEO_RESOLUTION_STATEMENT_TIMEOUT_MS);
    try {
      let resolution: CountyResolution;
      if (zip && city) {
        // ONE statement, TWO splits (see the module header). The WHERE is the ZIP
        // predicate and the second GROUP BY key is the city predicate, so this scan is
        // the same scan the ZIP-only branch performs -- the narrowing costs nothing and
        // never a second full scan per request.
        const rows = await sql<
          Array<{ county_fips: string; city_match: boolean | null; n: number }>
        >`
            SELECT county_fips, city_match, count(*)::int AS n
            FROM (
              SELECT county_fips, (upper(situs_city) = upper(${city})) AS city_match
              FROM txgio_parcel
              WHERE situs_zip = ${zip}
            ) t
            GROUP BY county_fips, city_match
          `;
        const { zipRows, cityMatchedRows } = splitCityMatch(rows);
        resolution = narrowByCity(chooseDominantCounty(zipRows), cityMatchedRows);
      } else if (zip) {
        const rows = await sql<Array<{ county_fips: string; n: number }>>`
            SELECT county_fips, count(*)::int AS n
            FROM txgio_parcel
            WHERE situs_zip = ${zip}
            GROUP BY county_fips
          `;
        resolution = chooseDominantCounty(rows.map((r) => ({ countyFips: r.county_fips, n: Number(r.n) })));
      } else {
        const rows = await sql<Array<{ county_fips: string; n: number }>>`
            SELECT county_fips, count(*)::int AS n
            FROM txgio_parcel
            WHERE upper(situs_city) = upper(${city as string})
            GROUP BY county_fips
          `;
        resolution = chooseDominantCounty(rows.map((r) => ({ countyFips: r.county_fips, n: Number(r.n) })));
      }
      localityCache.set(localityKey, {
        resolution,
        expiresAt: Date.now() + LOCALITY_RESOLUTION_TTL_MS,
      });
      return resolution;
    } finally {
      await sql.end({ timeout: 5 }).catch(() => {});
    }
  }

  async function countyServesAtLeastOneParcel(countyFips: string): Promise<boolean> {
    const sql = await openSql(options.databaseUrl, FAST_LOOKUP_STATEMENT_TIMEOUT_MS);
    try {
      const rows = await sql<Array<{ exists: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM place_layer_snapshots
          WHERE adapter_key = ${TIER1_ADAPTER_KEY}
            AND place_key LIKE ${"node:" + countyFips + ":%"}
        ) AS exists
      `;
      return Boolean(rows[0]?.exists);
    } finally {
      await sql.end({ timeout: 5 }).catch(() => {});
    }
  }

  async function countyName(countyFips: string): Promise<string | null> {
    const sql = await openSql(options.databaseUrl, FAST_LOOKUP_STATEMENT_TIMEOUT_MS);
    try {
      const rows = await sql<Array<{ county_name: string }>>`
        SELECT county_name FROM tx_county_boundary WHERE county_fips = ${countyFips}
      `;
      return rows[0]?.county_name ?? null;
    } finally {
      await sql.end({ timeout: 5 }).catch(() => {});
    }
  }

  /**
   * Rule 2's only store-specific read: the serving-path status of every candidate. A
   * candidate whose status cannot be READ throws rather than defaulting to `false` -- the
   * caller turns that into a refusal that carries no candidate list, because a
   * `covered: false` standing for "we could not tell" is the presence-shaped check this
   * program hunts. Cost: one indexed EXISTS per candidate (typically two), never a scan.
   */
  async function readCandidateCoverage(
    candidates: readonly CountyMatchCount[],
  ): Promise<CountyCandidateCoverage[]> {
    const out: CountyCandidateCoverage[] = [];
    for (const candidate of candidates) {
      out.push({
        countyFips: candidate.countyFips,
        n: candidate.n,
        covered: await countyServesAtLeastOneParcel(candidate.countyFips),
      });
    }
    return out;
  }

  return {
    async checkCoverage(input) {
      const key = cacheKey(input);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.verdict;

      const put = (verdict: CoverageVerdict, ttlMs: number): CoverageVerdict => {
        cache.set(key, { verdict, expiresAt: Date.now() + ttlMs });
        return verdict;
      };

      if (isDeclaredNonTexas(input.state)) {
        return put(
          {
            status: "indeterminate",
            reason: `state "${input.state}" is outside Texas; this coverage source only covers the Texas market`,
          },
          COUNTY_VERDICT_TTL_MS,
        );
      }
      if (!normalizeZip(input.zip) && !normalizeCity(input.city)) {
        return put(
          { status: "indeterminate", reason: "no zip or city provided to resolve a county" },
          INDETERMINATE_TTL_MS,
        );
      }

      let resolution: CountyResolution;
      try {
        resolution = await resolveLocality(input);
      } catch (err) {
        return put(
          {
            status: "indeterminate",
            reason: `county resolution failed: ${err instanceof Error ? err.message : String(err)}`,
          },
          INDETERMINATE_TTL_MS,
        );
      }

      if (resolution.kind === "not-found") {
        return put(
          {
            status: "indeterminate",
            reason: "locality not found in the statewide parcel index",
          },
          INDETERMINATE_TTL_MS,
        );
      }
      if (resolution.kind === "ambiguous") {
        // Rule 2 (P-205b): a unanimous answer needs no winner.
        let withCoverage: CountyCandidateCoverage[];
        try {
          withCoverage = await readCandidateCoverage(resolution.candidates);
        } catch (err) {
          // A candidate whose status could not be read is NOT an uncovered candidate, and a
          // partial list would have to carry "unknown" in a boolean. Refuse the whole
          // determination -- no candidates list -- rather than ship a half-read one.
          return put(
            {
              status: "indeterminate",
              reason: `coverage read failed while resolving a locality that spans multiple counties: ${
                err instanceof Error ? err.message : String(err)
              }`,
            },
            INDETERMINATE_TTL_MS,
          );
        }

        const decision = decideAmbiguousLocality(withCoverage);
        if (decision.kind === "covered") {
          // Every candidate is served, so the locality is served whatever the winner would
          // have been. No list: rule 2 asks for one on the two candidate-bearing answers.
          return put({ status: "covered" }, COUNTY_VERDICT_TTL_MS);
        }
        if (decision.kind === "not-covered") {
          let pluralityName: string | null;
          try {
            pluralityName = await countyName(decision.countyFips);
          } catch {
            pluralityName = null;
          }
          if (!pluralityName) {
            // Same rule as the resolved-county path above: not-covered MUST carry all three
            // fields, so a plurality county with no name on record is a refusal, not a guess.
            return put(
              {
                status: "indeterminate",
                reason: `county ${decision.countyFips} is the plurality of an ambiguous locality but has no name on record to report a not-covered verdict`,
                candidates: decision.candidates,
              },
              INDETERMINATE_TTL_MS,
            );
          }
          return put(
            {
              status: "not-covered",
              countyFips: decision.countyFips,
              countyName: pluralityName,
              state: "TX",
              candidates: decision.candidates,
            },
            COUNTY_VERDICT_TTL_MS,
          );
        }
        // Mixed: the candidates disagree, so no answer is unanimous and the refusal has to
        // carry WHICH counties are served and which are not -- that disagreement is the
        // finding, and a bare "no dominant match" would hide it.
        const detail = decision.candidates
          .map((c) => `${c.countyFips} (${c.n}${c.covered ? ", covered" : ", not covered"})`)
          .join(", ");
        return put(
          {
            status: "indeterminate",
            reason: `locality resolves to multiple candidate counties with no dominant match, and the serving path does not hold all of them: ${detail}`,
            candidates: decision.candidates,
          },
          INDETERMINATE_TTL_MS,
        );
      }

      const countyFips = resolution.countyFips;
      let covered: boolean;
      try {
        covered = await countyServesAtLeastOneParcel(countyFips);
      } catch (err) {
        return put(
          {
            status: "indeterminate",
            reason: `coverage read failed: ${err instanceof Error ? err.message : String(err)}`,
          },
          INDETERMINATE_TTL_MS,
        );
      }

      if (covered) {
        return put({ status: "covered" }, COUNTY_VERDICT_TTL_MS);
      }

      let name: string | null;
      try {
        name = await countyName(countyFips);
      } catch {
        name = null;
      }
      if (!name) {
        // not-covered MUST carry all three fields (CONTRACT) — a resolved
        // county with no name on record is a real gap, never a guess.
        return put(
          {
            status: "indeterminate",
            reason: `county ${countyFips} resolved but has no name on record to report a not-covered verdict`,
          },
          INDETERMINATE_TTL_MS,
        );
      }
      return put(
        { status: "not-covered", countyFips, countyName: name, state: "TX" },
        COUNTY_VERDICT_TTL_MS,
      );
    },
    async close() {
      cache.clear();
      localityCache.clear();
    },
  };
}

export function resolveCoverageDatabaseUrl(explicit?: string): string | undefined {
  return (
    explicit ??
    process.env.OVERLAY_DATABASE_URL ??
    process.env.CORTEX_DATABASE_URL ??
    process.env.DEPLOYMENT_DATABASE_URL
  );
}

/** In-memory store for tests — never opens a real connection. */
export function memoryCoverageCheckStore(fixture: {
  /** county_fips -> match rows a zip lookup would return, e.g. { "76541": [{countyFips:"48027",n:6897},{countyFips:"48319",n:3}] }. */
  zipRows?: Readonly<Record<string, readonly CountyMatchCount[]>>;
  /**
   * The ZIP-AND-city split (P-205b), keyed `${zip}|${CITY-UPPERCASED}` -- the same two
   * splits the real store gets from its one scan. A key that is absent, or mapped to an
   * empty array, means the narrowing returned no rows, which is treated as no new
   * information rather than as an absence, exactly like the real query.
   */
  zipCityRows?: Readonly<Record<string, readonly CountyMatchCount[]>>;
  cityRows?: Readonly<Record<string, readonly CountyMatchCount[]>>;
  tier1Counties?: ReadonlySet<string>;
  countyNames?: Readonly<Record<string, string>>;
  /** Simulate an unreachable/timed-out database for every query. */
  failReads?: boolean;
}): CoverageCheckStore {
  const zipRows = fixture.zipRows ?? {};
  const zipCityRows = fixture.zipCityRows ?? {};
  const cityRows = fixture.cityRows ?? {};
  const tier1 = fixture.tier1Counties ?? new Set<string>();
  const names = fixture.countyNames ?? {};

  async function checkCoverage(input: CoverageCheckInput): Promise<CoverageVerdict> {
    if (isDeclaredNonTexas(input.state)) {
      return {
        status: "indeterminate",
        reason: `state "${input.state}" is outside Texas; this coverage source only covers the Texas market`,
      };
    }
    const zip = normalizeZip(input.zip);
    const city = normalizeCity(input.city);
    if (!zip && !city) {
      return { status: "indeterminate", reason: "no zip or city provided to resolve a county" };
    }
    if (fixture.failReads) {
      return { status: "indeterminate", reason: "coverage read failed: simulated database failure" };
    }
    let resolution: CountyResolution;
    if (zip && city) {
      // Same ORDER as the real store, through the same two pure decisions: judge the
      // ZIP-only split first, narrow only if it was ambiguous, and keep the ZIP-only
      // ambiguity when the narrowing returned nothing.
      const zipOnly = chooseDominantCounty(zipRows[zip] ?? []);
      const narrowed = zipCityRows[`${zip}|${city.toUpperCase()}`] ?? [];
      resolution = narrowByCity(zipOnly, narrowed);
    } else if (zip) {
      resolution = chooseDominantCounty(zipRows[zip] ?? []);
    } else {
      resolution = chooseDominantCounty(cityRows[(city as string).toUpperCase()] ?? []);
    }
    if (resolution.kind === "not-found") {
      return { status: "indeterminate", reason: "locality not found in the statewide parcel index" };
    }
    if (resolution.kind === "ambiguous") {
      // Rule 2, through the SAME pure decision the real store uses -- one implementation,
      // so the fixture and the database cannot answer differently.
      const withCoverage: CountyCandidateCoverage[] = resolution.candidates.map((c) => ({
        ...c,
        covered: tier1.has(c.countyFips),
      }));
      const decision = decideAmbiguousLocality(withCoverage);
      if (decision.kind === "covered") return { status: "covered" };
      const pluralityName = names[decision.candidates[0]!.countyFips];
      if (decision.kind === "not-covered") {
        if (!pluralityName) {
          return {
            status: "indeterminate",
            reason: `county ${decision.countyFips} is the plurality of an ambiguous locality but has no name on record to report a not-covered verdict`,
            candidates: decision.candidates,
          };
        }
        return {
          status: "not-covered",
          countyFips: decision.countyFips,
          countyName: pluralityName,
          state: "TX",
          candidates: decision.candidates,
        };
      }
      const detail = decision.candidates
        .map((c) => `${c.countyFips} (${c.n}${c.covered ? ", covered" : ", not covered"})`)
        .join(", ");
      return {
        status: "indeterminate",
        reason: `locality resolves to multiple candidate counties with no dominant match, and the serving path does not hold all of them: ${detail}`,
        candidates: decision.candidates,
      };
    }
    const countyFips = resolution.countyFips;
    if (tier1.has(countyFips)) return { status: "covered" };
    const countyName = names[countyFips];
    if (!countyName) {
      return {
        status: "indeterminate",
        reason: `county ${countyFips} resolved but has no name on record to report a not-covered verdict`,
      };
    }
    return { status: "not-covered", countyFips, countyName, state: "TX" };
  }

  return { checkCoverage, close: async () => {} };
}
