import { describe, expect, it } from "vitest";
import { computePartitionCalibration } from "../compute";
import { MIN_DENSE_SIGNAL } from "../constants";
import type { CalibrationSignal } from "../types";

function signal(
  overrides: Partial<CalibrationSignal> & { observedSuccess: number },
): CalibrationSignal {
  return {
    atomId: "reasoning:fbc-2023:fbc-m601-6",
    jurisdictionTenant: "bastrop_tx",
    partitionKind: "tenant-private",
    accessPolicy: "tenant-private",
    sharedWithTenants: null,
    atomClass: "M-6xx",
    stamp: { codeRef: "FBC-M601.6", edition: "FBC 2023", sourceSetVersion: 1 },
    statedConfidence: 0.9,
    ...overrides,
  };
}

describe("computePartitionCalibration", () => {
  it("returns null calibrated when no signal (cold-start prior)", () => {
    const result = computePartitionCalibration([], []);
    expect(result.calibratedConfidence).toBeNull();
    expect(result.calibrationGrain).toBe("class");
  });

  it("uses atom grain when signal is dense", () => {
    const atomSignals = Array.from({ length: MIN_DENSE_SIGNAL }, (_, i) =>
      signal({ observedSuccess: i % 2 === 0 ? 1 : 0 }),
    );
    const result = computePartitionCalibration(atomSignals, atomSignals);
    expect(result.calibrationGrain).toBe("atom");
    expect(result.calibratedConfidence).not.toBeNull();
  });

  it("falls back to class grain when atom signal is sparse", () => {
    const atomSignals = [signal({ observedSuccess: 1 })];
    const classSignals = Array.from({ length: MIN_DENSE_SIGNAL }, () =>
      signal({ observedSuccess: 1 }),
    );
    const result = computePartitionCalibration(atomSignals, classSignals);
    expect(result.calibrationGrain).toBe("class");
    expect(result.calibratedConfidence).not.toBeNull();
  });
});
