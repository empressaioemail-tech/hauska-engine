/**
 * Onboarding-ledger report client, OPS-9 S1 wrapper support.
 *
 * Shared shaping + POST logic for the two thin report wrappers
 * (scripts/preflight-and-report.mjs, scripts/cert-grade-and-report.mjs).
 * This module owns ONLY the ledger-ingest contract shape and the HTTP call;
 * it never runs onboard-preflight.ts or block13-cert-grade.mjs logic itself
 *, the wrappers do that (by spawning the existing CLI scripts and parsing
 * their stdout JSON), then hand the parsed report to this module to build
 * and POST the ingest body.
 *
 * PINNED CONTRACT (identical in the legacy-design-tools route and this
 * client): POST {base}/api/onboarding-ledger/ingest,
 * Authorization: Bearer {key}, body per `LedgerIngestBody` below.
 *
 * Absent LEDGER_INGEST_URL / LEDGER_INGEST_KEY, callers should skip the
 * POST entirely (print-only, byte-identical to the pre-existing script
 * behavior), this module does not read env itself so that contract stays
 * the wrapper's responsibility and is trivially testable without env leakage.
 */

/** One row's registry-mirror snapshot, POSTed alongside events. */
export interface LedgerRowMirror {
  readonly rowId: string;
  readonly fips: string;
  readonly countyName: string;
  readonly status: string;
  readonly zoningRegime: string;
}

/** One ledger event, a decline, a quarantine finding, or a sweep finding. */
export interface LedgerEvent {
  readonly ts: string;
  readonly fips: string;
  readonly rowId: string;
  readonly parcelNodeId?: string;
  readonly railOrCheck?: string;
  readonly checkId?: string;
  readonly sweepId?: string;
  readonly declineReason?: string;
  readonly defectClass: string;
  readonly severity?: string;
  readonly evidence?: unknown;
  readonly artifactRef?: string;
}

/** Cert-grade summary, POSTed by cert-grade-and-report.mjs. */
export interface LedgerCertSummary {
  readonly rowId: string;
  readonly fips: string;
  readonly label: string;
  readonly blockPass: boolean;
  readonly scopeAnnotations?: unknown;
  readonly gradedAt: string;
}

/** Pre-flight gate summary, POSTed by preflight-and-report.mjs. */
export interface LedgerGateSummary {
  readonly rowId: string;
  readonly fips: string;
  readonly passCount: number;
  readonly declineCount: number;
  readonly checks: ReadonlyArray<{ id: string; outcome: string; reason?: string }>;
}

export type LedgerSourceKind = "preflight" | "cert-grade" | "block13-quarantine" | "warden-sweep";

/** The full POST body per the pinned contract. */
export interface LedgerIngestBody {
  readonly sourceKind: LedgerSourceKind;
  readonly rowMirror?: readonly LedgerRowMirror[];
  readonly events: readonly LedgerEvent[];
  readonly certSummary?: LedgerCertSummary;
  readonly gateSummary?: LedgerGateSummary;
}

/** Small, extendable fips→county-name map for roster-mirror payloads (Bastrop-network only today). */
export const FIPS_TO_COUNTY_NAME: Readonly<Record<string, string>> = {
  "48021": "Bastrop",
};

export function countyNameForFips(fips: string): string {
  return FIPS_TO_COUNTY_NAME[fips] ?? fips;
}

/** Resolves LEDGER_INGEST_URL / LEDGER_INGEST_KEY from env. Both must be present to POST. */
export function resolveLedgerIngestConfig(
  env: NodeJS.ProcessEnv = process.env,
): { url: string; key: string } | null {
  const url = env.LEDGER_INGEST_URL?.trim();
  const key = env.LEDGER_INGEST_KEY?.trim();
  if (!url || !key) return null;
  return { url, key };
}

/** Builds the contract-shaped POST body. Pure, no I/O, easy to unit test. */
export function buildLedgerIngestBody(input: {
  sourceKind: LedgerSourceKind;
  rowMirror?: readonly LedgerRowMirror[];
  events: readonly LedgerEvent[];
  certSummary?: LedgerCertSummary;
  gateSummary?: LedgerGateSummary;
}): LedgerIngestBody {
  const body: LedgerIngestBody = {
    sourceKind: input.sourceKind,
    events: input.events,
    ...(input.rowMirror && input.rowMirror.length > 0 ? { rowMirror: input.rowMirror } : {}),
    ...(input.certSummary ? { certSummary: input.certSummary } : {}),
    ...(input.gateSummary ? { gateSummary: input.gateSummary } : {}),
  };
  return body;
}

/**
 * POSTs a pre-built ingest body to the ledger endpoint. Callers gate this on
 * `resolveLedgerIngestConfig` returning non-null; absent config, this
 * function is simply never called (print-only path).
 */
export async function postLedgerIngest(
  config: { url: string; key: string },
  body: LedgerIngestBody,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; detail?: string }> {
  const endpoint = `${config.url.replace(/\/$/, "")}/api/onboarding-ledger/ingest`;
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.key}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, detail: text.slice(0, 500) };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
  }
}
