/**
 * Pure status derivation for spine health probes (M0 / WDLL item 7).
 *
 * Rules (COMPLETE-BASTROP B1 + QA4):
 *   expectedDead → dead-expected, no alert
 *   errored + fallbackCovered → degraded-covered, no alert (QA4)
 *   errored OR current===0 with baseline>0 → dead + alert
 *   current below degrade fraction of baseline → degraded + alert
 *   else → firing
 */

import type { DeriveStatusInput, ProbeStatus } from "./types.js";

export const DEFAULT_DEGRADE_FRACTION = 0.8;

export function deriveProbeStatus(input: DeriveStatusInput): {
  status: ProbeStatus;
  alert: boolean;
} {
  if (input.expectedDead) {
    return { status: "dead-expected", alert: false };
  }

  // QA4: overpass (or similar) down but named fallback covers — not a red alarm.
  if (input.errored && input.fallbackCovered) {
    return { status: "degraded-covered", alert: false };
  }

  const baseline =
    input.baseline != null && Number.isFinite(input.baseline)
      ? Number(input.baseline)
      : 0;
  const current =
    input.current != null && Number.isFinite(input.current)
      ? Number(input.current)
      : null;
  const degradeFraction =
    input.degradeFraction != null && Number.isFinite(input.degradeFraction)
      ? Number(input.degradeFraction)
      : DEFAULT_DEGRADE_FRACTION;

  if (input.errored || current === null || current === 0) {
    if (baseline > 0) {
      return { status: "dead", alert: true };
    }
    return { status: "dead", alert: false };
  }

  if (baseline > 0 && current < baseline * degradeFraction) {
    return { status: "degraded", alert: true };
  }

  return { status: "firing", alert: false };
}
