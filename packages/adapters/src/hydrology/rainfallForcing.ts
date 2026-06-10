/**
 * Rainfall forcing sources — Phase 2D.3.
 *
 * v1: NOAA Atlas 14 PFDS + manual depth override.
 * Pluggable hook for Cotality `cotality:hazards` flood-depth-at-return-
 * period fields (77b §2) — inert until the Cotality token clears.
 */

import {
  fetchNoaaAtlas14PointEstimate,
  inchesToMm,
  type NoaaAtlas14PointEstimate,
} from "./noaaAtlas14";

/** Shape of Cotality hazards flood depth fields (not wired live). */
export interface CotalityFloodDepthForcing {
  source: "cotality:hazards";
  estimatedFloodDepth50yr?: number;
  estimatedFloodDepth100yr?: number;
  estimatedFloodDepth500yr?: number;
  waterSurfaceElevation?: number;
  groundElevation?: number;
}

export type RainfallForcingSource =
  | { kind: "manual"; depthInches: number; label: string }
  | {
      kind: "noaa-atlas-14";
      estimate: NoaaAtlas14PointEstimate;
      returnPeriodYears: number;
      depthInches: number;
    }
  | {
      kind: "cotality-hazards";
      cotality: CotalityFloodDepthForcing;
      returnPeriodYears: number;
      depthInches: number;
    };

export interface ResolveRainfallForcingInput {
  lat: number;
  lng: number;
  /** Manual override in inches (e.g. 4). Takes precedence when set. */
  manualDepthInches?: number;
  /** Design-storm return period when not manual. */
  returnPeriodYears?: number;
  /** Optional Cotality overlay — used when `useCotalityForcing` is true. */
  cotalityForcing?: CotalityFloodDepthForcing | null;
  useCotalityForcing?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Resolve rainfall depth forcing. Manual override wins; Cotality hook is
 * checked when `useCotalityForcing` is true (default false — inert v1).
 */
export async function resolveRainfallForcing(
  input: ResolveRainfallForcingInput,
): Promise<RainfallForcingSource> {
  if (
    typeof input.manualDepthInches === "number" &&
    Number.isFinite(input.manualDepthInches) &&
    input.manualDepthInches > 0
  ) {
    return {
      kind: "manual",
      depthInches: input.manualDepthInches,
      label: `${input.manualDepthInches} in (manual)`,
    };
  }

  const rp = input.returnPeriodYears ?? 100;

  if (input.useCotalityForcing && input.cotalityForcing) {
    const depth = cotalityDepthForReturnPeriod(input.cotalityForcing, rp);
    if (depth !== null) {
      return {
        kind: "cotality-hazards",
        cotality: input.cotalityForcing,
        returnPeriodYears: rp,
        depthInches: depth,
      };
    }
  }

  const estimate = await fetchNoaaAtlas14PointEstimate({
    lat: input.lat,
    lng: input.lng,
    fetchImpl: input.fetchImpl,
  });
  const match =
    estimate.designStorms.find((d) => d.returnPeriodYears === rp) ??
    estimate.designStorms[0];
  const depthInches = match?.depthInches ?? 4;
  return {
    kind: "noaa-atlas-14",
    estimate,
    returnPeriodYears: match?.returnPeriodYears ?? rp,
    depthInches,
  };
}

/** Map Cotality flood-depth fields to a return period (feet → inches). */
export function cotalityDepthForReturnPeriod(
  cotality: CotalityFloodDepthForcing,
  returnPeriodYears: number,
): number | null {
  let depthFeet: number | undefined;
  if (returnPeriodYears <= 50) {
    depthFeet = cotality.estimatedFloodDepth50yr;
  } else if (returnPeriodYears <= 100) {
    depthFeet = cotality.estimatedFloodDepth100yr;
  } else {
    depthFeet = cotality.estimatedFloodDepth500yr;
  }
  if (typeof depthFeet !== "number" || !Number.isFinite(depthFeet)) {
    return null;
  }
  return depthFeet * 12;
}

export function rainfallForcingDepthMm(forcing: RainfallForcingSource): number {
  return inchesToMm(forcing.depthInches);
}
