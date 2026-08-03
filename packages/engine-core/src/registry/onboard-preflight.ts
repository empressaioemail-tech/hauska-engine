/**
 * onboard-preflight(fips) — the OPS-8 pre-flight gate (operator-ratified
 * 2026-08-03, OPS-8 blocker-free onboarding model). Reads the frozen
 * registry row(s) for a fips and runs 8 checks, each producing PASS or a
 * NAMED rail-decline (never a throw for an expected condition). A check that
 * needs live DB/network and has no creds configured outputs outcome
 * "DECLINE", reason "not runnable: <missing env>" — never a fake PASS.
 *
 * This module is dependency-injected (PreflightDeps) so it can run without
 * live credentials in CI: every check that reaches outside the registry row
 * itself takes an optional probe function; when the probe is absent the
 * check declines honestly instead of skipping silently.
 *
 * OPERATE-NOT-REBUILD: this extends the registry (jurisdiction-registry.ts)
 * and the cohort loader (parcel-cohort-loader.ts) — it is not a parallel
 * onboarding harness. It does not touch block13-cert-grade.mjs's warm/cert
 * path; SCOPE 3 (cert scope annotations) is where pre-flight declines feed
 * the cert artifact, via the decline list this module produces.
 */
import {
  loadJurisdictionRegistryRowsForFips,
  type JurisdictionRegistryRow,
} from "./jurisdiction-registry.js";
import { buildWhereClause } from "./parcel-cohort-loader.js";

/** The 8 OPS-8 pre-flight checks, in ratified order. */
export type PreflightCheckId =
  | "railASourceReachable"
  | "zoningSourceReachableOrUnzoned"
  | "parcelLayerWired"
  | "supersededCohortMeasured"
  | "geometryParitySample"
  | "servePathHealth"
  | "costGate"
  | "mixedVintageResidueScan";

export type PreflightOutcome = "PASS" | "DECLINE";

/** defectClass groups a decline for the class-grouped backlog. */
export type DefectClass =
  | "ADAPTER-NEEDED"
  | "PARCEL-LAYER-UNWIRED"
  | "GEOMETRY-DIVERGE"
  | "SUPERSEDED-GT3PCT"
  | "SERVE-PATH-UNHEALTHY"
  | "COST-GATE"
  | "MIXED-VINTAGE";

export interface PreflightCheckResult {
  readonly id: PreflightCheckId;
  readonly name: string;
  readonly outcome: PreflightOutcome;
  readonly reason?: string;
  /** Carried per the ratified caveat on check 5: sample parity BOUNDS risk, does not prove the cohort. */
  readonly caveat?: string;
  readonly defectClass?: DefectClass;
}

export interface PreflightRowReport {
  readonly rowId: string;
  readonly checks: readonly PreflightCheckResult[];
  readonly railPlan: {
    readonly runs: readonly string[];
    readonly declines: readonly string[];
  };
}

export interface PreflightReport {
  readonly fips: string;
  readonly rows: readonly PreflightRowReport[];
}

/** One ledger-event JSON object per decline, for the class-grouped backlog. */
export interface PreflightLedgerEvent {
  readonly ts: string;
  readonly fips: string;
  readonly rowId: string;
  readonly railOrCheck: PreflightCheckId;
  readonly declineReason: string;
  readonly defectClass: DefectClass;
}

/**
 * Result of probing a live source (Rail A adapter, zoning source, serve
 * path). Callers inject a probe; when omitted, the check is not-runnable.
 */
export interface SourceProbeResult {
  readonly reachable: boolean;
  readonly detail?: string;
}

/** Result of a sample-cohort cost probe (commitment #3, < $200). */
export interface CostProbeResult {
  readonly estimatedUsd: number;
  readonly detail?: string;
}

/** Result of the R28/R33 geometry warm==cert parity sample probe. */
export interface GeometryParityProbeResult {
  readonly sampleSize: number;
  readonly diverged: boolean;
  readonly detail?: string;
}

/** Result of the superseded-cohort measurement (parcel layer ∩ NOT current cadastral). */
export interface SupersededCohortProbeResult {
  readonly supersededCount: number;
  readonly totalCount: number;
}

/** Result of the mixed-vintage / stale-residue scan. */
export interface MixedVintageProbeResult {
  readonly residueCount: number;
  readonly measured: boolean;
}

/**
 * Injectable probes. Every field is optional; an absent probe makes its
 * check DECLINE "not runnable: <missing env>" rather than fabricating a PASS.
 * This is how the checks that need live DB/network stay honest in CI, where
 * no DATABASE_URL or source credentials are configured (see .github/workflows/ci.yml).
 */
export interface PreflightDeps {
  /** Check 1: Rail A source + adapter reachability probe. */
  probeRailASource?: (row: JurisdictionRegistryRow) => Promise<SourceProbeResult>;
  /** Check 2: zoning source reachability probe (only called for euclidean-zoned rows). */
  probeZoningSource?: (row: JurisdictionRegistryRow) => Promise<SourceProbeResult>;
  /** Check 4: superseded-cohort measurement. */
  probeSupersededCohort?: (row: JurisdictionRegistryRow) => Promise<SupersededCohortProbeResult>;
  /** Check 5: geometry parity sample (~5 parcels). */
  probeGeometryParity?: (row: JurisdictionRegistryRow) => Promise<GeometryParityProbeResult>;
  /** Check 6: serve-path health (retrieval auth + atom-chain reads + ledger write). */
  probeServePathHealth?: (row: JurisdictionRegistryRow) => Promise<SourceProbeResult>;
  /** Check 7: cost on a sample cohort. */
  probeCostSample?: (row: JurisdictionRegistryRow) => Promise<CostProbeResult>;
  /** Check 8: mixed-vintage / stale-residue scan. */
  probeMixedVintageResidue?: (row: JurisdictionRegistryRow) => Promise<MixedVintageProbeResult>;
  /** Clock override for tests. */
  now?: () => Date;
}

const COST_GATE_USD = 200;
/** Superseded-cohort decline threshold: >3% superseded is a named decline (SUPERSEDED-GT3PCT). */
const SUPERSEDED_DECLINE_FRACTION = 0.03;

function notRunnable(
  id: PreflightCheckId,
  name: string,
  missingEnv: string,
  defectClass: DefectClass,
): PreflightCheckResult {
  return {
    id,
    name,
    outcome: "DECLINE",
    reason: `not runnable: ${missingEnv}`,
    defectClass,
  };
}

/** Check 1 — Rail A source + adapter reachable. */
async function checkRailASourceReachable(
  row: JurisdictionRegistryRow,
  deps: PreflightDeps,
): Promise<PreflightCheckResult> {
  const id: PreflightCheckId = "railASourceReachable";
  const name = "Rail A source + adapter reachable";
  if (!row.railPerParcel) {
    return {
      id,
      name,
      outcome: "DECLINE",
      reason: "source unreachable, needs adapter: no Rail A layer wired for this row",
      defectClass: "ADAPTER-NEEDED",
    };
  }
  if (!deps.probeRailASource) {
    return notRunnable(id, name, "probeRailASource not configured", "ADAPTER-NEEDED");
  }
  const probe = await deps.probeRailASource(row);
  if (!probe.reachable) {
    return {
      id,
      name,
      outcome: "DECLINE",
      reason: `source unreachable, needs adapter: ${probe.detail ?? "Rail A featureServerLayerUrl did not respond"}`,
      defectClass: "ADAPTER-NEEDED",
    };
  }
  return { id, name, outcome: "PASS" };
}

/** Check 2 — Zoning source reachable / unzoned-flagged. Unzoned honest-absence is a PASS. */
async function checkZoningSourceReachableOrUnzoned(
  row: JurisdictionRegistryRow,
  deps: PreflightDeps,
): Promise<PreflightCheckResult> {
  const id: PreflightCheckId = "zoningSourceReachableOrUnzoned";
  const name = "Zoning source reachable / unzoned-flagged";
  if (row.zoningRegime === "unzoned") {
    return {
      id,
      name,
      outcome: "PASS",
      reason: "unzoned regime — zoning/setback honest-absence is the expected pass state",
    };
  }
  // euclidean-zoned: zoning source must be reachable (or explicitly flagged TODO in the row).
  if (row.flags.includes("ZONING_SOURCE_TODO")) {
    return {
      id,
      name,
      outcome: "DECLINE",
      reason: "source unreachable, needs adapter: zoning source not yet wired (row flagged ZONING_SOURCE_TODO)",
      defectClass: "ADAPTER-NEEDED",
    };
  }
  if (!deps.probeZoningSource) {
    return notRunnable(id, name, "probeZoningSource not configured", "ADAPTER-NEEDED");
  }
  const probe = await deps.probeZoningSource(row);
  if (!probe.reachable) {
    return {
      id,
      name,
      outcome: "DECLINE",
      reason: `source unreachable, needs adapter: ${probe.detail ?? "zoning source did not respond"}`,
      defectClass: "ADAPTER-NEEDED",
    };
  }
  return { id, name, outcome: "PASS" };
}

/** Check 3 — Rail C parcel layer wired in registry row (mechanical, no probe needed). */
function checkParcelLayerWired(row: JurisdictionRegistryRow): PreflightCheckResult {
  const id: PreflightCheckId = "parcelLayerWired";
  const name = "Rail C parcel layer wired in registry row";
  if (!row.railPerParcel) {
    return {
      id,
      name,
      outcome: "DECLINE",
      reason: "parcel layer not wired: row has no railPerParcel",
      defectClass: "PARCEL-LAYER-UNWIRED",
    };
  }
  if (!row.railPerParcel.districtField || !row.railPerParcel.featureServerLayerUrl) {
    return {
      id,
      name,
      outcome: "DECLINE",
      reason: "parcel layer not wired: authoritative parcel layer or district field missing",
      defectClass: "PARCEL-LAYER-UNWIRED",
    };
  }
  // Mechanically confirm the row's parcel filter compiles to a WHERE clause.
  try {
    buildWhereClause(row, null);
  } catch (err) {
    return {
      id,
      name,
      outcome: "DECLINE",
      reason: `parcel layer not wired: ${err instanceof Error ? err.message : String(err)}`,
      defectClass: "PARCEL-LAYER-UNWIRED",
    };
  }
  return { id, name, outcome: "PASS" };
}

/** Check 4 — Superseded cohort measured (parcel layer ∩ NOT current cadastral). */
async function checkSupersededCohortMeasured(
  row: JurisdictionRegistryRow,
  deps: PreflightDeps,
): Promise<PreflightCheckResult> {
  const id: PreflightCheckId = "supersededCohortMeasured";
  const name = "Superseded cohort measured (expected honest-decline count reported up front)";
  if (!deps.probeSupersededCohort) {
    return notRunnable(id, name, "probeSupersededCohort not configured", "SUPERSEDED-GT3PCT");
  }
  const probe = await deps.probeSupersededCohort(row);
  const fraction = probe.totalCount > 0 ? probe.supersededCount / probe.totalCount : 0;
  if (fraction > SUPERSEDED_DECLINE_FRACTION) {
    return {
      id,
      name,
      outcome: "DECLINE",
      reason: `superseded cohort ${probe.supersededCount}/${probe.totalCount} (${(fraction * 100).toFixed(1)}%) exceeds the ${(SUPERSEDED_DECLINE_FRACTION * 100).toFixed(0)}% threshold`,
      defectClass: "SUPERSEDED-GT3PCT",
    };
  }
  return {
    id,
    name,
    outcome: "PASS",
    reason: `superseded cohort ${probe.supersededCount}/${probe.totalCount} (${(fraction * 100).toFixed(1)}%) — reported as expected honest-decline count up front`,
  };
}

/** Check 5 — Geometry R28/R33 warm==cert parity on a ~5-parcel sample. Carries the ratified caveat. */
async function checkGeometryParitySample(
  row: JurisdictionRegistryRow,
  deps: PreflightDeps,
): Promise<PreflightCheckResult> {
  const id: PreflightCheckId = "geometryParitySample";
  const name = "Geometry R28/R33 warm==cert parity on a sample";
  const caveat = "sample parity BOUNDS risk, it does not prove the cohort";
  if (!deps.probeGeometryParity) {
    return { ...notRunnable(id, name, "probeGeometryParity not configured", "GEOMETRY-DIVERGE"), caveat };
  }
  const probe = await deps.probeGeometryParity(row);
  if (probe.diverged) {
    return {
      id,
      name,
      outcome: "DECLINE",
      reason: `geometry parity fails, fix engine first: ${probe.detail ?? `${probe.sampleSize}-parcel sample diverged`}`,
      caveat,
      defectClass: "GEOMETRY-DIVERGE",
    };
  }
  return {
    id,
    name,
    outcome: "PASS",
    reason: `${probe.sampleSize}-parcel sample: warm==cert parity holds`,
    caveat,
  };
}

/** Check 6 — Serve-path health (retrieval auth + atom-chain reads + ledger write). */
async function checkServePathHealth(
  row: JurisdictionRegistryRow,
  deps: PreflightDeps,
): Promise<PreflightCheckResult> {
  const id: PreflightCheckId = "servePathHealth";
  const name = "Serve-path health (retrieval auth + atom-chain reads + ledger write)";
  if (!deps.probeServePathHealth) {
    return notRunnable(id, name, "probeServePathHealth not configured", "SERVE-PATH-UNHEALTHY");
  }
  const probe = await deps.probeServePathHealth(row);
  if (!probe.reachable) {
    return {
      id,
      name,
      outcome: "DECLINE",
      reason: `serve path unhealthy: ${probe.detail ?? "retrieval auth, atom-chain read, or ledger write failed"}`,
      defectClass: "SERVE-PATH-UNHEALTHY",
    };
  }
  return { id, name, outcome: "PASS" };
}

/** Check 7 — Cost on a sample cohort < $200 (commitment #3). */
async function checkCostGate(
  row: JurisdictionRegistryRow,
  deps: PreflightDeps,
): Promise<PreflightCheckResult> {
  const id: PreflightCheckId = "costGate";
  const name = `Cost on a sample cohort < $${COST_GATE_USD} (commitment #3)`;
  if (!deps.probeCostSample) {
    return notRunnable(id, name, "probeCostSample not configured", "COST-GATE");
  }
  const probe = await deps.probeCostSample(row);
  if (probe.estimatedUsd >= COST_GATE_USD) {
    return {
      id,
      name,
      outcome: "DECLINE",
      reason: `sample-cohort cost $${probe.estimatedUsd.toFixed(2)} meets or exceeds the $${COST_GATE_USD} hard-kill threshold${probe.detail ? `: ${probe.detail}` : ""}`,
      defectClass: "COST-GATE",
    };
  }
  return {
    id,
    name,
    outcome: "PASS",
    reason: `sample-cohort cost $${probe.estimatedUsd.toFixed(2)} < $${COST_GATE_USD}`,
  };
}

/** Check 8 — Mixed-vintage / stale-residue scan. */
async function checkMixedVintageResidueScan(
  row: JurisdictionRegistryRow,
  deps: PreflightDeps,
): Promise<PreflightCheckResult> {
  const id: PreflightCheckId = "mixedVintageResidueScan";
  const name = "Mixed-vintage / stale-residue scan";
  if (!deps.probeMixedVintageResidue) {
    return notRunnable(id, name, "probeMixedVintageResidue not configured", "MIXED-VINTAGE");
  }
  const probe = await deps.probeMixedVintageResidue(row);
  if (!probe.measured) {
    return {
      id,
      name,
      outcome: "DECLINE",
      reason: "mixed-vintage residue unmeasured: scan did not complete",
      defectClass: "MIXED-VINTAGE",
    };
  }
  if (probe.residueCount > 0) {
    return {
      id,
      name,
      outcome: "DECLINE",
      reason: `mixed-vintage residue unmeasured: ${probe.residueCount} parcel(s) carry residue from a prior partial warm`,
      defectClass: "MIXED-VINTAGE",
    };
  }
  return { id, name, outcome: "PASS", reason: "no stale-residue detected" };
}

const ALL_CHECKS: ReadonlyArray<
  (row: JurisdictionRegistryRow, deps: PreflightDeps) => Promise<PreflightCheckResult> | PreflightCheckResult
> = [
  checkRailASourceReachable,
  checkZoningSourceReachableOrUnzoned,
  checkParcelLayerWired,
  checkSupersededCohortMeasured,
  checkGeometryParitySample,
  checkServePathHealth,
  checkCostGate,
  checkMixedVintageResidueScan,
];

async function runRowPreflight(
  row: JurisdictionRegistryRow,
  deps: PreflightDeps,
): Promise<{ report: PreflightRowReport; events: PreflightLedgerEvent[] }> {
  const now = deps.now ?? (() => new Date());
  const checks: PreflightCheckResult[] = [];
  for (const check of ALL_CHECKS) {
    checks.push(await check(row, deps));
  }
  const runs = checks.filter((c) => c.outcome === "PASS").map((c) => c.name);
  const declines = checks.filter((c) => c.outcome === "DECLINE").map((c) => c.name);
  const events: PreflightLedgerEvent[] = checks
    .filter((c): c is PreflightCheckResult & { reason: string; defectClass: DefectClass } =>
      c.outcome === "DECLINE" && c.reason != null && c.defectClass != null,
    )
    .map((c) => ({
      ts: now().toISOString(),
      fips: row.fips,
      rowId: row.rowId,
      railOrCheck: c.id,
      declineReason: c.reason,
      defectClass: c.defectClass,
    }));
  return {
    report: { rowId: row.rowId, checks, railPlan: { runs, declines } },
    events,
  };
}

/**
 * Run the OPS-8 pre-flight gate for every registry row that shares `fips`.
 * Returns the JSON report shape plus the flat ledger-event list (one per
 * decline) for the class-grouped defect backlog.
 */
export async function runOnboardPreflight(
  fips: string,
  deps: PreflightDeps = {},
): Promise<{ report: PreflightReport; ledgerEvents: PreflightLedgerEvent[] }> {
  const rows = loadJurisdictionRegistryRowsForFips(fips);
  const rowReports: PreflightRowReport[] = [];
  const ledgerEvents: PreflightLedgerEvent[] = [];
  for (const row of rows) {
    const { report, events } = await runRowPreflight(row, deps);
    rowReports.push(report);
    ledgerEvents.push(...events);
  }
  return {
    report: { fips, rows: rowReports },
    ledgerEvents,
  };
}

/**
 * Cert scope annotation (SCOPE 3, operator-ruled 2026-08-03,
 * cert-with-scope-annotation). Names, per declined core rail: (1) what
 * happened — the rail and its named decline reason; (2) what it takes to
 * fix — the defect class the gap joins on the class-grouped backlog. A cert
 * with zero annotations is a full cert.
 */
export interface ScopeAnnotation {
  readonly rail: PreflightCheckId;
  readonly declineReason: string;
  readonly defectClass: DefectClass;
}

/** The core rails whose decline warrants a cert scope annotation (parcels, or zoning in a zoned jurisdiction). */
const CORE_RAIL_CHECK_IDS: ReadonlySet<PreflightCheckId> = new Set([
  "railASourceReachable",
  "parcelLayerWired",
  "zoningSourceReachableOrUnzoned",
]);

/**
 * Derive a cert's scopeAnnotations array from a pre-flight row report, per
 * the operator ruling: only CORE rail declines (parcels, or zoning in a
 * zoned jurisdiction) become an annotation — and a zoning decline on an
 * unzoned row is never eligible, because it PASSes (honest-absence is the
 * expected state, not a gap). Returns [] when the row cleared pre-flight
 * cleanly (or had no declines on a core rail) — the empty-array case is a
 * full cert, per the ruling.
 */
export function deriveScopeAnnotations(
  rowReport: PreflightRowReport | undefined,
): ScopeAnnotation[] {
  if (!rowReport) return [];
  const annotations: ScopeAnnotation[] = [];
  for (const check of rowReport.checks) {
    if (check.outcome !== "DECLINE") continue;
    if (!CORE_RAIL_CHECK_IDS.has(check.id)) continue;
    if (!check.reason || !check.defectClass) continue;
    annotations.push({ rail: check.id, declineReason: check.reason, defectClass: check.defectClass });
  }
  return annotations;
}
