import type { AdapterContext } from "../types";

/**
 * PL-04 gate shared by nationwide federal site-context adapters. Applies
 * whenever the engagement has finite lat/lng — out-of-pilot parcels still
 * receive federal layers; state/local adapters may no-coverage separately.
 */
export function federalGeocodeApplies(ctx: AdapterContext): boolean {
  return (
    Number.isFinite(ctx.parcel.latitude) &&
    Number.isFinite(ctx.parcel.longitude)
  );
}

/** Rough CONUS bounding box for layers that only cover the lower 48. */
export function isConterminousUsLatLng(
  latitude: number,
  longitude: number,
): boolean {
  return (
    latitude >= 24.5 &&
    latitude <= 49.5 &&
    longitude >= -125 &&
    longitude <= -66.5
  );
}

/** Rough US + territories envelope for nationwide federal layers. */
export function isUsLatLng(latitude: number, longitude: number): boolean {
  return (
    latitude >= 17 &&
    latitude <= 72 &&
    longitude >= -180 &&
    longitude <= -65
  );
}
