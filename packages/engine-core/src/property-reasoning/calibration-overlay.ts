import type { WidthedConfidence } from "@empressaio/atom-contract/read-contract";

/**
 * Read-through calibration overlay port (I-E).
 *
 * Cortex Neon migration 0037 `atom_calibration_overlay` keys rows on
 * `(atom_id, jurisdiction_tenant)`. Property atoms use parcel node
 * `{fips}:{propId}` as the stable overlay atom id namespace prefix.
 */
export interface CalibrationOverlayPort {
  findCalibratedConfidence(
    atomId: string,
    jurisdictionTenant: string,
  ): Promise<{
    calibratedConfidence: WidthedConfidence | null;
    calibrationStale: boolean;
    assertedFallback?: WidthedConfidence;
  } | null>;
}

export interface ResolveCalibratedConfidenceInput {
  atomId: string;
  jurisdictionTenant: string;
  assertedBaseline: WidthedConfidence;
  overlayPort: CalibrationOverlayPort;
}

/**
 * Resolve calibrated axis at read time — never compose-and-freeze at emit.
 */
export async function resolveCalibratedConfidence(
  input: ResolveCalibratedConfidenceInput,
): Promise<WidthedConfidence> {
  const row = await input.overlayPort.findCalibratedConfidence(
    input.atomId,
    input.jurisdictionTenant,
  );
  if (!row) return input.assertedBaseline;
  if (row.calibrationStale) {
    return row.assertedFallback ?? input.assertedBaseline;
  }
  if (row.calibratedConfidence != null) return row.calibratedConfidence;
  return row.assertedFallback ?? input.assertedBaseline;
}

/** In-memory overlay for tests — keyed `(atomId, jurisdictionTenant)`. */
export class InMemoryCalibrationOverlayPort implements CalibrationOverlayPort {
  private readonly rows = new Map<
    string,
    {
      calibratedConfidence: WidthedConfidence | null;
      calibrationStale: boolean;
      assertedFallback?: WidthedConfidence;
    }
  >();

  private key(atomId: string, jurisdictionTenant: string): string {
    return `${jurisdictionTenant}\0${atomId}`;
  }

  seed(
    atomId: string,
    jurisdictionTenant: string,
    value: {
      calibratedConfidence: WidthedConfidence | null;
      calibrationStale?: boolean;
      assertedFallback?: WidthedConfidence;
    },
  ): void {
    this.rows.set(this.key(atomId, jurisdictionTenant), {
      calibratedConfidence: value.calibratedConfidence,
      calibrationStale: value.calibrationStale ?? false,
      assertedFallback: value.assertedFallback,
    });
  }

  async findCalibratedConfidence(
    atomId: string,
    jurisdictionTenant: string,
  ): Promise<{
    calibratedConfidence: WidthedConfidence | null;
    calibrationStale: boolean;
    assertedFallback?: WidthedConfidence;
  } | null> {
    return this.rows.get(this.key(atomId, jurisdictionTenant)) ?? null;
  }
}
