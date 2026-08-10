/**
 * SYMNUM → wellStatus / wellType mapping per Texas RRC Digital Map
 * Information (Appendix A, O&G well symbology). Public GIS carries SYMNUM
 * only — not operator or regulatory status text.
 */

import type { WellStatus, WellType } from "@empressaio/atom-contract/property";

const PLUGGED_SYMNUMS = new Set([
  7, 8, 10, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128,
  129, 130, 131, 132, 133, 134, 135, 136, 137,
]);

const PERMITTED_SYMNUMS = new Set([2, 13, 87]);

const DRY_SYMNUMS = new Set([3]);

const INJECTION_SYMNUMS = new Set([
  11, 21, 22, 23, 104, 105, 106, 107, 125, 126, 127, 128,
]);

const DISPOSAL_SYMNUMS = new Set([11, 104]);

const OIL_SYMNUMS = new Set([
  4, 7, 10, 17, 19, 21, 75, 77, 90, 92, 103, 105, 107, 117, 119,
]);

const GAS_SYMNUMS = new Set([
  5, 8, 10, 18, 20, 22, 77, 91, 92, 103, 106, 107, 118, 119,
]);

export function mapSymnumToWellStatus(symnum: number): WellStatus {
  if (PLUGGED_SYMNUMS.has(symnum)) return "plugged-abandoned";
  if (DRY_SYMNUMS.has(symnum)) return "dry";
  if (PERMITTED_SYMNUMS.has(symnum)) return "permitted";
  return "producing";
}

export function mapSymnumToWellType(symnum: number): WellType {
  if (DISPOSAL_SYMNUMS.has(symnum) && INJECTION_SYMNUMS.has(symnum)) {
    return "disposal";
  }
  if (INJECTION_SYMNUMS.has(symnum)) return "injection";
  if (GAS_SYMNUMS.has(symnum) && !OIL_SYMNUMS.has(symnum)) return "gas";
  if (OIL_SYMNUMS.has(symnum) && !GAS_SYMNUMS.has(symnum)) return "oil";
  if (OIL_SYMNUMS.has(symnum) && GAS_SYMNUMS.has(symnum)) return "oil";
  return "oil";
}

/** RRC public GIS lacks operator-of-record; orphaned is never inferred here. */
export function deriveOrphanedFlag(_symnum: number, status: WellStatus): boolean {
  return status === "plugged-abandoned";
}

export function buildApiNumber14(apiField: string | null | undefined): string {
  const digits = String(apiField ?? "")
    .replace(/\D/g, "")
    .padStart(8, "0");
  const core = `42${digits}`;
  return core.padEnd(14, "0").slice(0, 14);
}
