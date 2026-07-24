/**
 * City of New Braunfels PermitSearch — ArcGIS MapServer (keyless bulk).
 * https://gismaps.newbraunfels.gov/arcserverwa22/rest/services/MapServices/PermitSearch/MapServer/0
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

export const NEW_BRAUNFELS_ARCGIS_LAYER =
  "https://gismaps.newbraunfels.gov/arcserverwa22/rest/services/MapServices/PermitSearch/MapServer/0/query";
export const NEW_BRAUNFELS_SOURCE_ID = "new-braunfels-arcgis" as const;
export const NEW_BRAUNFELS_JURISDICTION = "new_braunfels_tx" as const;

function pickString(attrs: Record<string, unknown>, key: string): string | null {
  const v = attrs[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function epochMsToIso(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function normalizeNewBraunfelsFeature(
  feature: { attributes?: Record<string, unknown> },
): NormalizedPermitOutcome | null {
  const attrs = feature.attributes ?? {};
  const permitNumber =
    pickString(attrs, "CoNB_Permit_Number") ??
    pickString(attrs, "OBJECTID");
  if (!permitNumber) return null;
  const statusCurrent = pickString(attrs, "Permit_Status") ?? "";
  const outcomeKind = mapStatusToOutcomeKind(statusCurrent);
  if (!outcomeKind) return null;
  const observedAt =
    epochMsToIso(attrs.Permit_Issue_Date) ??
    epochMsToIso(attrs.Permit_Status_Date) ??
    new Date().toISOString();
  return buildNormalizedOutcome({
    outcomeKind,
    observedAt,
    jurisdictionTenant: NEW_BRAUNFELS_JURISDICTION,
    sourceId: NEW_BRAUNFELS_SOURCE_ID,
    permitNumber,
    statusCurrent,
    address: pickString(attrs, "Permit_Address"),
    parcelHint: null,
    sourceUrl: NEW_BRAUNFELS_ARCGIS_LAYER,
    notes: null,
    sourceDataset: "PermitSearch/MapServer/0",
  });
}

export async function fetchNewBraunfelsPermitOutcomes(
  options?: PermitOutcomeFetchOptions,
): Promise<PermitOutcomeFetchResult> {
  const limit = options?.limit ?? 100;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const url = new URL(NEW_BRAUNFELS_ARCGIS_LAYER);
  url.searchParams.set("where", "1=1");
  url.searchParams.set("outFields", "*");
  url.searchParams.set("f", "json");
  url.searchParams.set("resultRecordCount", String(limit));
  const res = await fetchImpl(url.toString(), { signal: options?.signal });
  const fetchedAt = new Date().toISOString();
  if (!res.ok) {
    return {
      sourceId: NEW_BRAUNFELS_SOURCE_ID,
      jurisdictionTenant: NEW_BRAUNFELS_JURISDICTION,
      outcomes: [],
      partialReason: `HTTP ${res.status}`,
      httpStatus: res.status,
      fetchedAt,
    };
  }
  const body = (await res.json()) as { features?: Array<{ attributes?: Record<string, unknown> }> };
  const outcomes = (body.features ?? [])
    .map((f) => normalizeNewBraunfelsFeature(f))
    .filter((x): x is NormalizedPermitOutcome => Boolean(x));
  return {
    sourceId: NEW_BRAUNFELS_SOURCE_ID,
    jurisdictionTenant: NEW_BRAUNFELS_JURISDICTION,
    outcomes,
    partialReason: null,
    httpStatus: res.status,
    fetchedAt,
  };
}
