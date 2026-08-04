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
 *
 * CALIBRATION FIXES (first ground-truth sweep, 2026-08-04):
 *
 * 1. parcelNodeId threading — every finding was observed carrying the same
 *    degenerate id in a live sweep even though the underlying HTTP probes
 *    plainly hit real, distinct parcels (evidence showed real served data).
 *    No defect reproduces from a pure re-read of the sample/loop wiring in
 *    this file in isolation (each `flag(parcelNodeId, ...)` call already
 *    used the loop's own `const parcelNodeId`, and an integration repro
 *    against a realistic multi-parcel sample confirmed each finding
 *    correctly carried a distinct id). Rather than leave the id path
 *    unguarded pending a live-only repro, this fix makes the id path
 *    self-verifying: the retrieval-api's actual getPropertyAtomChain
 *    response ALSO echoes `parcelNodeId` at the top level
 *    (packages/retrieval/src/index.ts), so this check now cross-checks the
 *    served body's own parcelNodeId against the sampled id it requested and
 *    emits a dedicated, loudly-named finding (defectClass
 *    SERVE-PATH-UNHEALTHY, probe "atom-chain-parcel-id-mismatch") instead of
 *    silently trusting either side — the finding this check ultimately
 *    records is unconditionally keyed on the SAMPLED id (the one this
 *    check actually asked for), never a value read back out of the
 *    response, closing the whole class of "id lost somewhere" defect
 *    regardless of where it originates.
 *
 * 2. extractAtomChainSanity previously matched `entry.entityType` /
 *    `entry.entity_type` on `atoms[]` chain entries and `body.envelope` on
 *    the top-level fallback. Neither matches the real wire shape
 *    (packages/retrieval/src/index.ts getPropertyAtomChain): chain entries
 *    carry `type`/`kind`/`payload.entityType`, and the top-level envelope
 *    key is named `buildableEnvelope`, not `envelope`. The old code could
 *    therefore never observe envelopePresent: true from a real response —
 *    every parcel with a real, servable envelope registered as a mismatch
 *    against DB truth. Fixed to match the real field names.
 *
 * 3. envelopePresent false-mismatch under DESIGNED suppression —
 *    getPropertyAtomChain intentionally suppresses (R13/R27) a
 *    buildable-envelope that depends on a stale/repealed-source Bastrop
 *    city setback-rule (isStaleBastropCitySetbackRule in
 *    @hauska-engine/adapters), UNLESS the envelope is independently
 *    warm-verify-declined or depth-warm-promoted
 *    (envelopeServeIndependentOfStaleSetback in
 *    packages/retrieval/src/envelope-serve-independent.ts) — in which case
 *    it survives suppression and IS served. Reproducing that predicate
 *    exactly here would require importing retrieval-internal staleness
 *    logic (isStaleBastropCitySetbackRule) into engine-core, a cross-package
 *    coupling this check does not want. Per plan option 2 (narrow to
 *    unambiguous cases): the comparator now asserts an envelopePresent
 *    mismatch as a flag ONLY when the DB has an envelope row AND that row
 *    is NOT independently serve-eligible under suppression (no warm-verify
 *    decline / depth-warm-promotion marker — the exact
 *    envelopeServeIndependentOfStaleSetback carve-out, mirrored read-only)
 *    AND the row's setback-rule source is NOT stale (i.e. nothing SHOULD be
 *    suppressing it) AND it is still absent from the served chain — that
 *    combination is unambiguous non-suppression, so absence can only mean a
 *    genuine serve defect. A case where the DB envelope's setback source
 *    IS stale (so suppression is doctrinally expected) but the envelope
 *    lacks the independent-survival markers no longer flags as a hard
 *    defect; it emits a severity:"info" finding instead, named
 *    "designed-suppression-observed", so the observation is not silently
 *    dropped but never false-positives as SERVE-PATH-UNHEALTHY.
 */
import type { WardenFindingEvent } from "./types.js";

export interface DbZoningTruth {
  readonly hasZoningFact: boolean;
  readonly district: string | null;
  readonly hasBuildableEnvelope: boolean;
  /**
   * True when the DB's setback-rule row for this parcel is stale under R13
   * (isStaleBastropCitySetbackRule semantics — a non-authoritative source
   * for a Bastrop city parcel, e.g. a repealed B3 code or descriptor-fixture
   * origin). Null when there is no setback-rule row at all, or the caller
   * cannot determine staleness (e.g. a non-Bastrop-city row where the R13
   * predicate does not apply) — a null value is treated as "not
   * determinably stale" (unambiguous only when explicitly false), matching
   * the narrowing this check takes on option 2 of the calibration fix.
   */
  readonly setbackSourceStale: boolean | null;
  /**
   * True when the DB's buildable-envelope row itself carries a marker that
   * makes it independent of stale-setback suppression (depth-warm-promoted
   * or warm-verify-declined — the same predicate
   * envelopeServeIndependentOfStaleSetback applies at read time). Null when
   * there is no envelope row to inspect.
   */
  readonly envelopeServeIndependentOfStaleSetback: boolean | null;
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
  readonly parcelNodeId: string | null;
  readonly zoningFactPresent: boolean;
  readonly district: string | null;
  readonly envelopePresent: boolean;
}

/** True when a chain-entry/top-level payload's own entityType-carrying field names the given entity type, tolerant of the real wire shape (`type`/`kind`/`payload.entityType`) as well as the `entityType`/`entity_type` shapes other engine-core consumers use for raw stored-atom rows. */
function entryIsEntityType(entry: Record<string, unknown>, entityType: string): boolean {
  if (entry?.type === entityType || entry?.kind === entityType) return true;
  if (entry?.entityType === entityType || entry?.entity_type === entityType) return true;
  const payload = entry?.payload as Record<string, unknown> | undefined;
  if (payload?.entityType === entityType) return true;
  return false;
}

/** Extracts the atom-chain response's parcelNodeId/zoningFact/envelope presence in a schema-tolerant way, matching the real getPropertyAtomChain wire shape (packages/retrieval/src/index.ts): top-level `parcelNodeId`/`zoningFact`/`buildableEnvelope` fields, plus an `atoms[]` chain whose entries carry `type`/`kind`/`payload.entityType`. */
function extractAtomChainSanity(body: unknown): AtomChainBodySanity {
  const b = (body ?? {}) as Record<string, unknown>;
  const chain = Array.isArray(b.atoms) ? b.atoms : Array.isArray(b.chain) ? b.chain : [];
  let zoningFactPresent = false;
  let district: string | null = null;
  let envelopePresent = false;
  for (const entry of chain as Array<Record<string, unknown>>) {
    if (entryIsEntityType(entry, "zoning-fact")) {
      zoningFactPresent = true;
      const payload = (entry?.payload ?? entry?.body ?? entry) as Record<string, unknown>;
      const d = payload?.district;
      if (typeof d === "string") district = d;
    }
    if (entryIsEntityType(entry, "buildable-envelope")) envelopePresent = true;
  }
  // The top-level zoningFact/buildableEnvelope keys are the AUTHORITATIVE
  // source for the real getPropertyAtomChain wire shape (packages/retrieval/
  // src/index.ts) — they are checked unconditionally (not only as an
  // "if the chain walk found nothing" fallback), because a chain-walk hit on
  // a `type`/`kind`-only entry (no `payload`/`body` sub-object) can correctly
  // detect PRESENCE but has no district value to extract; the top-level key
  // is where the real district lives on that shape. A suppressed envelope is
  // entirely absent from BOTH atoms[] and this top-level key — so
  // envelopePresent correctly stays false in that case, which is exactly the
  // signal the comparator below needs to reason about suppression.
  if (b.zoningFact && typeof b.zoningFact === "object") {
    zoningFactPresent = true;
    const zf = b.zoningFact as Record<string, unknown>;
    if (typeof zf?.district === "string") district = zf.district;
  }
  if (b.buildableEnvelope && typeof b.buildableEnvelope === "object") {
    envelopePresent = true;
  }
  const parcelNodeId = typeof b.parcelNodeId === "string" ? b.parcelNodeId : null;
  return { parcelNodeId, zoningFactPresent, district, envelopePresent };
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

  // The finding's parcelNodeId is ALWAYS the sampled id this check actually
  // requested — never a value read back out of a response body — so no
  // response-side corruption or mis-parse can ever propagate into the
  // finding's own identity field.
  function flag(sampledParcelNodeId: string | null, evidence: Record<string, unknown>): void {
    findings.push({
      ts: now().toISOString(),
      sweepId,
      rowId,
      fips,
      parcelNodeId: sampledParcelNodeId,
      checkId: "servePathTruth",
      defectClass: "SERVE-PATH-UNHEALTHY",
      evidence,
      severity: "flag",
      artifactRef,
    });
  }

  function info(sampledParcelNodeId: string | null, evidence: Record<string, unknown>): void {
    findings.push({
      ts: now().toISOString(),
      sweepId,
      rowId,
      fips,
      parcelNodeId: sampledParcelNodeId,
      checkId: "servePathTruth",
      defectClass: "SERVE-PATH-UNHEALTHY",
      evidence,
      severity: "info",
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

  for (const sampledParcelNodeId of deps.sample) {
    // (b) authed GET /search — expects 200; 401 is the named production-outage class.
    try {
      const searchRes = await fetchImpl(`${base}/search?q=setback&limit=1`, {
        method: "GET",
        headers: { Authorization: `Bearer ${deps.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (searchRes.status === 401) {
        flag(sampledParcelNodeId, { probe: "search", httpStatus: 401, detail: "retrieval auth 401" });
        continue;
      }
      if (searchRes.status !== 200) {
        flag(sampledParcelNodeId, { probe: "search", httpStatus: searchRes.status, detail: "non-200 from /search" });
        continue;
      }
    } catch (err) {
      flag(sampledParcelNodeId, { probe: "search", detail: `unreachable: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    // (c) authed GET /property-nodes/<parcel>/atom-chain — expects 200 AND body sanity vs DB truth.
    let atomChainBody: unknown;
    try {
      const atomChainRes = await fetchImpl(`${base}/property-nodes/${sampledParcelNodeId}/atom-chain`, {
        method: "GET",
        headers: { Authorization: `Bearer ${deps.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (atomChainRes.status === 401) {
        flag(sampledParcelNodeId, { probe: "atom-chain", httpStatus: 401, detail: "retrieval auth 401" });
        continue;
      }
      if (atomChainRes.status !== 200) {
        flag(sampledParcelNodeId, { probe: "atom-chain", httpStatus: atomChainRes.status, detail: "non-200 from /property-nodes/atom-chain" });
        continue;
      }
      atomChainBody = await atomChainRes.json();
    } catch (err) {
      flag(sampledParcelNodeId, { probe: "atom-chain", detail: `unreachable or unparsable: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    const served = extractAtomChainSanity(atomChainBody);

    // Self-verifying id cross-check (fix 1): the response echoes its own
    // parcelNodeId; a mismatch against what this check actually sampled is
    // itself a named, loud finding — never silently trusted either way, and
    // never allowed to change what parcelNodeId THIS finding is filed under.
    if (served.parcelNodeId != null && served.parcelNodeId !== sampledParcelNodeId) {
      flag(sampledParcelNodeId, {
        probe: "atom-chain-parcel-id-mismatch",
        sampledParcelNodeId,
        servedParcelNodeId: served.parcelNodeId,
        detail: "atom-chain response echoed a different parcelNodeId than the one requested — serve-path identity is unhealthy",
      });
      continue;
    }

    // App-level truth: the served body's zoningFact/envelope presence must match the DB.
    let dbTruth: DbZoningTruth;
    try {
      dbTruth = await deps.loadDbTruth(sampledParcelNodeId);
    } catch (err) {
      flag(sampledParcelNodeId, { probe: "atom-chain-body-sanity", detail: `DB truth lookup failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const mismatches: string[] = [];
    if (served.zoningFactPresent !== dbTruth.hasZoningFact) mismatches.push("zoningFactPresent");
    if (dbTruth.hasZoningFact && dbTruth.district != null && served.district !== dbTruth.district) {
      mismatches.push("district");
    }

    // envelopePresent — narrowed per fix 3 above. A DB envelope absent from
    // the served chain is UNAMBIGUOUS non-suppression (and therefore a real
    // defect) only when: the row is not independently serve-eligible under
    // suppression, AND its setback source is explicitly known non-stale
    // (setbackSourceStale === false — nothing SHOULD be suppressing it).
    // Any other combination (independently serve-eligible, explicitly
    // stale, or undeterminable) either means the absence IS designed
    // suppression, or this check cannot prove it isn't — in which case a
    // stale-and-suppressed observation is recorded as an info note instead
    // of a hard flag, never silently dropped.
    let envelopeMismatch = false;
    let envelopeSuppressionInfo: Record<string, unknown> | null = null;
    if (served.envelopePresent !== dbTruth.hasBuildableEnvelope) {
      if (dbTruth.hasBuildableEnvelope && !served.envelopePresent) {
        const independentlyServeEligible = dbTruth.envelopeServeIndependentOfStaleSetback === true;
        const unambiguouslyNonStale = dbTruth.setbackSourceStale === false;
        if (!independentlyServeEligible && unambiguouslyNonStale) {
          envelopeMismatch = true;
        } else {
          envelopeSuppressionInfo = {
            probe: "atom-chain-body-sanity",
            note: "designed-suppression-observed",
            setbackSourceStale: dbTruth.setbackSourceStale,
            envelopeServeIndependentOfStaleSetback: dbTruth.envelopeServeIndependentOfStaleSetback,
            detail:
              "DB carries a buildable-envelope absent from the served chain, but suppression cannot be ruled out (R13/R27 designed suppression) — recorded as info, not a serve-path defect",
          };
        }
      } else {
        // served has an envelope the DB does not — this direction of
        // mismatch has no suppression story; always a defect.
        envelopeMismatch = true;
      }
    }
    if (envelopeMismatch) mismatches.push("envelopePresent");

    if (mismatches.length > 0) {
      flag(sampledParcelNodeId, {
        probe: "atom-chain-body-sanity",
        mismatches,
        served: { zoningFactPresent: served.zoningFactPresent, district: served.district, envelopePresent: served.envelopePresent },
        dbTruth,
        detail: "served atom-chain body diverges from DB truth (app-level truth check, beyond OPS-8's HTTP-status-only probe)",
      });
    } else if (envelopeSuppressionInfo) {
      info(sampledParcelNodeId, envelopeSuppressionInfo);
    }
  }

  return findings;
}
