/**
 * EPA EJScreen — federal environmental-justice screening adapter.
 *
 * HISTORY:
 *
 * - Original (pre-2024): EPA published EJScreen at `ejscreen.epa.gov`
 *   with a public REST broker (`/mapper/ejscreenRESTbroker3.aspx`)
 *   that returned block-group indicators keyed by EJScreen field names
 *   (`P_PM25`, `P_OZONE`, etc.) under `data.main`. Calls went through
 *   {@link fetchWithRetry} with a SLOW_UPSTREAM_TIMEOUT_MS budget.
 *
 * - 2024-late: EPA decommissioned the entire `ejscreen.epa.gov` host
 *   (DNS NXDOMAIN) and the `www.epa.gov/ejscreen*` page tree (HTTP 404).
 *   No successor announced.
 *
 * - 2026-05-23 dead-end sweep (cc-agent-C QA-22 SCOPE A Path 1a, see
 *   `_research/2026-05-23_qa22_epa_path1a_cc-agent-C.md`): confirmed
 *   full decommission. Swept geopub.epa.gov + gispub.epa.gov +
 *   edg.epa.gov + EPA Esri Online org. No EPA-published successor. The
 *   only national-coverage source still emitting the EJScreen 2023
 *   schema is a CalEPA-hosted Feature Server mirror.
 *
 * - 2026-05-23 opt-in landing (this change, decision record
 *   `doc_repo/_decisions/2026-05-23_epa_calepa_mirror_opt_in.md`):
 *   three policy deltas explicitly accepted; adapter swapped to the
 *   CalEPA mirror.
 *
 * CURRENT IMPLEMENTATION (CalEPA mirror, opt-in):
 *
 *   Endpoint: services2.arcgis.com/iq8zYa0SRsvIFFKz/.../EJSCREEN_2023_BG_StatePct_with_AS_CNMI_GU_VI_gdb/FeatureServer/0
 *   Schema:   EJScreen 2023, block-group polygons, state percentiles
 *   Vintage:  CalEPA mirror published 2024-01-29 (frozen until further notice)
 *
 * THREE OPERATOR-ACCEPTED DELTAS:
 *
 *   1. Not EPA-owned. State-agency hosted mirror at
 *      `services2.arcgis.com` (owner `1045138_CAL`). Could be taken
 *      down or stop refreshing. Provider attribution explicitly names
 *      "CalEPA mirror — EPA EJScreen API retired" so the federal-tier
 *      promise on Redd softens visibly, it does not silently erase.
 *
 *   2. State-distribution percentiles, not US-distribution. Layer is
 *      `EJSCREEN_StatePctiles_with_AS_CNMI_GU_VI`. A `P_PM25=78` from
 *      this mirror means "78th percentile of PM2.5 within this state",
 *      not "78th percentile nationwide". The payload carries
 *      `percentileBasis: "state"` so the UI / chip / markdown digest
 *      can surface "state-pctile" wherever they render a percentile.
 *
 *   3. Demographic-index methodology shift between 2022 → 2023.
 *      `P_D2_VULEOPCT` (old broker, 2022 EJScreen) → `P_DEMOGIDX_2`
 *      (2023 mirror). EJScreen 2023 dropped "vulnerable" from the
 *      demographic-index components. Forward-only (Cortex did not
 *      carry historical EJScreen state) but worth knowing.
 *
 * REVERSAL CRITERIA (per the decision record):
 *
 *   - CalEPA tenant takes the mirror down → roll back to "leave EPA
 *     pill red", file a fresh SCOPE A recon for the next successor pass.
 *   - EPA publishes EJScreen v2 → swap back to EPA endpoint via fresh
 *     dispatch; the CalEPA mirror becomes a documented historical
 *     fallback in this docstring.
 *   - Operator changes mind on state-percentile silent-drift risk →
 *     disable the adapter, re-evaluate.
 *   - A Cortex briefing surfaces an embarrassing reading traceable to
 *     state-vs-US percentile confusion → pause adapter, audit briefing
 *     UI copy, re-enable with stronger disclosure.
 *
 * FRESHNESS THRESHOLD CHOICE:
 *
 *   24 months (up from the 18 the original EPA broker used). EJScreen
 *   was historically rebuilt roughly annually; the CalEPA mirror is
 *   intentionally a frozen 2023 snapshot republished on 2024-01-29 with
 *   no published refresh cadence. The 24-month window gives some
 *   headroom past the mirror's current ~16-month staleness while still
 *   firing the cache-age badge for engagements opened years apart.
 *   NOTE that `snapshotDate` is stamped at fetch time, not at upstream
 *   data publication time — the badge therefore measures cache age,
 *   not the underlying EJScreen 2023 vintage. The
 *   `payload.upstreamDatasetVersion` field carries the data vintage so
 *   the UI can disclose that independently of cache age.
 *
 * DEAD-END LEDGER (so a future agent does not re-dig the 2026-05-23 sweep):
 *
 *   geopub.epa.gov/arcgis/rest/services       — no EJ folder/service
 *   gispub.epa.gov/arcgis/rest/services       — no EJ folder/service
 *   edg.epa.gov/data/PUBLIC/OEI/              — no EJScreen archive
 *   NEPAssist/NEPAVELayersPublic_fgdb         — NAAQS non-attainment
 *                                                polygons only
 *                                                (categorical, not the
 *                                                percentile schema)
 *   ORD/EnvironmentalQualityIndex             — different methodology
 *                                                + different schema
 *   OEI/ACS_Demographics_by_Tract_2008_2012   — stale Census, no
 *                                                pollution layer
 *   EPA Esri Online org search for "EJScreen" — only third-party
 *                                                mirrors of the 2023
 *                                                archive (CalEPA,
 *                                                Delaware FirstMap,
 *                                                small state orgs)
 *
 * Calls go through {@link arcgisPointQuery} so transient hiccups are
 * not surfaced as a hard failure on the first try, and so DNS / TLS /
 * ECONNRESET throws collapse into a typed `network-error` adapter
 * failure rather than rendering as "fetch failed" with no body.
 */

import {
  type Adapter,
  type AdapterContext,
  type AdapterResult,
  AdapterRunError,
} from "../types";
import { arcgisPointQuery } from "../arcgis";

/**
 * CalEPA-hosted mirror of the EJScreen 2023 block-group dataset. See
 * the top-of-file docstring for the dead-end ledger that led here and
 * the three operator-accepted policy deltas.
 */
const EPA_EJSCREEN_FEATURESERVER =
  "https://services2.arcgis.com/iq8zYa0SRsvIFFKz/arcgis/rest/services/" +
  "EJSCREEN_2023_BG_StatePct_with_AS_CNMI_GU_VI_gdb/FeatureServer/0";

/**
 * Short label shown on the failure pill / log lines if the upstream
 * misbehaves. Kept compact so the pill fits without wrapping.
 */
const EPA_EJSCREEN_LABEL = "EJScreen (CalEPA mirror)";

/**
 * Provider attribution string set on the persisted briefing-source
 * row. Surfaces in the row footer as "source: <provider>". Per the
 * decision record (2026-05-23) this MUST NOT read just "EJScreen" —
 * the federal-tier promise softens via attribution, it does not
 * silently erase.
 */
export const EPA_EJSCREEN_PROVIDER_LABEL =
  "EJScreen 2023 — CalEPA mirror — EPA EJScreen API retired, awaiting v2";

/**
 * Data vintage label exposed on the payload so the UI can disclose
 * "what year of EJScreen this is" independently of when the adapter
 * ran. The CalEPA mirror is a frozen snapshot, not a live feed.
 */
export const EPA_EJSCREEN_DATASET_VERSION =
  "EJScreen 2023 (CalEPA mirror, published 2024-01-29)";

/**
 * Block-group attribute fields the adapter pulls from the ArcGIS
 * Feature Server. Kept as a constant so the same list drives both the
 * `outFields` query parameter and the payload mapping below.
 */
const EJSCREEN_OUT_FIELDS = [
  "ID", // block-group GEOID
  "STATE_NAME",
  "ACSTOTPOP", // population (was RAW_D_POP in the old broker)
  "P_DEMOGIDX_2", // 2-component demographic index (was P_D2_VULEOPCT)
  "P_DEMOGIDX_5", // supplemental 5-component demographic index
  "P_PM25",
  "P_OZONE",
  "P_LDPNT",
].join(",");

/**
 * Freshness window for the EPA EJScreen snapshot.
 *
 * 24 months — see the FRESHNESS THRESHOLD CHOICE section of the
 * top-of-file docstring for the rationale.
 */
export const EPA_EJSCREEN_FRESHNESS_THRESHOLD_MONTHS = 24;

function federalApplies(ctx: AdapterContext): boolean {
  // PL-04: federal adapters apply nationwide whenever the engagement is
  // geocoded. See fema-nfhl.ts for the decoupling rationale.
  return (
    Number.isFinite(ctx.parcel.latitude) &&
    Number.isFinite(ctx.parcel.longitude)
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function pickNumber(
  attrs: Record<string, unknown>,
  key: string,
): number | null {
  const v = attrs[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickString(
  attrs: Record<string, unknown>,
  key: string,
): string | null {
  const v = attrs[key];
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

export const epaEjscreenAdapter: Adapter = {
  adapterKey: "epa:ejscreen",
  tier: "federal",
  sourceKind: "federal-adapter",
  layerKind: "epa-ejscreen-blockgroup",
  provider: EPA_EJSCREEN_PROVIDER_LABEL,
  jurisdictionGate: {},
  appliesTo: federalApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await arcgisPointQuery({
      serviceUrl: EPA_EJSCREEN_FEATURESERVER,
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      outFields: EJSCREEN_OUT_FIELDS,
      returnGeometry: false,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      upstreamLabel: EPA_EJSCREEN_LABEL,
    });
    const feature = result.features[0];
    if (!feature) {
      // CalEPA's EJSCREEN_2023_BG layer covers all 50 states + DC + PR
      // + AS/CNMI/GU/VI; a query that returns zero features at a valid
      // lat/lng almost always means the point fell in unincorporated
      // water / federal land that's not in the block-group base layer.
      throw new AdapterRunError(
        "no-coverage",
        "EJScreen returned no block-group indicators at this lat/lng.",
      );
    }
    const attrs = feature.attributes;
    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: {
        kind: "ejscreen-blockgroup",
        // `state` flags the percentile basis so the UI / chip / markdown
        // digest can surface "state-pctile" wherever they render a
        // percentile — see THREE OPERATOR-ACCEPTED DELTAS #2 above.
        percentileBasis: "state",
        // Data vintage independent of fetch time — the mirror is a
        // frozen 2023 snapshot, not a live feed. UI surfaces this in
        // the BriefingSourceDetails dataset-vintage footer.
        upstreamDatasetVersion: EPA_EJSCREEN_DATASET_VERSION,
        blockGroupId: pickString(attrs, "ID"),
        stateName: pickString(attrs, "STATE_NAME"),
        population: pickNumber(attrs, "ACSTOTPOP"),
        demographicIndexPercentile: pickNumber(attrs, "P_DEMOGIDX_2"),
        supplementalDemographicIndexPercentile: pickNumber(
          attrs,
          "P_DEMOGIDX_5",
        ),
        pm25Percentile: pickNumber(attrs, "P_PM25"),
        ozonePercentile: pickNumber(attrs, "P_OZONE"),
        leadPaintPercentile: pickNumber(attrs, "P_LDPNT"),
        // Raw attributes verbatim — downstream readers (briefing
        // engine, CSV export, audit replay) get the full block-group
        // row without re-querying the upstream.
        raw: attrs,
      },
    };
  },
};
