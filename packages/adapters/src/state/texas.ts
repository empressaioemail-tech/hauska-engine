/**
 * Texas statewide adapters — TCEQ Edwards Aquifer.
 *
 * The Texas Commission on Environmental Quality publishes the Edwards
 * Aquifer Recharge and Contributing zones as ArcGIS REST layers. Both
 * polygons are central regulatory inputs for any project sitting on or
 * upstream of the aquifer (Bastrop is in the Contributing zone, hence
 * its inclusion in the pilot set).
 *
 * One adapter, two layers: rather than spawning two adapter rows for a
 * single TCEQ dataset we collapse Recharge + Contributing into a single
 * `tceq:edwards-aquifer` row whose payload carries both polygons. That
 * matches how TCEQ documents the dataset and keeps the briefing engine
 * from having to reconcile two parallel tables for a logically-single
 * lookup.
 */

import { arcgisPointQuery } from "../arcgis";
import {
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";

const TCEQ_ENDPOINTS = {
  recharge:
    "https://gisweb.tceq.texas.gov/arcgis/rest/services/EdwardsAquifer/RechargeZone/MapServer/0",
  contributing:
    "https://gisweb.tceq.texas.gov/arcgis/rest/services/EdwardsAquifer/ContributingZone/MapServer/0",
} as const;

/**
 * Freshness window for the TCEQ Edwards Aquifer adapter snapshot,
 * in whole months. Surfaced via {@link evaluateStateSnapshotFreshness}
 * so the Site Context tab renders the same amber stale badge on
 * state-tier rows that Task #222 added on the federal tier.
 *
 * Edwards Aquifer recharge + contributing zone polygons are
 * regulatory boundaries (TCEQ rule 30 TAC §213) that change rarely
 * — usually only on a rule revision or a survey-driven boundary
 * adjustment. But when they *do* change, an architect citing a stale
 * read might be quoting a parcel as outside the recharge zone after
 * a republish brought it inside, which is a real audit risk. 18
 * months keeps the window long enough that a routine annual
 * re-publish doesn't fire the badge while still flagging snapshots
 * predating any rule-revision cadence.
 */
export const TCEQ_EDWARDS_AQUIFER_FRESHNESS_THRESHOLD_MONTHS = 18;

function texasApplies(ctx: AdapterContext): boolean {
  return ctx.jurisdiction.stateKey === "texas";
}

function nowIso(): string {
  return new Date().toISOString();
}

export const texasEdwardsAquiferAdapter: Adapter = {
  adapterKey: "tceq:edwards-aquifer",
  tier: "state",
  sourceKind: "state-adapter",
  layerKind: "tceq-edwards-aquifer",
  provider: "Texas Commission on Environmental Quality (TCEQ)",
  jurisdictionGate: { state: "texas" },
  appliesTo: texasApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    // Run both layer queries in parallel — they hit the same TCEQ host
    // so any rate limiting applies symmetrically and the wall-clock
    // cost is one round-trip not two.
    const [recharge, contributing] = await Promise.all([
      arcgisPointQuery({
        serviceUrl: TCEQ_ENDPOINTS.recharge,
        latitude: ctx.parcel.latitude,
        longitude: ctx.parcel.longitude,
        outFields: "*",
        returnGeometry: false,
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
      }),
      arcgisPointQuery({
        serviceUrl: TCEQ_ENDPOINTS.contributing,
        latitude: ctx.parcel.latitude,
        longitude: ctx.parcel.longitude,
        outFields: "*",
        returnGeometry: false,
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
      }),
    ]);

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: {
        kind: "edwards-aquifer",
        rechargeZone: recharge.features[0] ?? null,
        contributingZone: contributing.features[0] ?? null,
        inRecharge: recharge.features.length > 0,
        inContributing: contributing.features.length > 0,
      },
    };
  },
};
