/**
 * COMPLETE-BASTROP B1 — spine source+engine health probe types (S-03).
 */

export type ProbeKind = "source" | "engine";

export type ProbeStatus =
  | "firing"
  | "degraded"
  | "degraded-covered"
  | "dead"
  | "dead-expected";

export interface ProbeResult {
  probeId: string;
  kind: ProbeKind;
  pack: string;
  status: ProbeStatus;
  alert: boolean;
  signal: Record<string, unknown>;
  baselineValue: number | null;
  currentValue: number | null;
  error: string | null;
  lastSuccessAt: string | null;
  probedAt: string;
}

export interface SpineHealthSummary {
  pack: string;
  probedAt: string;
  alertCount: number;
  probes: ProbeResult[];
}

export interface DeriveStatusInput {
  /** Adapter/source known dead; status is dead-expected, never alert. */
  expectedDead?: boolean;
  /** Probe threw or upstream returned an error envelope. */
  errored?: boolean;
  /**
   * QA4: upstream errored BUT a named fallback still covers the bbox
   * (e.g. osm-overpass 504 while county-roadway fires). Status is
   * degraded-covered with alert=false — not a bare red outage.
   */
  fallbackCovered?: boolean;
  /** Historical baseline (>0 means zero/error must alert). */
  baseline: number | null;
  /** Observed numeric signal (feature count, row count, key count, …). */
  current: number | null;
  /**
   * Fraction of baseline below which status is degraded (default 0.8).
   * current < baseline * degradeFraction → degraded + alert.
   */
  degradeFraction?: number;
}
