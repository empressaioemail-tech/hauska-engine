/**
 * Map Caldwell CAD Road_Centerlines attributes → v1 road classification
 * (RECIPE-PROOF county #2 / 48055).
 *
 * SCHEMA ≠ DATA (baked S2-F gate): SURFACE/CLASS fields exist; only promote
 * authoritative when SURFACE is a defined non-sentinel value. Empty / garbage
 * numeric sentinels / UNDEFINED → not authoritative (OSM best-available for city).
 */

import type { RoadClassification } from "@hauska-engine/atoms";

export interface CaldwellCadRoadAttributes {
  OBJECTID?: number | null;
  objectid?: number | null;
  ROADNAME?: string | null;
  ROADTYPE?: string | null;
  SURFACE?: string | null;
  CLASS?: string | null;
  ROADNO?: string | number | null;
  HWY_NUM?: string | number | null;
}

/** Synthetic way-id offset for Caldwell CAD centerlines (distinct from Bastrop 800M/900M). */
export const CALDWELL_CAD_ROAD_ID_OFFSET = 700_000_000;

export function caldwellCadSyntheticWayId(objectId: number): number {
  return CALDWELL_CAD_ROAD_ID_OFFSET + objectId;
}

export function isCaldwellCadSyntheticWayId(wayId: number): boolean {
  return wayId >= CALDWELL_CAD_ROAD_ID_OFFSET && wayId < 800_000_000;
}

function norm(value: string | number | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

/**
 * SURFACE is defined for authoritative promotion when non-empty and not a
 * known sentinel (Undefined, bare numeric junk like "0"/"59").
 */
export function isDefinedCaldwellSurface(surface: string | null | undefined): boolean {
  const s = norm(surface);
  if (!s || s === "undefined") return false;
  if (/^\d+$/.test(s)) return false;
  return true;
}

export function caldwellCadIsAuthoritative(attrs: CaldwellCadRoadAttributes): boolean {
  return isDefinedCaldwellSurface(attrs.SURFACE);
}

function surfaceIsGravel(surface: string): boolean {
  return (
    surface.includes("grvl") ||
    surface.includes("gravel") ||
    surface.includes("gravl") ||
    surface.includes("dirt") ||
    surface.includes("sand") ||
    surface.includes("rvl")
  );
}

function surfaceIsPaved(surface: string): boolean {
  return (
    surface.includes("pavd") ||
    surface.includes("paved") ||
    surface.includes("pval") ||
    surface.includes("conc") ||
    surface.includes("curb")
  );
}

/**
 * Classify Caldwell CAD CLASS + SURFACE into v1 RoadClassification.
 */
export function classifyCaldwellCadAttributes(
  attrs: CaldwellCadRoadAttributes,
): RoadClassification {
  const cls = norm(attrs.CLASS);
  const surface = norm(attrs.SURFACE);
  const roadType = norm(attrs.ROADTYPE);

  if (cls.includes("hwy") || roadType === "fm" || roadType === "hwy") {
    return "highway";
  }
  if (cls.includes("toll") || cls.includes("ramp")) {
    return "major_collector";
  }
  if (cls.includes("easement") || cls.includes("undeveloped") || cls.includes("cemetery")) {
    return "unclassified";
  }

  if (surfaceIsGravel(surface) || cls.includes("gravel") || cls.includes("dirt")) {
    return "gravel";
  }
  if (surfaceIsPaved(surface) || cls.includes("paved")) {
    if (cls.includes("private")) return "residential";
    if (cls.includes("county") || cls.includes("street") || cls.includes("public")) {
      return "residential";
    }
    return "residential";
  }

  if (cls.includes("private") || cls.includes("county") || cls.includes("street")) {
    return "unclassified";
  }

  return "unclassified";
}
