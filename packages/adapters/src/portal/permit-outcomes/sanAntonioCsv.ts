/**
 * City of San Antonio Open Data — building permits issued CSV (keyless bulk).
 * https://data.sanantonio.gov/dataset/building-permits
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

export const SAN_ANTONIO_PERMITS_CSV =
  "https://data.sanantonio.gov/dataset/05012dcb-ba1b-4ade-b5f3-7403bc7f52eb/resource/c21106f9-3ef5-4f3a-8604-f992b4db7512/download/permits_issued.csv";
export const SAN_ANTONIO_SOURCE_ID = "san-antonio-csv" as const;
export const SAN_ANTONIO_JURISDICTION = "san_antonio_tx" as const;

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function toIso(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  const d = new Date(raw.trim());
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function normalizeSanAntonioCsvRows(
  text: string,
  limit: number,
): NormalizedPermitOutcome[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const idx = (name: string) => headers.indexOf(name);
  const outcomes: NormalizedPermitOutcome[] = [];
  for (let i = 1; i < lines.length && outcomes.length < limit; i++) {
    const cols = parseCsvLine(lines[i]);
    const get = (name: string) => {
      const j = idx(name);
      return j >= 0 ? cols[j]?.trim() || null : null;
    };
    const permitNumber =
      get("permit number") ??
      get("permit_number") ??
      get("permitnumber") ??
      get("permit #");
    if (!permitNumber) continue;
    const statusCurrent =
      get("status") ?? get("permit status") ?? get("current status") ?? "Issued";
    const outcomeKind = mapStatusToOutcomeKind(statusCurrent) ?? "permit-approved";
    const observedAt =
      toIso(get("issue date") ?? undefined) ??
      toIso(get("issued date") ?? undefined) ??
      toIso(get("date issued") ?? undefined) ??
      new Date().toISOString();
    const address =
      get("address") ?? get("street address") ?? get("location") ?? null;
    outcomes.push(
      buildNormalizedOutcome({
        outcomeKind,
        observedAt,
        jurisdictionTenant: SAN_ANTONIO_JURISDICTION,
        sourceId: SAN_ANTONIO_SOURCE_ID,
        permitNumber,
        statusCurrent,
        address,
        parcelHint: get("parcel") ?? get("property id"),
        sourceUrl: SAN_ANTONIO_PERMITS_CSV,
        notes: get("work type") ?? get("permit type"),
        sourceDataset: "permits_issued.csv",
      }),
    );
  }
  return outcomes;
}

export async function fetchSanAntonioPermitOutcomes(
  options?: PermitOutcomeFetchOptions,
): Promise<PermitOutcomeFetchResult> {
  const limit = options?.limit ?? 100;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const res = await fetchImpl(SAN_ANTONIO_PERMITS_CSV, {
    signal: options?.signal,
  });
  const fetchedAt = new Date().toISOString();
  if (!res.ok) {
    return {
      sourceId: SAN_ANTONIO_SOURCE_ID,
      jurisdictionTenant: SAN_ANTONIO_JURISDICTION,
      outcomes: [],
      partialReason: `HTTP ${res.status}`,
      httpStatus: res.status,
      fetchedAt,
    };
  }
  // Cap download body for bake-time fuel (CSV can be large).
  const text = await res.text();
  const slice = text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
  const outcomes = normalizeSanAntonioCsvRows(slice, limit);
  return {
    sourceId: SAN_ANTONIO_SOURCE_ID,
    jurisdictionTenant: SAN_ANTONIO_JURISDICTION,
    outcomes,
    partialReason:
      outcomes.length === 0
        ? "CSV parsed but zero normalizable issued rows in sample window"
        : null,
    httpStatus: res.status,
    fetchedAt,
  };
}
