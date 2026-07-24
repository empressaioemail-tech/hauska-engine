/**
 * City of San Marcos Building Permits — ArcGIS FeatureServer (keyless bulk).
 * https://smgis.sanmarcostx.gov/arcgis/rest/services/Planning/CoSM_BuildingPermits/FeatureServer/0
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

export const SAN_MARCOS_ARCGIS_LAYER =
  "https://smgis.sanmarcostx.gov/arcgis/rest/services/Planning/CoSM_BuildingPermits/FeatureServer/0/query";
export const SAN_MARCOS_SOURCE_ID = "san-marcos-arcgis" as const;
export const SAN_MARCOS_JURISDICTION = "san_marcos_tx" as const;

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

export function normalizeSanMarcosFeature(
  feature: { attributes?: Record<string, unknown> },
): NormalizedPermitOutcome | null {
  const attrs = feature.attributes ?? {};
  const permitNumber =
    pickString(attrs, "PERMITID") ??
    pickString(attrs, "PROJECTNUMBER") ??
    pickString(attrs, "OBJECTID");
  if (!permitNumber) return null;
  const statusCurrent = pickString(attrs, "STATUS") ?? "";
  const outcomeKind = mapStatusToOutcomeKind(statusCurrent);
  if (!outcomeKind) return null;
  const observedAt =
    epochMsToIso(attrs.ISSUED) ??
    epochMsToIso(attrs.APPLIED) ??
    new Date().toISOString();
  return buildNormalizedOutcome({
    outcomeKind,
    observedAt,
    jurisdictionTenant: SAN_MARCOS_JURISDICTION,
    sourceId: SAN_MARCOS_SOURCE_ID,
    permitNumber,
    statusCurrent,
    address: pickString(attrs, "ADDRESS"),
    parcelHint: null,
    sourceUrl: SAN_MARCOS_ARCGIS_LAYER,
    notes: pickString(attrs, "TYPE"),
    sourceDataset: "CoSM_BuildingPermits/FeatureServer/0",
  });
}

export async function fetchSanMarcosPermitOutcomes(
  options?: PermitOutcomeFetchOptions,
): Promise<PermitOutcomeFetchResult> {
  const limit = options?.limit ?? 100;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const url = new URL(SAN_MARCOS_ARCGIS_LAYER);
  url.searchParams.set("where", "1=1");
  url.searchParams.set("outFields", "*");
  url.searchParams.set("f", "json");
  url.searchParams.set("resultRecordCount", String(limit));
  const res = await fetchImpl(url.toString(), { signal: options?.signal });
  const fetchedAt = new Date().toISOString();
  if (!res.ok) {
    return {
      sourceId: SAN_MARCOS_SOURCE_ID,
      jurisdictionTenant: SAN_MARCOS_JURISDICTION,
      outcomes: [],
      partialReason: `HTTP ${res.status}`,
      httpStatus: res.status,
      fetchedAt,
    };
  }
  const body = (await res.json()) as { features?: Array<{ attributes?: Record<string, unknown> }> };
  const outcomes = (body.features ?? [])
    .map((f) => normalizeSanMarcosFeature(f))
    .filter((x): x is NormalizedPermitOutcome => Boolean(x));
  return {
    sourceId: SAN_MARCOS_SOURCE_ID,
    jurisdictionTenant: SAN_MARCOS_JURISDICTION,
    outcomes,
    partialReason: null,
    httpStatus: res.status,
    fetchedAt,
  };
}
