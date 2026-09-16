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

export type CoverageVerdict =
  | { status: "covered" }
  | { status: "not-covered"; countyFips: string; countyName: string; state: string }
  | { status: "indeterminate"; reason: string };

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

    const localityKey = zip ? `zip:${zip}` : `city:${(city ?? "").toUpperCase()}`;
    const cached = localityCache.get(localityKey);
    if (cached && cached.expiresAt > Date.now()) return cached.resolution;

    const sql = await openSql(options.databaseUrl, GEO_RESOLUTION_STATEMENT_TIMEOUT_MS);
    try {
      const rows = zip
        ? await sql<Array<{ county_fips: string; n: number }>>`
            SELECT county_fips, count(*)::int AS n
            FROM txgio_parcel
            WHERE situs_zip = ${zip}
            GROUP BY county_fips
          `
        : await sql<Array<{ county_fips: string; n: number }>>`
            SELECT county_fips, count(*)::int AS n
            FROM txgio_parcel
            WHERE upper(situs_city) = upper(${city as string})
            GROUP BY county_fips
          `;
      const resolution = chooseDominantCounty(
        rows.map((r) => ({ countyFips: r.county_fips, n: Number(r.n) })),
      );
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
        const candidates = resolution.candidates.map((c) => `${c.countyFips} (${c.n})`).join(", ");
        return put(
          {
            status: "indeterminate",
            reason: `locality resolves to multiple candidate counties with no dominant match: ${candidates}`,
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
  cityRows?: Readonly<Record<string, readonly CountyMatchCount[]>>;
  tier1Counties?: ReadonlySet<string>;
  countyNames?: Readonly<Record<string, string>>;
  /** Simulate an unreachable/timed-out database for every query. */
  failReads?: boolean;
}): CoverageCheckStore {
  const zipRows = fixture.zipRows ?? {};
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
    const rows = zip ? (zipRows[zip] ?? []) : (cityRows[(city as string).toUpperCase()] ?? []);
    const resolution = chooseDominantCounty(rows);
    if (resolution.kind === "not-found") {
      return { status: "indeterminate", reason: "locality not found in the statewide parcel index" };
    }
    if (resolution.kind === "ambiguous") {
      const candidates = resolution.candidates.map((c) => `${c.countyFips} (${c.n})`).join(", ");
      return {
        status: "indeterminate",
        reason: `locality resolves to multiple candidate counties with no dominant match: ${candidates}`,
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
