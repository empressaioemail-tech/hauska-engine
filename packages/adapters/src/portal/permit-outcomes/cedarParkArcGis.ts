/**
 * City of Cedar Park MPN_Permits — ArcGIS MapServer (keyless bulk).
 * https://gisrest.cedarparktexas.gov/cpgis/rest/services/Planning/MPN_Permits/MapServer/0
 */

import {
  buildNormalizedOutcome,
  mapStatusToOutcomeKind,
} from "./normalize";
import type {
  NormalizedPermitOutcome,
  PermitOutcomeFetchOptions,
  PermitOutcomeFetchResult,
} from "./types";

export const CEDAR_PARK_ARCGIS_LAYER =
  "https://gisrest.cedarparktexas.gov/cpgis/rest/services/Planning/MPN_Permits/MapServer/0/query";
export const CEDAR_PARK_SOURCE_ID = "cedar-park-arcgis" as const;
export const CEDAR_PARK_JURISDICTION = "cedar_park_tx" as const;

function pickString(attrs: Record<string, unknown>, key: string): string | null {
  const v = attrs[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

export function normalizeCedarParkFeature(
  feature: { attributes?: Record<string, unknown> },
): NormalizedPermitOutcome | null {
  const attrs = feature.attributes ?? {};
  const permitNumber =
    pickString(attrs, "PermitID") ??
    pickString(attrs, "ProjectNumber") ??
    pickString(attrs, "OBJECTID");
  if (!permitNumber) return null;
  const statusCurrent = pickString(attrs, "ProjectStatus") ?? "";
  const outcomeKind = mapStatusToOutcomeKind(statusCurrent);
  if (!outcomeKind) return null;
  return buildNormalizedOutcome({
    outcomeKind,
    observedAt: new Date().toISOString(),
    jurisdictionTenant: CEDAR_PARK_JURISDICTION,
    sourceId: CEDAR_PARK_SOURCE_ID,
    permitNumber,
    statusCurrent,
    address: pickString(attrs, "Address"),
    parcelHint: null,
    sourceUrl: CEDAR_PARK_ARCGIS_LAYER,
    notes: pickString(attrs, "ProjectDescription"),
    sourceDataset: "MPN_Permits/MapServer/0",
  });
}

export async function fetchCedarParkPermitOutcomes(
  options?: PermitOutcomeFetchOptions,
): Promise<PermitOutcomeFetchResult> {
  const limit = options?.limit ?? 100;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const url = new URL(CEDAR_PARK_ARCGIS_LAYER);
  url.searchParams.set("where", "1=1");
  url.searchParams.set("outFields", "*");
  url.searchParams.set("f", "json");
  url.searchParams.set("resultRecordCount", String(limit));
  const res = await fetchImpl(url.toString(), { signal: options?.signal });
  const fetchedAt = new Date().toISOString();
  if (!res.ok) {
    return {
      sourceId: CEDAR_PARK_SOURCE_ID,
      jurisdictionTenant: CEDAR_PARK_JURISDICTION,
      outcomes: [],
      partialReason: `HTTP ${res.status}`,
      httpStatus: res.status,
      fetchedAt,
    };
  }
  const body = (await res.json()) as { features?: Array<{ attributes?: Record<string, unknown> }> };
  const outcomes = (body.features ?? [])
    .map((f) => normalizeCedarParkFeature(f))
    .filter((x): x is NormalizedPermitOutcome => Boolean(x));
  return {
    sourceId: CEDAR_PARK_SOURCE_ID,
    jurisdictionTenant: CEDAR_PARK_JURISDICTION,
    outcomes,
    partialReason: null,
    httpStatus: res.status,
    fetchedAt,
  };
}
