/**
 * FEMA National Flood Hazard Layer (NFHL) — federal flood-zone adapter.
 *
 * FEMA publishes the NFHL as a public ArcGIS MapServer at
 * `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer`.
 * Layer 28 is the "Flood Hazard Zones" polygon layer — intersecting a
 * point against it yields the parcel's effective FEMA flood zone (e.g.
 * `AE`, `X`, `VE`) plus the supporting attributes (`SFHA_TF`,
 * `STATIC_BFE`, `ZONE_SUBTY`).
 *
 * Tier gating: NFHL is national, not pilot-state-specific. Per PL-04
 * the federal adapter applies for any geocoded engagement (finite
 * lat/lng), regardless of whether the resolver landed on a pilot
 * state slug. Out-of-pilot engagements receive federal layers + a
 * UI banner explaining state/local adapters are pending. The runner
 * already converts NaN-coord adapters to per-row `no-coverage`
 * outcomes (see runner.ts), so the finite-coords check is the only
 * meaningful gate.
 */

import { arcgisPointQuery } from "../arcgis";
import {
  type Adapter,
  type AdapterContext,
  type AdapterResult,
  type UpstreamFreshness,
} from "../types";

const FEMA_NFHL_FLOOD_ZONES =
  "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28";

/**
 * Freshness window for the FEMA NFHL adapter snapshot.
 *
 * FEMA republishes NFHL effective panels on a rolling basis as Letters
 * of Map Revision (LOMRs) clear and new community-wide map products
 * adopt. Most communities' effective FIRMs change on a multi-year
 * cadence, but a stale NFHL snapshot is a real audit risk: an
 * architect citing a 5-year-old FEMA reading might be quoting a zone
 * that has since been redrawn by a LOMR. 12 months keeps the window
 * tight enough that any architect-facing reading is at most one
 * publishing cycle old, while staying loose enough that we don't tag
 * every read as stale on day 366.
 */
export const FEMA_NFHL_FRESHNESS_THRESHOLD_MONTHS = 12;

function federalApplies(ctx: AdapterContext): boolean {
  // PL-04: federal adapters apply nationwide whenever the engagement is
  // geocoded. The earlier gate (`stateKey !== null`) coupled federal
  // coverage to the pilot-state list so an out-of-pilot engagement
  // 422'd consistently; that's now decoupled — federal layers fire for
  // any US lat/lng and the UI surfaces a partial-coverage banner when
  // state/local adapters aren't yet wired for the parcel.
  return (
    Number.isFinite(ctx.parcel.latitude) &&
    Number.isFinite(ctx.parcel.longitude)
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

export const femaNfhlAdapter: Adapter = {
  adapterKey: "fema:nfhl-flood-zone",
  tier: "federal",
  sourceKind: "federal-adapter",
  layerKind: "fema-nfhl-flood-zone",
  provider: "FEMA National Flood Hazard Layer (NFHL)",
  jurisdictionGate: {},
  appliesTo: federalApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await arcgisPointQuery({
      serviceUrl: FEMA_NFHL_FLOOD_ZONES,
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      outFields: "FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,DFIRM_ID",
      returnGeometry: true,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
    });
    // Empty features list = parcel is outside any mapped flood zone
    // (effectively Zone X by omission). We still emit a row so the
    // briefing engine can attribute "no FEMA flood risk" to a cited
    // source rather than a blank.
    if (result.features.length === 0) {
      return {
        adapterKey: this.adapterKey,
        tier: this.tier,
        layerKind: this.layerKind,
        sourceKind: this.sourceKind,
        provider: this.provider,
        snapshotDate: nowIso(),
        payload: {
          kind: "flood-zone",
          inSpecialFloodHazardArea: false,
          floodZone: null,
          features: [],
        },
        note: "Parcel does not intersect a mapped FEMA flood zone (treat as Zone X).",
      };
    }
    const top = result.features[0];
    const attrs = top.attributes as {
      FLD_ZONE?: unknown;
      ZONE_SUBTY?: unknown;
      SFHA_TF?: unknown;
      STATIC_BFE?: unknown;
    };
    const floodZone =
      typeof attrs.FLD_ZONE === "string" ? attrs.FLD_ZONE : null;
    // FEMA stamps SFHA_TF as the literal string "T" or "F" — we
    // normalize to a boolean so the briefing engine doesn't have to
    // re-parse upstream's wire convention.
    const inSfha = attrs.SFHA_TF === "T" || attrs.SFHA_TF === true;
    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: {
        kind: "flood-zone",
        inSpecialFloodHazardArea: inSfha,
        floodZone,
        zoneSubtype:
          typeof attrs.ZONE_SUBTY === "string" ? attrs.ZONE_SUBTY : null,
        baseFloodElevation:
          typeof attrs.STATIC_BFE === "number" ? attrs.STATIC_BFE : null,
        features: result.features,
      },
    };
  },
  /**
   * Cheap upstream freshness probe (Task #227). FEMA's NFHL MapServer
   * exposes per-layer metadata at `${serviceUrl}?f=json` — the
   * `editingInfo.lastEditDate` field is the Unix epoch (ms) of the
   * most recent edit to the flood-hazard polygons. Comparing it
   * against the cached row's write timestamp tells us whether FEMA
   * has published a revision since we last fetched. The probe is one
   * GET that returns ~1KB of JSON, well under a tenth of the cost
   * of the actual point-in-polygon query.
   */
  async getUpstreamFreshness({
    ctx,
    cachedAt,
  }: {
    ctx: AdapterContext;
    cachedAt: Date;
  }): Promise<UpstreamFreshness> {
    return checkNfhlFreshness({ ctx, cachedAt });
  },
};

/**
 * Helper extracted from the adapter's `getUpstreamFreshness` so unit
 * tests can exercise it without going through the runner. Returns:
 *   - `fresh` when `lastEditDate <= cachedAt` (or the layer has no
 *     `editingInfo.lastEditDate` at all — FEMA only stamps it when
 *     the layer has been edited at least once, and an unedited layer
 *     can never be staler than our cache).
 *   - `stale` when `lastEditDate > cachedAt`, with the upstream edit
 *     timestamp in the reason string so the FE tooltip can show it.
 *   - `unknown` for HTTP errors, non-JSON responses, or a missing /
 *     non-numeric `lastEditDate`.
 */
async function checkNfhlFreshness({
  ctx,
  cachedAt,
}: {
  ctx: AdapterContext;
  cachedAt: Date;
}): Promise<UpstreamFreshness> {
  const fetchFn = ctx.fetchImpl ?? fetch;
  const url = `${FEMA_NFHL_FLOOD_ZONES}?f=json`;
  let res: Response;
  try {
    res = await fetchFn(url, { signal: ctx.signal });
  } catch (err) {
    return {
      status: "unknown",
      reason: `Could not reach FEMA NFHL metadata endpoint: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res.ok) {
    return {
      status: "unknown",
      reason: `FEMA NFHL metadata endpoint responded with HTTP ${res.status}.`,
    };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    return {
      status: "unknown",
      reason: `FEMA NFHL metadata response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!json || typeof json !== "object") {
    return {
      status: "unknown",
      reason: "FEMA NFHL metadata response was not a JSON object.",
    };
  }
  const editingInfo = (json as { editingInfo?: { lastEditDate?: unknown } })
    .editingInfo;
  const lastEditRaw = editingInfo?.lastEditDate;
  // Distinguish "missing" from "present but malformed":
  //   - ArcGIS returns `editingInfo: { lastEditDate: <epoch ms> }`
  //     only when the layer has actually been edited at least once.
  //     Absence (no `editingInfo` at all, or `lastEditDate` literally
  //     undefined) means the layer has never been touched, which is
  //     the strongest possible "still fresh".
  //   - But if FEMA returned a `lastEditDate` of an unexpected shape
  //     (e.g. a string, NaN, or Infinity), the contract has drifted
  //     and we cannot make a confident verdict — surface that as
  //     `unknown` rather than silently assume `fresh`.
  if (lastEditRaw === undefined) {
    return {
      status: "fresh",
      reason: "FEMA NFHL did not report a lastEditDate; assuming layer is unchanged.",
    };
  }
  if (typeof lastEditRaw !== "number" || !Number.isFinite(lastEditRaw)) {
    return {
      status: "unknown",
      reason: `FEMA NFHL returned a non-numeric lastEditDate (${typeof lastEditRaw}); cannot determine freshness.`,
    };
  }
  // FEMA stamps lastEditDate at second granularity in epoch ms. Allow
  // a 1-minute fudge so a clock skew between FEMA and our cache row
  // can't flip a row that was just freshly written into "stale".
  const FUDGE_MS = 60 * 1000;
  if (lastEditRaw > cachedAt.getTime() + FUDGE_MS) {
    return {
      status: "stale",
      reason: `FEMA published a NFHL revision at ${new Date(lastEditRaw).toISOString()}, after this cache row was written (${cachedAt.toISOString()}).`,
    };
  }
  return {
    status: "fresh",
    reason: `FEMA's NFHL was last edited at ${new Date(lastEditRaw).toISOString()}; the cached row is current.`,
  };
}
