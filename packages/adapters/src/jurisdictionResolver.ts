/**
 * Engagement → applicable-jurisdictions resolver.
 *
 * Given an engagement's geocoded city/state and freeform jurisdiction
 * strings, returns the {@link AdapterJurisdiction} the runner should use
 * to gate adapters. Mirrors the city/state lookup convention from
 * `@workspace/codes`'s `keyFromEngagement` so an engagement that already
 * resolves to (say) `grand_county_ut` for code retrieval also resolves
 * to `grand-county-ut` here for adapter gating — the slugs differ only
 * in separator (underscore vs hyphen) because the codes lib predates the
 * hyphenated `<jurisdiction-key>:<source-name>` convention locked in
 * the DA-PI-4 brief (decision #3).
 *
 * The resolver is intentionally generous: if the geocoder only filled
 * `jurisdictionState` (no city) we still resolve the state-tier
 * adapters. If neither field is set, we return `{ stateKey: null,
 * localKey: null }` and the runner short-circuits with no work.
 */

import type {
  AdapterJurisdiction,
  AdapterLocalKey,
  AdapterStateKey,
} from "./types";

/**
 * Lowercased `${city}|${state}` (or `${county}|${state}`) → local key
 * mapping. We accept both 2-letter and full-name state forms because
 * geocoders disagree.
 */
const CITY_STATE_TO_LOCAL: Record<string, AdapterLocalKey> = {
  // Grand County, UT (Moab is the county seat).
  "moab|ut": "grand-county-ut",
  "moab|utah": "grand-county-ut",
  "grand county|ut": "grand-county-ut",
  "grand county|utah": "grand-county-ut",
  // Lemhi County, ID (Salmon is the county seat).
  "salmon|id": "lemhi-county-id",
  "salmon|idaho": "lemhi-county-id",
  "lemhi county|id": "lemhi-county-id",
  "lemhi county|idaho": "lemhi-county-id",
  // Bastrop, TX.
  "bastrop|tx": "bastrop-tx",
  "bastrop|texas": "bastrop-tx",
};

/** Lowercased state slug (2-letter or full name) → state key mapping. */
const STATE_TO_KEY: Record<string, AdapterStateKey> = {
  ut: "utah",
  utah: "utah",
  id: "idaho",
  idaho: "idaho",
  tx: "texas",
  texas: "texas",
};

export interface ResolveJurisdictionInput {
  jurisdictionCity?: string | null;
  jurisdictionState?: string | null;
  jurisdiction?: string | null;
  address?: string | null;
}

export function resolveJurisdiction(
  input: ResolveJurisdictionInput,
): AdapterJurisdiction {
  const localKey = resolveLocalKey(input);
  const stateKey = resolveStateKey(input, localKey);
  return { stateKey, localKey };
}

function resolveLocalKey(
  input: ResolveJurisdictionInput,
): AdapterLocalKey | null {
  const city = (input.jurisdictionCity ?? "").trim().toLowerCase();
  const state = (input.jurisdictionState ?? "").trim().toLowerCase();
  if (city && state) {
    const k = CITY_STATE_TO_LOCAL[`${city}|${state}`];
    if (k) return k;
  }
  const fromJurisdiction = parseCityState(input.jurisdiction);
  if (fromJurisdiction) {
    const k = CITY_STATE_TO_LOCAL[fromJurisdiction];
    if (k) return k;
  }
  // Address scan — accept "Moab, UT" or "Salmon, Idaho" anywhere in the line.
  const addr = (input.address ?? "").toLowerCase();
  if (addr) {
    for (const [pair, key] of Object.entries(CITY_STATE_TO_LOCAL)) {
      const [c, s] = pair.split("|");
      if (
        addr.includes(`${c}, ${s}`) ||
        (addr.includes(c) && addr.includes(`, ${s}`))
      ) {
        return key;
      }
    }
  }
  return null;
}

function resolveStateKey(
  input: ResolveJurisdictionInput,
  localKey: AdapterLocalKey | null,
): AdapterStateKey | null {
  // If we already pinned a local key, the state is implied.
  if (localKey) {
    if (localKey.endsWith("-ut")) return "utah";
    if (localKey.endsWith("-id")) return "idaho";
    if (localKey.endsWith("-tx")) return "texas";
  }
  const explicit = (input.jurisdictionState ?? "").trim().toLowerCase();
  if (explicit && STATE_TO_KEY[explicit]) return STATE_TO_KEY[explicit];

  // Fall back to parsing freeform jurisdiction / address strings for any
  // recognized state name — keeps state-tier adapters available for
  // engagements where only the state is known.
  const fromJurisdiction = parseCityState(input.jurisdiction);
  if (fromJurisdiction) {
    const [, s] = fromJurisdiction.split("|");
    if (s && STATE_TO_KEY[s]) return STATE_TO_KEY[s];
  }
  const addr = (input.address ?? "").toLowerCase();
  if (addr) {
    for (const [slug, key] of Object.entries(STATE_TO_KEY)) {
      // Use a comma-prefixed test for short codes ("…, UT") so we don't
      // accidentally match an unrelated word containing "ut".
      if (slug.length === 2) {
        if (addr.includes(`, ${slug}`) || addr.includes(`, ${slug} `)) {
          return key;
        }
      } else if (addr.includes(slug)) {
        return key;
      }
    }
  }
  return null;
}

function parseCityState(s: string | null | undefined): string | null {
  const raw = (s ?? "").trim();
  if (!raw) return null;
  const parts = raw.split(",").map((p) => p.trim().toLowerCase());
  if (parts.length < 2) return null;
  const c = parts[0];
  const s2 = parts[1].split(/\s+/)[0];
  if (!c || !s2) return null;
  return `${c}|${s2}`;
}
