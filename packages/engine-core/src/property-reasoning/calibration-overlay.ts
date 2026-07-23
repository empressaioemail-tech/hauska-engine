import {
  createWidthedConfidence,
  type WidthedConfidence,
} from "@empressaio/atom-contract/read-contract";

import { buildAtomDid, isPropertyAtomInstance } from "@hauska-engine/atoms";
import type { PropertyAtomInstance, StoredAtomInstance } from "@hauska-engine/atoms";

/** Public-pool partition key — anonymous/public-tier signal only (0037). */
export const PUBLIC_CALIBRATION_TENANT = "__public__" as const;

const PROVENANCE_VALUES = ["asserted", "backtest", "seed", "live"] as const;
type OverlayProvenance = (typeof PROVENANCE_VALUES)[number];

/**
 * Read-through calibration overlay port (I-E).
 *
 * Cortex Neon migration 0037 `atom_calibration_overlay` keys rows on
 * `(atom_id, jurisdiction_tenant)`. Property atoms resolve at READ using
 * parcel node `{fips}:{propId}` (primary) and/or atom DID — never a
 * frozen labeling×district multiply at emit.
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
 * No overlay row → returns assertedBaseline (honest asserted-provenance placeholder).
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

/** Map 0037 numeric + signal_count (+ optional atom_class provenance) to WidthedConfidence. */
export function widthedFromOverlayScalars(args: {
  estimate: number;
  signalCount: number;
  /** When atom_class is a CalibrationProvenance value, use it; else seed/live heuristic. */
  atomClass?: string | null;
  intervalWidth?: number;
}): WidthedConfidence {
  const provenance: OverlayProvenance = PROVENANCE_VALUES.includes(
    args.atomClass as OverlayProvenance,
  )
    ? (args.atomClass as OverlayProvenance)
    : args.signalCount >= 1
      ? "live"
      : "seed";
  const width =
    args.intervalWidth ??
    (args.signalCount <= 0 ? 0.35 : args.signalCount >= 8 ? 0.12 : 0.2);
  return createWidthedConfidence({
    estimate: args.estimate,
    n: args.signalCount,
    intervalWidth: width,
    provenance,
  });
}

function propertyAtomDid(atom: PropertyAtomInstance): string {
  if (typeof atom.atomDid === "string" && atom.atomDid.startsWith("did:")) {
    return atom.atomDid;
  }
  return buildAtomDid(atom.entityType, atom.entityId).raw;
}

/**
 * Lookup order for property-atom overlay keys (parcel-node primary):
 * 1. parcelNodeId + jurisdictionTenant
 * 2. atomDid + jurisdictionTenant
 * 3. parcelNodeId + __public__
 * 4. atomDid + __public__
 */
export function propertyOverlayLookupKeys(atom: PropertyAtomInstance): ReadonlyArray<{
  atomId: string;
  jurisdictionTenant: string;
}> {
  const parcelNodeId = atom.parcelNodeId;
  const atomDid = propertyAtomDid(atom);
  const tenant = atom.jurisdictionTenant || PUBLIC_CALIBRATION_TENANT;
  const keys: Array<{ atomId: string; jurisdictionTenant: string }> = [
    { atomId: parcelNodeId, jurisdictionTenant: tenant },
    { atomId: atomDid, jurisdictionTenant: tenant },
  ];
  if (tenant !== PUBLIC_CALIBRATION_TENANT) {
    keys.push(
      { atomId: parcelNodeId, jurisdictionTenant: PUBLIC_CALIBRATION_TENANT },
      { atomId: atomDid, jurisdictionTenant: PUBLIC_CALIBRATION_TENANT },
    );
  }
  return keys;
}

/**
 * Apply migration-0037 overlay at READ onto a property atom's
 * `readContract.axes.calibratedConfidence`. Leaves asserted axis untouched.
 * No matching overlay row → atom unchanged (asserted-provenance placeholder stays).
 */
export async function applyPropertyCalibrationAtRead<T extends PropertyAtomInstance>(
  atom: T,
  overlayPort: CalibrationOverlayPort | null | undefined,
): Promise<T> {
  if (!overlayPort) return atom;
  const axes = atom.readContract?.axes;
  const asserted = axes?.assertedConfidence;
  if (!axes || !asserted) return atom;

  for (const key of propertyOverlayLookupKeys(atom)) {
    const row = await overlayPort.findCalibratedConfidence(
      key.atomId,
      key.jurisdictionTenant,
    );
    if (!row) continue;
    let calibrated: WidthedConfidence;
    if (row.calibrationStale) {
      calibrated = row.assertedFallback ?? asserted;
    } else if (row.calibratedConfidence != null) {
      calibrated = row.calibratedConfidence;
    } else {
      calibrated = row.assertedFallback ?? asserted;
    }
    return {
      ...atom,
      readContract: {
        ...atom.readContract,
        axes: {
          ...axes,
          calibratedConfidence: calibrated,
        },
      },
    };
  }
  return atom;
}

/** Apply overlay read-through when the stored instance is a property atom. */
export async function applyStoredAtomCalibrationAtRead(
  atom: StoredAtomInstance,
  overlayPort: CalibrationOverlayPort | null | undefined,
): Promise<StoredAtomInstance> {
  if (!overlayPort || !isPropertyAtomInstance(atom)) return atom;
  return applyPropertyCalibrationAtRead(atom, overlayPort);
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
