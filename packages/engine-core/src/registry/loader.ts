/**
 * Registry-as-engine-input loader (Phase A / A4).
 *
 * Reads a jurisdiction's frozen registry row by FIPS code. Additive only —
 * does not replace the hardcoded per-county adapters (e.g.
 * packages/adapters/src/local/setbacks/bastrop-per-parcel-record.ts). Frozen
 * registry data lives under ./data as committed JSON, one file per onboarded
 * county, so the loader is deterministic: same FIPS -> same row, no network
 * or live-DB access.
 */

import type { JurisdictionRegistryRow } from "./types.js";

import bastrop48021 from "./data/bastrop-48021.json" with { type: "json" };

/** Frozen registry rows, keyed by FIPS code. Add new counties here as onboarded. */
const REGISTRY_ROWS_BY_FIPS: Readonly<Record<string, JurisdictionRegistryRow>> = {
  "48021": bastrop48021 as JurisdictionRegistryRow,
};

export class RegistryRowNotFoundError extends Error {
  constructor(public readonly fips: string) {
    super(`No frozen jurisdiction registry row for FIPS "${fips}".`);
    this.name = "RegistryRowNotFoundError";
  }
}

/** Load a jurisdiction registry row by FIPS code. Returns null when not onboarded. */
export function loadRegistryRowByFips(
  fips: string,
): JurisdictionRegistryRow | null {
  return REGISTRY_ROWS_BY_FIPS[fips] ?? null;
}

/** Load a jurisdiction registry row by FIPS code, throwing when not onboarded. */
export function requireRegistryRowByFips(
  fips: string,
): JurisdictionRegistryRow {
  const row = loadRegistryRowByFips(fips);
  if (!row) throw new RegistryRowNotFoundError(fips);
  return row;
}

/** All onboarded FIPS codes in the frozen registry. */
export function listRegistryFipsCodes(): string[] {
  return Object.keys(REGISTRY_ROWS_BY_FIPS);
}
