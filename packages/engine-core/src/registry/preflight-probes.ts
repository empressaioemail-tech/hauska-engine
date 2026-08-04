/**
 * OPS-8 pre-flight CLI-layer probe builders (checks 5-7: geometry parity,
 * serve-path health, cost sample). Wires real implementations onto the
 * onboard-preflight.ts dependency-injection seam (PreflightDeps) without
 * changing that module's check logic — this file supplies the probe
 * functions; onboard-preflight.mjs (the CLI) constructs them with live
 * creds/config and passes them in as deps.
 *
 * OPERATE-NOT-REBUILD: check 5 (and check 7, which piggybacks on it) reuse
 * the EXACT same per-parcel grading machinery block13-cert-grade.mjs's
 * roster loop runs — gradeOneParcelInQueryMode from cert-grade-core.ts (a
 * src/ module, injected by the caller) — rather than a parallel harness.
 *
 * Dependency direction: this file imports ONLY from other src/ modules
 * (jurisdiction-registry.ts, onboard-preflight.ts, cert-grade-core.ts) —
 * never from scripts/. The reusable grading machinery lives in
 * cert-grade-core.ts precisely so this module and block13-cert-grade.mjs
 * both depend on it, rather than this module depending on the CLI script
 * (which would drag the script's top-level side effects — arg parsing, DB
 * connection setup — into whatever test file imports this module).
 *
 * Every builder here is a plain function over injected collaborators
 * (fetch, sql tag, grading function, sample/roads loaders) so each probe's
 * decline/pass mapping is unit-testable with stubs, with no live DB/network
 * required for the tests themselves.
 */
import type { JurisdictionRegistryRow } from "./jurisdiction-registry.js";
import type {
  SourceProbeResult,
  CostProbeResult,
  GeometryParityProbeResult,
} from "./onboard-preflight.js";
import type { CertGradeContext, ParcelGradeResult } from "./cert-grade-core.js";

/** The shape of cert-grade-core.ts's gradeOneParcelInQueryMode (or an equivalent grader). */
export type GradeOneParcelFn = (
  parcelNodeId: string,
  ctx: CertGradeContext & { districtPrefix: string | null },
) => Promise<ParcelGradeResult>;

export interface GeometrySampleDeps {
  readonly sql: CertGradeContext["sql"];
  readonly txSql: CertGradeContext["txSql"];
  readonly storage: CertGradeContext["storage"];
  readonly descriptor: unknown;
  /** Loads a deterministic parcelNodeId[] sample for a row (first N by prop id, sorted). */
  readonly loadSample: (row: JurisdictionRegistryRow, sampleSize?: number) => Promise<string[]>;
  /** Loads road-node warm sources for a row's fips (grading context). */
  readonly loadRoads: (fips: string) => Promise<unknown[]>;
  /** The extracted cert-grade-core.ts grader (gradeOneParcelInQueryMode). */
  readonly gradeOneParcel: GradeOneParcelFn;
  readonly sampleSize?: number;
}

/**
 * Ratified caveat carried on both PASS and DECLINE for check 5 (also duplicated
 * in onboard-preflight.ts as the module-level caveat string constant); kept
 * here too so a probe-level consumer testing this file alone sees the same text.
 */
export const GEOMETRY_PARITY_SAMPLE_CAVEAT =
  "sample parity BOUNDS risk, it does not prove the cohort";

/**
 * Check 5 — geometry R28/R33 warm==cert parity on a ~5-parcel sample. Grades
 * the sample with the EXACT same machinery as block13-cert-grade.mjs
 * (gradeOneParcelInQueryMode, injected) and reports diverged=true if any
 * sampled parcel graded as a hard fail (not an honest-decline — an honest
 * per-parcel decline is not a parity divergence, it is the expected
 * no-zoning-fact / stale-residue-free state carrying forward correctly).
 */
export function buildGeometryParityProbe(
  deps: GeometrySampleDeps,
): (row: JurisdictionRegistryRow) => Promise<GeometryParityProbeResult> {
  return async (row) => {
    const sampleSize = deps.sampleSize ?? 5;
    // A row without a wired parcel rail (e.g. pre-flight-pending, no
    // railPerParcel) cannot produce a cohort sample at all — loadSample
    // (backed by loadRegistryDistrictCohort) throws for that shape. Checks
    // 1/3 already carry the ADAPTER-NEEDED / PARCEL-LAYER-UNWIRED decline
    // for that condition; this probe declines its own check honestly
    // instead of throwing and taking down the rest of the row's report.
    let sample: string[];
    try {
      sample = await deps.loadSample(row, sampleSize);
    } catch (err) {
      return {
        sampleSize: 0,
        diverged: true,
        detail: `sample load failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (sample.length === 0) {
      return {
        sampleSize: 0,
        diverged: true,
        detail: "empty sample: row cohort returned 0 parcels — cannot grade parity",
      };
    }
    let roads: unknown[];
    try {
      roads = await deps.loadRoads(row.fips);
    } catch (err) {
      return {
        sampleSize: sample.length,
        diverged: true,
        detail: `road-node load failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const failed: string[] = [];
    for (const parcelNodeId of sample) {
      let result: ParcelGradeResult;
      try {
        result = await deps.gradeOneParcel(parcelNodeId, {
          sql: deps.sql,
          txSql: deps.txSql,
          storage: deps.storage,
          roads,
          descriptor: deps.descriptor,
          districtPrefix: null,
        });
      } catch (err) {
        failed.push(`${parcelNodeId} (grade threw: ${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      // pass=true covers both a mechanical warm==cert match AND an honest
      // decline (no-zoning-fact-on-substrate, a pre-existing honest-decline
      // envelope) — both are parity-consistent outcomes. Only a hard fail
      // (pass=false) counts as a sample divergence.
      if (!result.pass) failed.push(parcelNodeId);
    }
    if (failed.length > 0) {
      return {
        sampleSize: sample.length,
        diverged: true,
        detail: `${failed.length} of ${sample.length} parcels diverged: ${failed.join(", ")}`,
      };
    }
    return { sampleSize: sample.length, diverged: false };
  };
}

export interface ServePathHealthDeps {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Loads a deterministic parcelNodeId[] sample for a row (reuses the same sample as check 5/7). */
  readonly loadSample: (row: JurisdictionRegistryRow, sampleSize?: number) => Promise<string[]>;
  /** Injectable fetch (tests stub this; defaults to global fetch). */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Check 6 — serve-path health against the deployed retrieval-api:
 *   (a) GET /health/search expects 2xx
 *   (b) authed GET /search expects 200 (401 -> named decline; this exact
 *       silent-401 class caused a production outage 2026-08-03)
 *   (c) authed GET /property-nodes/<sample parcel>/atom-chain expects 200
 *
 * Ledger-write probing is a named partial: the coverage ledger lives in
 * map/cortex Neon, not this repo, so it is not wireable from engine. The
 * check passes/fails on (a)-(c) only; the partial is always named in detail
 * so a PASS never silently implies ledger-write health.
 */
export function buildServePathHealthProbe(
  deps: ServePathHealthDeps,
): (row: JurisdictionRegistryRow) => Promise<SourceProbeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const base = deps.baseUrl.replace(/\/$/, "");
  const partialNote =
    "ledger-write probe: not wireable from engine (ledger lives in map/cortex Neon)";

  return async (row) => {
    // (a) GET /health/search — expects 2xx.
    let healthRes: Response;
    try {
      healthRes = await fetchImpl(`${base}/health/search`, {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return {
        reachable: false,
        detail: `retrieval /health/search unreachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!healthRes.ok) {
      return {
        reachable: false,
        detail: `serve path unhealthy: retrieval /health/search HTTP ${healthRes.status}`,
      };
    }

    // (b) authed GET /search smoke — expects 200; 401 is the named decline
    // class that caused a production outage (silent auth failure).
    let searchRes: Response;
    try {
      searchRes = await fetchImpl(`${base}/search?q=setback&limit=1`, {
        method: "GET",
        headers: { Authorization: `Bearer ${deps.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return {
        reachable: false,
        detail: `retrieval /search unreachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (searchRes.status === 401) {
      return { reachable: false, detail: "serve path unhealthy: retrieval auth 401" };
    }
    if (searchRes.status !== 200) {
      return {
        reachable: false,
        detail: `serve path unhealthy: retrieval /search HTTP ${searchRes.status}`,
      };
    }

    // (c) authed GET /property-nodes/<sample parcel>/atom-chain — expects 200.
    let sample: string[];
    try {
      sample = await deps.loadSample(row, 1);
    } catch (err) {
      return {
        reachable: false,
        detail: `serve path unhealthy: sample load failed for atom-chain probe: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const sampleParcel = sample[0];
    if (!sampleParcel) {
      return {
        reachable: false,
        detail: "serve path unhealthy: no sample parcel available to probe atom-chain",
      };
    }
    let atomChainRes: Response;
    try {
      atomChainRes = await fetchImpl(`${base}/property-nodes/${sampleParcel}/atom-chain`, {
        method: "GET",
        headers: { Authorization: `Bearer ${deps.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return {
        reachable: false,
        detail: `retrieval /property-nodes/atom-chain unreachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (atomChainRes.status === 401) {
      return { reachable: false, detail: "serve path unhealthy: retrieval auth 401" };
    }
    if (atomChainRes.status !== 200) {
      return {
        reachable: false,
        detail: `serve path unhealthy: retrieval /property-nodes/atom-chain HTTP ${atomChainRes.status}`,
      };
    }

    return { reachable: true, detail: partialNote };
  };
}

/**
 * Cost model parameters (commitment #3, < $200/jurisdiction). These are
 * ESTIMATE parameters, not measured unit economics — named as constants so
 * the assumption is visible and reviewable, never silently baked into a
 * number. The sample run's real wall-clock and real external-call count are
 * measured; only the $/unit conversion is an estimate.
 */
export const COST_MODEL_USD_PER_COMPUTE_HOUR = 0.5; // ESTIMATE: blended small-instance compute rate
export const COST_MODEL_USD_PER_1K_EXTERNAL_CALLS = 2.0; // ESTIMATE: blended external HTTP+DB call cost

export interface CostSampleDeps {
  readonly sql: CertGradeContext["sql"];
  readonly txSql: CertGradeContext["txSql"];
  readonly storage: CertGradeContext["storage"];
  readonly descriptor: unknown;
  readonly loadSample: (row: JurisdictionRegistryRow, sampleSize?: number) => Promise<string[]>;
  readonly loadRoads: (fips: string) => Promise<unknown[]>;
  readonly gradeOneParcel: GradeOneParcelFn;
  /** Full cohort size for the row (registry cohort count, not the sample size). */
  readonly loadCohortCount: (row: JurisdictionRegistryRow) => Promise<number>;
  readonly sampleSize?: number;
  /** Clock override for tests (defaults to Date.now). */
  readonly now?: () => number;
  /** Per-external-call counter override for tests (defaults to a fetch-count-derived value of 1 per parcel). */
  readonly externalCallsPerParcel?: number;
}

/**
 * Sentinel used when the sample run cannot be measured at all (sample/road
 * load threw, or a wired-rail cohort could not be loaded). This is NOT a
 * measured cost — it is deliberately set above COST_GATE_USD so an
 * unmeasurable row declines the gate rather than silently reading as
 * "under $200" (a false PASS would be worse than a loud, named decline).
 */
export const COST_SAMPLE_UNMEASURABLE_SENTINEL_USD = 999_999;

/**
 * Check 7 — cost on a sample cohort < $200 (commitment #3). Piggybacks on
 * the same sample grading run as check 5 (does not re-run a separate
 * geometry pass — measures wall-clock across grading the same sample),
 * extrapolates per-parcel cost to the row's full cohort size, and compares
 * against the $200 gate using the named ESTIMATE cost-model constants above.
 * Always flags estimate: true in detail — the extrapolation is never
 * presented as a measured cohort cost.
 */
export function buildCostSampleProbe(
  deps: CostSampleDeps,
): (row: JurisdictionRegistryRow) => Promise<CostProbeResult> {
  return async (row) => {
    const sampleSize = deps.sampleSize ?? 5;
    const now = deps.now ?? (() => Date.now());

    let sample: string[];
    try {
      sample = await deps.loadSample(row, sampleSize);
    } catch (err) {
      return {
        estimatedUsd: COST_SAMPLE_UNMEASURABLE_SENTINEL_USD,
        detail: `estimate: true; sample load failed, cost could not be measured (treated as over-gate, not under): ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (sample.length === 0) {
      return {
        estimatedUsd: 0,
        detail: "estimate: true; empty sample — cannot extrapolate cost (0 parcels in cohort)",
      };
    }
    let roads: unknown[];
    try {
      roads = await deps.loadRoads(row.fips);
    } catch (err) {
      return {
        estimatedUsd: COST_SAMPLE_UNMEASURABLE_SENTINEL_USD,
        detail: `estimate: true; road-node load failed, cost could not be measured (treated as over-gate, not under): ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const startMs = now();
    for (const parcelNodeId of sample) {
      try {
        await deps.gradeOneParcel(parcelNodeId, {
          sql: deps.sql,
          txSql: deps.txSql,
          storage: deps.storage,
          roads,
          descriptor: deps.descriptor,
          districtPrefix: null,
        });
      } catch {
        // A single parcel's grade throwing does not abort the cost sample —
        // the wall-clock for that attempt still counts toward the estimate.
      }
    }
    const elapsedMs = Math.max(0, now() - startMs);

    const cohortCount = await deps.loadCohortCount(row);
    const callsPerParcel = deps.externalCallsPerParcel ?? 1; // ESTIMATE: 1 BCAD fetch per parcel in the sampled path
    const wallClockHoursPerParcel = elapsedMs / sample.length / 1000 / 3600;

    const computeUsdPerParcel = wallClockHoursPerParcel * COST_MODEL_USD_PER_COMPUTE_HOUR;
    const callsUsdPerParcel = (callsPerParcel / 1000) * COST_MODEL_USD_PER_1K_EXTERNAL_CALLS;
    const usdPerParcel = computeUsdPerParcel + callsUsdPerParcel;
    const estimatedUsd = usdPerParcel * cohortCount;

    return {
      estimatedUsd,
      detail:
        `estimate: true; sample=${sample.length} parcels, wall-clock=${elapsedMs}ms, ` +
        `cohortCount=${cohortCount}, $/compute-hour=${COST_MODEL_USD_PER_COMPUTE_HOUR} (ESTIMATE), ` +
        `$/1k-calls=${COST_MODEL_USD_PER_1K_EXTERNAL_CALLS} (ESTIMATE), extrapolated from sample only — not measured cohort cost`,
    };
  };
}
