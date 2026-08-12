/**
 * SYMNUM / GIS_SYMBOL_DESCRIPTION -> wellStatus / wellType mapping per Texas RRC
 * Digital Map Information (Appendix A, O&G well symbology).
 *
 * Statewide RRC Public Viewer carries GIS_SYMBOL_DESCRIPTION and
 * GIS_LOCATION_SOURCE; prefer description when present. Harris County mirror
 * layers may expose SYMNUM only.
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

function normalizeSymbolDescription(desc: string): string {
  return desc
    .trim()
    .toLowerCase()
    .replace(/[\/]+/g, "/")
    .replace(/\s+/g, " ")
    .replace(/\s*\/\s*/g, "/");
}

function descriptionIndicatesOil(norm: string): boolean {
  return (
    /\boil\b/.test(norm) ||
    norm.includes("oil/") ||
    norm.includes("/oil") ||
    norm.startsWith("oil ")
  );
}

function descriptionIndicatesGas(norm: string): boolean {
  return (
    /\bgas\b/.test(norm) ||
    norm.includes("gas/") ||
    norm.includes("/gas") ||
    norm.startsWith("gas ")
  );
}

/**
 * Map GIS_SYMBOL_DESCRIPTION text to WellStatus.
 * Conservative: only confident producing/plugged/dry/permitted labels;
 * injection/disposal/canceled/shut-in/service/etc. -> unknown.
 */
export function mapSymbolDescriptionToWellStatus(
  symbolDescription: string | null | undefined,
): WellStatus {
  const norm = normalizeSymbolDescription(String(symbolDescription ?? ""));
  if (!norm) return "unknown";

  if (norm.includes("plugged")) return "plugged-abandoned";
  if (norm.includes("dry hole") || norm === "dry") return "dry";
  if (norm.includes("permitted")) return "permitted";

  // Injection / disposal are not "producing" even when hydrocarbon-associated.
  if (
    norm.includes("injection") ||
    norm.includes("disposal") ||
    norm.includes("inject")
  ) {
    return "unknown";
  }

  // Explicit producing-class labels (incl. Oil/Gas Well slash variants).
  if (
    norm === "oil well" ||
    norm === "gas well" ||
    norm === "oil/gas well" ||
    norm === "gas/oil well" ||
    norm.includes("oil/gas well") ||
    norm.includes("gas/oil well") ||
    norm.includes("active oil") ||
    norm.includes("active gas")
  ) {
    return "producing";
  }

  // Residual Appendix A labels: canceled/abandoned location, core test,
  // water supply, observation, storage, service, shut-in, brine, geothermal,
  // horizontal drainhole, etc. -> unknown (never confident producing).
  return "unknown";
}

/**
 * Map GIS_SYMBOL_DESCRIPTION text to WellType.
 * Disposal-ish -> disposal; other injection -> injection; clear oil/gas -> oil|gas;
 * otherwise unknown unless oil/gas clearly indicated.
 */
export function mapSymbolDescriptionToWellType(
  symbolDescription: string | null | undefined,
): WellType {
  const norm = normalizeSymbolDescription(String(symbolDescription ?? ""));
  if (!norm) return "unknown";

  const hasDisposal = norm.includes("disposal");
  const hasInjection = norm.includes("injection") || norm.includes("inject");
  if (hasDisposal) return "disposal";
  if (hasInjection) return "injection";

  const oil = descriptionIndicatesOil(norm);
  const gas = descriptionIndicatesGas(norm);
  // Oil/Gas Well and similar dual labels: prefer oil (matches SYMNUM dual path).
  if (oil && gas) return "oil";
  if (gas) return "gas";
  if (oil) return "oil";

  return "unknown";
}

/**
 * SYMNUM-only status map. OIL∪GAS treated as producing only as fallback;
 * unmatched -> unknown. Never default producing.
 */
export function mapSymnumToWellStatus(symnum: number): WellStatus {
  if (PLUGGED_SYMNUMS.has(symnum)) return "plugged-abandoned";
  if (DRY_SYMNUMS.has(symnum)) return "dry";
  if (PERMITTED_SYMNUMS.has(symnum)) return "permitted";
  if (OIL_SYMNUMS.has(symnum) || GAS_SYMNUMS.has(symnum)) return "producing";
  return "unknown";
}

/**
 * SYMNUM-only type map. Unmatched -> unknown. Never default oil.
 */
export function mapSymnumToWellType(symnum: number): WellType {
  if (DISPOSAL_SYMNUMS.has(symnum) && INJECTION_SYMNUMS.has(symnum)) {
    return "disposal";
  }
  if (INJECTION_SYMNUMS.has(symnum)) return "injection";
  if (GAS_SYMNUMS.has(symnum) && !OIL_SYMNUMS.has(symnum)) return "gas";
  if (OIL_SYMNUMS.has(symnum) && !GAS_SYMNUMS.has(symnum)) return "oil";
  if (OIL_SYMNUMS.has(symnum) && GAS_SYMNUMS.has(symnum)) return "oil";
  return "unknown";
}

/** Prefer non-empty GIS_SYMBOL_DESCRIPTION; else SYMNUM maps. */
export function resolveWellStatus(
  symnum: number,
  symbolDescription?: string | null,
): WellStatus {
  const desc = String(symbolDescription ?? "").trim();
  if (desc) return mapSymbolDescriptionToWellStatus(desc);
  return mapSymnumToWellStatus(symnum);
}

/** Prefer non-empty GIS_SYMBOL_DESCRIPTION; else SYMNUM maps. */
export function resolveWellType(
  symnum: number,
  symbolDescription?: string | null,
): WellType {
  const desc = String(symbolDescription ?? "").trim();
  if (desc) return mapSymbolDescriptionToWellType(desc);
  return mapSymnumToWellType(symnum);
}

/** Orphaned only for plugged-abandoned; unknown never implies orphaned. */
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
