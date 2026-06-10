import {
  CALIBRATION_PRIOR_WEIGHT,
  MIN_DENSE_SIGNAL,
} from "./constants";
import type { CalibrationSignal } from "./types";

export type AggregatedCalibration = {
  assertedConfidence: number;
  calibratedConfidence: number | null;
  signalCount: number;
  calibrationGrain: "atom" | "class";
};

function blendConfidence(
  asserted: number,
  observedRate: number,
  signalCount: number,
): number {
  const weight = CALIBRATION_PRIOR_WEIGHT + signalCount;
  return (
    (asserted * CALIBRATION_PRIOR_WEIGHT + observedRate * signalCount) / weight
  );
}

function observedRate(signals: CalibrationSignal[]): number | null {
  if (signals.length === 0) return null;
  const sum = signals.reduce((a, s) => a + s.observedSuccess, 0);
  return sum / signals.length;
}

function meanStated(signals: CalibrationSignal[]): number {
  if (signals.length === 0) return 0.65;
  return (
    signals.reduce((a, s) => a + s.statedConfidence, 0) / signals.length
  );
}

/**
 * Compute calibration for one partition bucket. Adaptive grain: per-atom when
 * dense, per-class within-partition when sparse. Never crosses partition.
 */
export function computePartitionCalibration(
  atomSignals: CalibrationSignal[],
  classSignals: CalibrationSignal[],
): AggregatedCalibration {
  const dense = atomSignals.length >= MIN_DENSE_SIGNAL;
  const signals = dense ? atomSignals : classSignals;
  const grain = dense ? ("atom" as const) : ("class" as const);
  const asserted = meanStated(signals.length > 0 ? signals : atomSignals);
  const rate = observedRate(signals);

  if (rate == null || signals.length === 0) {
    return {
      assertedConfidence: asserted,
      calibratedConfidence: null,
      signalCount: signals.length,
      calibrationGrain: grain,
    };
  }

  return {
    assertedConfidence: asserted,
    calibratedConfidence: blendConfidence(asserted, rate, signals.length),
    signalCount: signals.length,
    calibrationGrain: grain,
  };
}
