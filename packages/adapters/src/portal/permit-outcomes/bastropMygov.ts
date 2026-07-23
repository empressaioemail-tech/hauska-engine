/**
 * Bastrop TX MyGov public portal — PARTIAL without secrets.
 *
 * City of Bastrop publishes permits only through MyGov Address Lookup /
 * collaborator flows (https://public.mygov.us/bastrop_tx). The partner
 * MyGov export API (`api.mygovernmentonline.org`) returns 401 without
 * agency credentials. Wave-2 acquisition canary recorded 0 bulk rows.
 *
 * This adapter probes the public portal and returns an honest empty
 * result with `partialReason` — it never invents permit outcomes.
 */

import type {
  PermitOutcomeFetchOptions,
  PermitOutcomeFetchResult,
} from "./types";

export const BASTROP_MYGOV_PORTAL = "https://public.mygov.us/bastrop_tx";
export const BASTROP_MYGOV_LOOKUP =
  "https://public.mygov.us/bastrop_tx/lookup";
export const BASTROP_MYGOV_SOURCE_ID = "bastrop-mygov" as const;
export const BASTROP_MYGOV_JURISDICTION = "bastrop_tx" as const;

const PARTIAL_REASON =
  "bastrop_tx MyGov has no public bulk JSON permit feed; Address Lookup is interactive HTML; MyGov partner export API returns 401 without agency secrets (not invented). Wave-2 canary row count was 0.";

/**
 * Probe Bastrop MyGov public portal. Always returns zero outcomes with
 * a PARTIAL reason unless a future public bulk endpoint appears.
 */
export async function fetchBastropMygovPermitOutcomes(
  options: PermitOutcomeFetchOptions = {},
): Promise<PermitOutcomeFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const fetchedAt = new Date().toISOString();

  let httpStatus: number | null = null;
  try {
    const res = await fetchImpl(BASTROP_MYGOV_LOOKUP, {
      signal: options.signal,
      headers: { Accept: "text/html,application/json" },
      redirect: "follow",
    });
    httpStatus = res.status;
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    // If somehow a JSON array appears, try to accept it — but do not
    // invent a scraper against HTML forms.
    if (contentType.includes("application/json")) {
      const body: unknown = await res.json();
      if (Array.isArray(body) && body.length > 0) {
        return {
          sourceId: BASTROP_MYGOV_SOURCE_ID,
          jurisdictionTenant: BASTROP_MYGOV_JURISDICTION,
          outcomes: [],
          partialReason:
            "bastrop_tx MyGov returned JSON but no bulk permit-outcome mapper is registered yet (refuse to invent field mapping without a verified schema).",
          httpStatus,
          fetchedAt,
        };
      }
    }
  } catch {
    httpStatus = null;
  }

  return {
    sourceId: BASTROP_MYGOV_SOURCE_ID,
    jurisdictionTenant: BASTROP_MYGOV_JURISDICTION,
    outcomes: [],
    partialReason: PARTIAL_REASON,
    httpStatus,
    fetchedAt,
  };
}
