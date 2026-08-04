/**
 * Warden findings sink — files-never-fixes: this module WRITES artifact JSON
 * and (optionally) POSTS findings to the cortex-side onboarding ledger. It
 * never writes an atom, never touches the atoms table. writeFindingsToJsonArtifact
 * always runs; postFindingsToLedger runs only when LEDGER_INGEST_URL and
 * LEDGER_INGEST_KEY are configured. A clean sweep (zero flag findings) still
 * writes/POSTs exactly one severity:"info" event so "swept and clean" is
 * provable evidence, not merely the absence of output (mirrors
 * onboard-preflight's "never fake a PASS by omission" discipline).
 *
 * PINNED CONTRACT (per the reviewed OPS-9 S5 design — do not change without
 * a planner-reviewed dispatch):
 *   POST {base}/api/onboarding-ledger/ingest
 *   Authorization: Bearer <LEDGER_INGEST_KEY>
 *   Content-Type: application/json
 *   body: { sourceKind: "warden-sweep", events: WardenFindingEvent[] }
 *     (gateSummary and certSummary are NEVER sent by this module — the
 *      contract's `never` typing on those two fields exists to keep a
 *      Warden POST from ever masquerading as an OPS-8 preflight or
 *      block13-cert-grade payload on the same ingest endpoint.)
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { WardenFindingEvent, WardenSweepReport } from "./types.js";

/** The pinned onboarding-ledger ingest request body shape for a Warden-sourced POST. */
export interface WardenLedgerIngestBody {
  readonly sourceKind: "warden-sweep";
  readonly events: readonly WardenFindingEvent[];
  /** Never populated by this module — see PINNED CONTRACT note above. */
  readonly gateSummary?: never;
  /** Never populated by this module — see PINNED CONTRACT note above. */
  readonly certSummary?: never;
}

/** Builds the one severity:"info" clean-sweep event so a clean sweep is provable. */
export function buildCleanSweepEvent(params: {
  readonly sweepId: string;
  readonly rowId: string;
  readonly fips: string;
  readonly checksRun: readonly WardenFindingEvent["checkId"][];
  readonly now: () => Date;
}): WardenFindingEvent {
  const { sweepId, rowId, fips, checksRun, now } = params;
  return {
    ts: now().toISOString(),
    sweepId,
    rowId,
    fips,
    parcelNodeId: null,
    checkId: checksRun[0] ?? "neighborConsistency",
    // defectClass is a required field on WardenFindingEvent (the type is
    // shared across flag and info severities); it carries no defect meaning
    // on this clean-sweep info event — "MIXED-VINTAGE-NEIGHBOR" is a neutral
    // placeholder here, disambiguated by severity:"info" and
    // evidence.clean===true, never read as an asserted defect.
    defectClass: "MIXED-VINTAGE-NEIGHBOR",
    evidence: { clean: true, checksRun },
    severity: "info",
    artifactRef: `warden-sweep:${sweepId}:clean`,
  };
}

/**
 * Assembles the sweep report from a flat findings list. `clean` is derived —
 * true iff no severity:"flag" finding is present.
 */
export function buildSweepReport(params: {
  readonly sweepId: string;
  readonly rowId: string;
  readonly fips: string;
  readonly checksRun: readonly WardenFindingEvent["checkId"][];
  readonly findings: readonly WardenFindingEvent[];
  readonly now: () => Date;
}): WardenSweepReport {
  const { sweepId, rowId, fips, checksRun, now } = params;
  const anyFlag = params.findings.some((f) => f.severity === "flag");
  const findings = anyFlag
    ? params.findings
    : [
        ...params.findings,
        buildCleanSweepEvent({ sweepId, rowId, fips, checksRun, now }),
      ];
  return {
    sweepId,
    rowId,
    fips,
    ts: now().toISOString(),
    checksRun,
    findings,
    clean: !anyFlag,
  };
}

/** Always writes the sweep report to a JSON artifact on disk. */
export async function writeFindingsToJsonArtifact(
  path: string,
  report: WardenSweepReport,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2), "utf8");
}

export interface PostFindingsResult {
  readonly posted: boolean;
  readonly httpStatus?: number;
  readonly detail?: string;
}

/**
 * POSTs the sweep's findings to the cortex-side onboarding-ledger ingest
 * endpoint, per the PINNED CONTRACT above. A no-op (posted: false) when url
 * or key is absent — this is the expected shape when LEDGER_INGEST_URL /
 * LEDGER_INGEST_KEY are not configured (e.g. local dev, CI), never an error.
 */
export async function postFindingsToLedger(
  url: string | null | undefined,
  key: string | null | undefined,
  report: WardenSweepReport,
  fetchImpl: typeof fetch = fetch,
): Promise<PostFindingsResult> {
  if (!url || !key) {
    return { posted: false, detail: "LEDGER_INGEST_URL/LEDGER_INGEST_KEY not configured — artifact-only write" };
  }
  const base = url.replace(/\/$/, "");
  const body: WardenLedgerIngestBody = {
    sourceKind: "warden-sweep",
    events: report.findings,
  };
  try {
    const res = await fetchImpl(`${base}/api/onboarding-ledger/ingest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { posted: false, httpStatus: res.status, detail: `ledger ingest HTTP ${res.status}` };
    }
    return { posted: true, httpStatus: res.status };
  } catch (err) {
    return { posted: false, detail: `ledger ingest unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}
