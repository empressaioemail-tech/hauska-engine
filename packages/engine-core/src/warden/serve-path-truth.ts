/**
 * Warden check 2 — servePathTruth (files-never-fixes: READ ONLY, HTTP GETs only).
 *
 * Wider deterministic sample (default 10 parcels/row) of the same three
 * retrieval-api endpoints OPS-8 check 6 probes on a 1-parcel/5-parcel sample
 * (preflight-probes.ts buildServePathHealthProbe): GET /health/search (2xx),
 * authed GET /search (200), authed GET
 * /property-nodes/<parcel>/atom-chain (200) — PLUS the app-level truth part
 * this check adds beyond OPS-8: the atom-chain response body's zoningFact /
 * envelope presence must match what the DB says for that parcel (a 200 with
 * a body that silently omits or contradicts the DB's zoning-fact is a worse
 * failure mode than an honest 401/500, so it gets its own named class).
 *
 * This module does NOT import buildServePathHealthProbe — it deliberately
 * reimplements the three-endpoint walk against a wider per-parcel sample so
 * each of the N parcels' bodies can be diffed against DB truth individually
 * (the OPS-8 probe short-circuits to reachable:false after the first
 * failure and only checks ONE sample parcel's atom-chain, which is the
 * right shape for a fast pre-flight gate but the wrong shape for this
 * check's per-parcel truth comparison). Same endpoints, same auth
 * convention (Authorization: Bearer <key>), same 401-is-a-named-decline
 * discipline — just walked over every sampled parcel instead of stopping at
 * the first.
 */
import type { WardenFindingEvent } from "./types.js";

export interface DbZoningTruth {
  readonly hasZoningFact: boolean;
  readonly district: string | null;
  readonly hasBuildableEnvelope: boolean;
}

export interface ServePathTruthDeps {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Deterministic sample of parcelNodeIds for the row (caller-supplied; default 10). */
  readonly sample: readonly string[];
  /** DB-truth lookup for a parcel, used for the app-level body-sanity comparison. */
  readonly loadDbTruth: (parcelNodeId: string) => Promise<DbZoningTruth>;
}

interface AtomChainBodySanity {
  readonly zoningFactPresent: boolean;
  readonly district: string | null;
  readonly envelopePresent: boolean;
}

/** Extracts the atom-chain response's zoningFact/envelope presence in a schema-tolerant way. */
function extractAtomChainSanity(body: unknown): AtomChainBodySanity {
  const b = (body ?? {}) as Record<string, unknown>;
  const chain = Array.isArray(b.atoms) ? b.atoms : Array.isArray(b.chain) ? b.chain : [];
  let zoningFactPresent = false;
  let district: string | null = null;
  let envelopePresent = false;
  for (const entry of chain as Array<Record<string, unknown>>) {
    const entityType = entry?.entityType ?? entry?.entity_type;
    if (entityType === "zoning-fact") {
      zoningFactPresent = true;
      const bodyField = (entry?.body ?? entry) as Record<string, unknown>;
      const d = bodyField?.district;
      district = typeof d === "string" ? d : null;
    }
    if (entityType === "buildable-envelope") envelopePresent = true;
  }
  // Fallback: some retrieval-api shapes surface zoningFact/envelope as top-level keys instead of a chain array.
  if (!zoningFactPresent && b.zoningFact) {
    zoningFactPresent = true;
    const zf = b.zoningFact as Record<string, unknown>;
    district = typeof zf?.district === "string" ? zf.district : null;
  }
  if (!envelopePresent && b.envelope) envelopePresent = true;
  return { zoningFactPresent, district, envelopePresent };
}

/**
 * Runs the servePathTruth check over `deps.sample`. Findings only, never
 * throws for an expected condition (a per-parcel probe failure becomes a
 * flag finding, not an exception) — mirrors the onboard-preflight.ts
 * "never throw for an expected condition" discipline.
 */
export async function runServePathTruthCheck(params: {
  readonly sweepId: string;
  readonly fips: string;
  readonly rowId: string;
  readonly deps: ServePathTruthDeps;
  readonly now: () => Date;
}): Promise<WardenFindingEvent[]> {
  const { sweepId, fips, rowId, deps, now } = params;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const base = deps.baseUrl.replace(/\/$/, "");
  const artifactRef = `warden-sweep:${sweepId}:servePathTruth`;
  const findings: WardenFindingEvent[] = [];

  function flag(parcelNodeId: string | null, evidence: Record<string, unknown>): void {
    findings.push({
      ts: now().toISOString(),
      sweepId,
      rowId,
      fips,
      parcelNodeId,
      checkId: "servePathTruth",
      defectClass: "SERVE-PATH-UNHEALTHY",
      evidence,
      severity: "flag",
      artifactRef,
    });
  }

  // (a) GET /health/search — expects 2xx. Whole-row check, not per-parcel.
  try {
    const healthRes = await fetchImpl(`${base}/health/search`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!healthRes.ok) {
      flag(null, { probe: "health/search", httpStatus: healthRes.status, detail: "non-2xx from /health/search" });
      return findings; // downstream probes are moot if health itself fails.
    }
  } catch (err) {
    flag(null, { probe: "health/search", detail: `unreachable: ${err instanceof Error ? err.message : String(err)}` });
    return findings;
  }

  for (const parcelNodeId of deps.sample) {
    // (b) authed GET /search — expects 200; 401 is the named production-outage class.
    try {
      const searchRes = await fetchImpl(`${base}/search?q=setback&limit=1`, {
        method: "GET",
        headers: { Authorization: `Bearer ${deps.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (searchRes.status === 401) {
        flag(parcelNodeId, { probe: "search", httpStatus: 401, detail: "retrieval auth 401" });
        continue;
      }
      if (searchRes.status !== 200) {
        flag(parcelNodeId, { probe: "search", httpStatus: searchRes.status, detail: "non-200 from /search" });
        continue;
      }
    } catch (err) {
      flag(parcelNodeId, { probe: "search", detail: `unreachable: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    // (c) authed GET /property-nodes/<parcel>/atom-chain — expects 200 AND body sanity vs DB truth.
    let atomChainBody: unknown;
    try {
      const atomChainRes = await fetchImpl(`${base}/property-nodes/${parcelNodeId}/atom-chain`, {
        method: "GET",
        headers: { Authorization: `Bearer ${deps.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (atomChainRes.status === 401) {
        flag(parcelNodeId, { probe: "atom-chain", httpStatus: 401, detail: "retrieval auth 401" });
        continue;
      }
      if (atomChainRes.status !== 200) {
        flag(parcelNodeId, { probe: "atom-chain", httpStatus: atomChainRes.status, detail: "non-200 from /property-nodes/atom-chain" });
        continue;
      }
      atomChainBody = await atomChainRes.json();
    } catch (err) {
      flag(parcelNodeId, { probe: "atom-chain", detail: `unreachable or unparsable: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    // App-level truth: the served body's zoningFact/envelope presence must match the DB.
    let dbTruth: DbZoningTruth;
    try {
      dbTruth = await deps.loadDbTruth(parcelNodeId);
    } catch (err) {
      flag(parcelNodeId, { probe: "atom-chain-body-sanity", detail: `DB truth lookup failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const served = extractAtomChainSanity(atomChainBody);
    const mismatches: string[] = [];
    if (served.zoningFactPresent !== dbTruth.hasZoningFact) mismatches.push("zoningFactPresent");
    if (dbTruth.hasZoningFact && dbTruth.district != null && served.district !== dbTruth.district) {
      mismatches.push("district");
    }
    if (served.envelopePresent !== dbTruth.hasBuildableEnvelope) mismatches.push("envelopePresent");
    if (mismatches.length > 0) {
      flag(parcelNodeId, {
        probe: "atom-chain-body-sanity",
        mismatches,
        served: { zoningFactPresent: served.zoningFactPresent, district: served.district, envelopePresent: served.envelopePresent },
        dbTruth,
        detail: "served atom-chain body diverges from DB truth (app-level truth check, beyond OPS-8's HTTP-status-only probe)",
      });
    }
  }

  return findings;
}
