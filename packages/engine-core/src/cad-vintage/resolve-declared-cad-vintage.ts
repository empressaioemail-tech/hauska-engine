/**
 * Declared CAD vintage resolver — engine mirror of
 * `@workspace/cad-ingest` `vintage.ts` (L17 / P-25).
 *
 * Engine cannot import `@workspace/cad-ingest`. Keep this map in lockstep
 * with lib/cad-ingest/src/vintage.ts DECLARED_CAD_VINTAGES; parity test
 * freezes the fixture at packages/engine-core/src/cad-vintage/declared-fixture.json.
 *
 * Greppable: resolveDeclaredCadVintage
 */

export type CadSourceTier = "cad-export" | "stratmap-roll";

export const VINTAGE_GAP_ABSENCE_BASIS = "vintage-gap" as const;

export interface DeclaredCadVintage {
  countyFips: string;
  taxYear: number;
  tier: CadSourceTier;
}

/** Store-truth seed mirrored from LDT / doc_repo registry (2026-08-13). */
export const DECLARED_CAD_VINTAGES: Readonly<
  Record<string, Readonly<{ taxYear: number; tier: CadSourceTier }>>
> = Object.freeze({
  "48021": { taxYear: 2025, tier: "cad-export" },
  "48027": { taxYear: 2025, tier: "stratmap-roll" },
  "48029": { taxYear: 2025, tier: "stratmap-roll" },
  "48055": { taxYear: 2026, tier: "cad-export" },
  "48085": { taxYear: 2025, tier: "stratmap-roll" },
  "48091": { taxYear: 2025, tier: "stratmap-roll" },
  "48113": { taxYear: 2025, tier: "stratmap-roll" },
  "48121": { taxYear: 2025, tier: "stratmap-roll" },
  "48187": { taxYear: 2025, tier: "stratmap-roll" },
  "48209": { taxYear: 2026, tier: "cad-export" },
  "48257": { taxYear: 2025, tier: "stratmap-roll" },
  "48309": { taxYear: 2025, tier: "stratmap-roll" },
  "48439": { taxYear: 2025, tier: "stratmap-roll" },
  "48453": { taxYear: 2026, tier: "cad-export" },
  "48491": { taxYear: 2026, tier: "cad-export" },
});

export function tryResolveDeclaredCadVintage(
  countyFips: string,
): DeclaredCadVintage | null {
  const fips = countyFips.trim();
  if (!/^\d{5}$/.test(fips)) {
    throw new Error(
      `cad vintage FAIL CLOSED: countyFips must be 5 digits, got "${countyFips}"`,
    );
  }
  const row = DECLARED_CAD_VINTAGES[fips];
  if (!row) return null;
  return { countyFips: fips, taxYear: row.taxYear, tier: row.tier };
}

export function resolveDeclaredCadVintage(countyFips: string): DeclaredCadVintage {
  const resolved = tryResolveDeclaredCadVintage(countyFips);
  if (!resolved) {
    throw new Error(
      `cad vintage FAIL CLOSED: no declared current_tax_year/current_tier for county ${countyFips.trim()}`,
    );
  }
  return resolved;
}

export function classifyCadPropertyMiss(opts: {
  declaredYearHit: boolean;
  otherVintageHit: boolean;
}): "hit" | typeof VINTAGE_GAP_ABSENCE_BASIS | "not-found" {
  if (opts.declaredYearHit) return "hit";
  if (opts.otherVintageHit) return VINTAGE_GAP_ABSENCE_BASIS;
  return "not-found";
}
