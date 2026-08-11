/**
 * SYMNUM and GIS_SYMBOL_DESCRIPTION → wellStatus / wellType mapping per Texas RRC
 * Digital Map Information (Appendix A, O&G well symbology).
 *
 * The Harris County mirror carries SYMNUM only. The statewide RRC Public Viewer
 * layer (MapServer/1) also carries GIS_SYMBOL_DESCRIPTION and GIS_LOCATION_SOURCE
 * as authoritative text — prefer description when present.
 */

import type { WellStatus, WellType } from "@empressaio/atom-contract/property";

export type MappedWellStatus = WellStatus | "unknown";

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

function normalizeSymbolDescription(desc: string): string {
  return desc.trim().toLowerCase().replace(/\s+/g, " ");
}

export function mapSymbolDescriptionToWellStatus(
  symbolDescription: string | null | undefined,
): MappedWellStatus {
  const norm = normalizeSymbolDescription(String(symbolDescription ?? ""));
  if (!norm) return "unknown";
  if (norm.includes("dry hole")) return "dry";
  if (norm.includes("permitted")) return "permitted";
  if (norm.includes("plugged")) return "plugged-abandoned";
  if (
    norm === "oil well" ||
    norm === "gas well" ||
    norm.startsWith("oil /") ||
    norm.startsWith("gas /") ||
    norm.includes("active oil") ||
    norm.includes("active gas")
  ) {
    return "producing";
  }
  return "unknown";
}

export function mapSymnumToWellStatus(symnum: number): MappedWellStatus {
  if (PLUGGED_SYMNUMS.has(symnum)) return "plugged-abandoned";
  if (DRY_SYMNUMS.has(symnum)) return "dry";
  if (PERMITTED_SYMNUMS.has(symnum)) return "permitted";
  if (OIL_SYMNUMS.has(symnum) || GAS_SYMNUMS.has(symnum)) return "producing";
  return "unknown";
}

export function resolveWellStatus(
  symnum: number,
  symbolDescription: string | null | undefined,
): MappedWellStatus {
  const desc = String(symbolDescription ?? "").trim();
  if (desc) return mapSymbolDescriptionToWellStatus(desc);
  return mapSymnumToWellStatus(symnum);
}

/** Atom contract lacks `unknown`; Phase 3 writer reads tx_rrc_well.well_status. */
export function toContractWellStatus(status: MappedWellStatus): WellStatus {
  if (status === "unknown") return "permitted";
  return status;
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