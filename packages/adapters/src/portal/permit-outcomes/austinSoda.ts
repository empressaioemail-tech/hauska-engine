/**
 * Austin Open Data / SODA Issued Construction Permits (3syk-w9eu).
 *
 * Public SODA JSON — no API key required. Preferred Texas public-record
 * feed for Master WDLL 3.10 (acquisition wave-2 canary used the same
 * resource).
 *
 * Resource: https://data.austintexas.gov/resource/3syk-w9eu.json
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

export const AUSTIN_SODA_DATASET = "3syk-w9eu";
export const AUSTIN_SODA_BASE =
  "https://data.austintexas.gov/resource/3syk-w9eu.json";
export const AUSTIN_SODA_SOURCE_ID = "austin-soda" as const;
export const AUSTIN_SODA_JURISDICTION = "austin_tx" as const;

function pickString(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function pickLinkUrl(row: Record<string, unknown>): string | null {
  const link = row.link;
  if (link && typeof link === "object" && link !== null) {
    const url = (link as { url?: unknown }).url;
    if (typeof url === "string" && url.trim()) return url.trim();
  }
  return null;
}

function toIsoObservedAt(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  // SODA returns `2026-07-22T00:00:00.000`
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function normalizeAustinSodaRow(
  row: Record<string, unknown>,
): NormalizedPermitOutcome | null {
  const permitNumber = pickString(row, "permit_number");
  if (!permitNumber) return null;
  const statusCurrent =
    pickString(row, "status_current") ?? pickString(row, "status") ?? "";
  const outcomeKind = mapStatusToOutcomeKind(statusCurrent);
  if (!outcomeKind) return null;

  const observedAt =
    toIsoObservedAt(pickString(row, "issue_date")) ??
    toIsoObservedAt(pickString(row, "statusdate")) ??
    toIsoObservedAt(pickString(row, "applieddate"));
  if (!observedAt) return null;

  const address =
    pickString(row, "original_address1") ??
    pickString(row, "permit_location");

  return buildNormalizedOutcome({
    outcomeKind,
    observedAt,
    jurisdictionTenant: AUSTIN_SODA_JURISDICTION,
    sourceId: AUSTIN_SODA_SOURCE_ID,
    permitNumber,
    statusCurrent,
    address,
    parcelHint: pickString(row, "tcad_id"),
    sourceUrl: pickLinkUrl(row),
    notes: [
      pickString(row, "permit_type_desc"),
      pickString(row, "work_class"),
      pickString(row, "description")?.slice(0, 240),
    ]
      .filter(Boolean)
      .join(" | "),
    sourceDataset: AUSTIN_SODA_DATASET,
  });
}

/**
 * Fetch recent issued construction permits from Austin SODA (public).
 */
export async function fetchAustinSodaPermitOutcomes(
  options: PermitOutcomeFetchOptions = {},
): Promise<PermitOutcomeFetchResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 25, 500));
  const fetchImpl = options.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    $limit: String(limit),
    $order: "issue_date DESC",
  });
  const url = `${AUSTIN_SODA_BASE}?${params.toString()}`;
  const fetchedAt = new Date().toISOString();

  const res = await fetchImpl(url, {
    signal: options.signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    return {
      sourceId: AUSTIN_SODA_SOURCE_ID,
      jurisdictionTenant: AUSTIN_SODA_JURISDICTION,
      outcomes: [],
      partialReason: `Austin SODA HTTP ${res.status}`,
      httpStatus: res.status,
      fetchedAt,
    };
  }

  const body: unknown = await res.json();
  if (!Array.isArray(body)) {
    return {
      sourceId: AUSTIN_SODA_SOURCE_ID,
      jurisdictionTenant: AUSTIN_SODA_JURISDICTION,
      outcomes: [],
      partialReason: "Austin SODA response was not a JSON array",
      httpStatus: res.status,
      fetchedAt,
    };
  }

  const outcomes: NormalizedPermitOutcome[] = [];
  for (const row of body) {
    if (!row || typeof row !== "object") continue;
    const normalized = normalizeAustinSodaRow(row as Record<string, unknown>);
    if (normalized) outcomes.push(normalized);
  }

  return {
    sourceId: AUSTIN_SODA_SOURCE_ID,
    jurisdictionTenant: AUSTIN_SODA_JURISDICTION,
    outcomes,
    partialReason: null,
    httpStatus: res.status,
    fetchedAt,
  };
}
