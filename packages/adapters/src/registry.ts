/**
 * Adapter registry — the canonical "all the adapters DA-PI-4 ships"
 * list. The api-server's generate-layers route imports {@link
 * ALL_ADAPTERS}; tests can inject a narrower subset directly into the
 * runner.
 *
 * Adding a new adapter is a one-line append here plus the adapter
 * module itself — the runner picks it up automatically and the UI's
 * tier grouping reads `tier` off the adapter contract, so no UI change
 * is required for an additional source within an existing tier.
 */

import type { Adapter } from "./types";
import { femaNfhlAdapter } from "./federal/fema-nfhl";
import { usgsNedAdapter } from "./federal/usgs-ned";
import { epaEjscreenAdapter } from "./federal/epa-ejscreen";
import { usdaSsurgoSoilsAdapter } from "./federal/usda-ssurgo";
import { usgsGeologyAdapter } from "./federal/usgs-geology";
import { usgsGroundwaterAdapter } from "./federal/usgs-groundwater";
import { usgsSeismicAdapter } from "./federal/usgs-seismic";
import { fccBroadbandAdapter } from "./federal/fcc-broadband";
import {
  cotalityParcelsAdapter,
  cotalityZoningAdapter,
} from "./national/cotality";
import { COTALITY_EXTENDED_ADAPTERS } from "./national/cotalityExtended";
import {
  utahDemAdapter,
  utahParcelsAdapter,
  utahAddressPointsAdapter,
} from "./state/utah";
import {
  idahoDemAdapter,
  idahoParcelsAdapter,
} from "./state/idaho";
import { texasEdwardsAquiferAdapter } from "./state/texas";
import {
  grandCountyParcelsAdapter,
  grandCountyZoningAdapter,
  grandCountyRoadsAdapter,
} from "./local/grand-county-ut";
import {
  lemhiCountyParcelsAdapter,
  lemhiCountyZoningAdapter,
  lemhiCountyRoadsAdapter,
} from "./local/lemhi-county-id";
import {
  bastropParcelsAdapter,
  bastropZoningAdapter,
  bastropFloodAdapter,
} from "./local/bastrop-tx";

/**
 * QA-22 SCOPE B closeout (2026-05-23) — `fcc:broadband` is gated off
 * by default. PR #96's structured logging confirmed the FCC BDC v2
 * endpoint is Akamai-WAF-gated: server RSTs at ~19s or holds 60s
 * with zero bytes for any client UA, both from Cloud Run egress AND
 * a workstation curl. PR #94's 90s timeout + 15-min cache can't
 * help because no successful response ever arrives, so the cache
 * never warms.
 *
 * The adapter binding stays imported + exported so its unit tests
 * keep running, and so an operator can flip the flag back via env
 * var without a code redeploy if a future use case re-emerges (e.g.
 * FCC ships a non-WAF-fronted programmatic endpoint, or we move to
 * the BDC bulk-download CSV path).
 *
 * Set `FCC_ENABLED=true` in the Cloud Run service env to re-register
 * the adapter. Default is "off" — `process.env.FCC_ENABLED` undefined
 * OR any value other than the literal string `"true"` keeps FCC out
 * of {@link FEDERAL_ADAPTERS} and therefore out of every
 * `runAdapters(...)` outcome list (no pill rendered, no failure
 * surfaced).
 *
 * Session summary: doc_repo/_sessions/2026-05-23_qa22_fcc_recon_cc-agent-C.md
 */
function defaultProcessEnv(): NodeJS.ProcessEnv {
  if (typeof process !== "undefined" && process.env) {
    return process.env;
  }
  return {};
}

export function isFccEnabled(
  env: NodeJS.ProcessEnv = defaultProcessEnv(),
): boolean {
  return env.FCC_ENABLED === "true";
}

/**
 * PB-008 — optional TCEQ Edwards Aquifer on the Property Brief site-
 * context path. Default off; set `TCEQ_EDWARDS_ENABLED=true` on the
 * api-server env to include the state-tier adapter for Texas parcels.
 */
export function isTceqEdwardsEnabled(
  env: NodeJS.ProcessEnv = defaultProcessEnv(),
): boolean {
  return env.TCEQ_EDWARDS_ENABLED === "true";
}

export const FEDERAL_ADAPTERS: ReadonlyArray<Adapter> = [
  femaNfhlAdapter,
  usgsNedAdapter,
  epaEjscreenAdapter,
  // Wave 1 subsurface (2026-06-07, cc-agent-C) — free federal public-records
  // layers for soils, geology, groundwater monitoring, and seismic design.
  usdaSsurgoSoilsAdapter,
  usgsGeologyAdapter,
  usgsGroundwaterAdapter,
  usgsSeismicAdapter,
  // QA-22 SCOPE B closeout (PR #102) — see `isFccEnabled` docstring
  // above. FCC is gated off by default; the binding is only spread
  // in when the operator flips `FCC_ENABLED=true` on the Cloud Run
  // service env.
  ...(isFccEnabled() ? [fccBroadbandAdapter] : []),
  // National parcel + zoning provider — Cotality (2026-06-06 provider
  // decision). Tier-housed under FEDERAL_ADAPTERS for cache-predicate
  // reuse (the runner's default cache predicate caches federal-tier
  // outcomes). The operator-visible attribution is source_kind =
  // "national-aggregator", which the UI reads.
  //
  // Config-gated dormant per the 2026-07-13 Cotality-swap decision:
  // when COTALITY_* creds are absent the adapters throw an
  // AdapterRunError("no-coverage", ...) that the runner normalizes to a
  // neutral `no-coverage` outcome, so a national land-use call degrades
  // honestly rather than failing. Re-entry is a config flip (mount
  // creds); no code change. Do NOT remove — the swap decision keeps the
  // Cotality scaffolding in place as the config-gated re-entry path.
  //
  // The former Regrid national baseline (regrid:parcels / regrid:zoning)
  // was removed here: Regrid was purged ("no Regrid ever", 2026-07-13),
  // its readApiKey() threw an unconditional upstream-error (→ failed) on
  // every national land-use call because REGRID_API_KEY is unmounted,
  // and nothing depends on it (the map path already asserts no Regrid
  // fallback). See PR removing the dead throwing stubs.
  cotalityParcelsAdapter,
  cotalityZoningAdapter,
  ...COTALITY_EXTENDED_ADAPTERS,
];

// TODO: state-tier gates on localKey not stateKey — see PL-04
// side-finding for follow-up cleanup. Each state adapter's
// `appliesTo` checks `ctx.jurisdiction.localKey === "<county-slug>"`
// rather than the parent `stateKey`, so an engagement that resolves
// only to a state slug (no localKey match) gets zero state-tier
// adapters even though the gate name implies state-wide coverage.
// Decoupling this is a separate sprint — listed here so the next
// engineer touching state tiers sees the inconsistency.
export const STATE_ADAPTERS: ReadonlyArray<Adapter> = [
  utahDemAdapter,
  utahParcelsAdapter,
  utahAddressPointsAdapter,
  idahoDemAdapter,
  idahoParcelsAdapter,
  texasEdwardsAquiferAdapter,
];

export const LOCAL_ADAPTERS: ReadonlyArray<Adapter> = [
  // Bastrop local: parcels + floodplain live; bastrop-tx:zoning is
  // dead-expected (COMPLETE-BASTROP C2 / S-06) — runner status enum
  // includes `dead-expected`; replacement is zoning-agol:bastrop-city-tx.
  grandCountyParcelsAdapter,
  grandCountyZoningAdapter,
  grandCountyRoadsAdapter,
  lemhiCountyParcelsAdapter,
  lemhiCountyZoningAdapter,
  lemhiCountyRoadsAdapter,
  bastropParcelsAdapter,
  bastropZoningAdapter,
  bastropFloodAdapter,
];

/**
 * The full DA-PI-4 + DA-PI-2 adapter set. Federal adapters lead so the
 * Site Context tab's "Federal layers" group renders before the state
 * and local groups in the order returned by the runner.
 */
export const ALL_ADAPTERS: ReadonlyArray<Adapter> = [
  ...FEDERAL_ADAPTERS,
  ...STATE_ADAPTERS,
  ...LOCAL_ADAPTERS,
];
