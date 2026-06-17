/**
 * Cotality extended national data layers — Phases 1-3 of the full data-layer pack.
 *
 * Property (Carfax), climate (CRA AR6 + RiskMeter), hazards, replacement cost,
 * mineral (O&G SpatialRecord), utility (SpatialRecord UT).
 *
 * All adapters CLIP-join via {@link resolveCotalityClip}. Consumer extension
 * display is intentionally NOT wired — internal/dev-tier ingest only until
 * license terms clear.
 */

import { AdapterRunError, type Adapter, type AdapterContext, type AdapterResult } from "../types";
import {
  COTALITY_PROVIDER_LABEL,
  COTALITY_TIMEOUT_MS,
  cotalityAdapterMeta,
  cotalityAppliesGeocoded,
  cotalityGetWithApp,
  providerLabel,
  resolveCotalityClip,
  snapshotDateFromJson,
} from "./cotalityClient";

const COTALITY_AVM_MODEL =
  process.env.COTALITY_AVM_MODEL ?? "thvConsumers";

async function clipFor(ctx: AdapterContext, adapterKey: string) {
  return resolveCotalityClip({
    latitude: ctx.parcel.latitude,
    longitude: ctx.parcel.longitude,
    address: ctx.parcel.address ?? null,
    fetchImpl: ctx.fetchImpl,
    signal: ctx.signal,
    adapterKeyForLog: adapterKey,
  });
}

function pickRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** Extract flood depth @ return period + extreme precip fields for 40d sim handoff. */
export function extractClimateForcingFields(payload: Record<string, unknown>): {
  extremePrecip: Record<string, unknown>;
  floodDepthAtReturnPeriod: Record<string, unknown>;
} {
  const extremePrecip: Record<string, unknown> = {};
  const floodDepthAtReturnPeriod: Record<string, unknown> = {};

  const cra = pickRecord(payload.propertyCra ?? payload.cra);
  const perils = (cra.perils ?? cra.perilAnalytics ?? cra) as Record<
    string,
    unknown
  >;
  for (const [k, v] of Object.entries(perils)) {
    if (/precip|rain|storm|convective|severe/i.test(k) && v != null) {
      extremePrecip[k] = v;
    }
  }

  const rmClimate = pickRecord(payload.riskMeterClimate);
  const rmFlood = pickRecord(payload.riskMeterInlandFlood);
  const depthSources = [
    rmFlood,
    pickRecord(rmClimate.FLXX ?? rmClimate.flxx),
    pickRecord(rmClimate.inlandFlood),
  ];
  for (const src of depthSources) {
    for (const period of ["50", "100", "250", "500"]) {
      const key = `estimatedFloodDepth_${period}yr`;
      const val =
        src[`EstimatedFloodDepth_${period}`] ??
        src[`estimatedFloodDepth${period}Year`] ??
        src[`depth_${period}yr`] ??
        src[key];
      if (val != null) floodDepthAtReturnPeriod[key] = val;
    }
    const wse = src.WaterSurfaceElev ?? src.waterSurfaceElevation;
    const ge = src.GroundElev ?? src.groundElevation;
    if (wse != null) floodDepthAtReturnPeriod.waterSurfaceElevation = wse;
    if (ge != null) floodDepthAtReturnPeriod.groundElevation = ge;
  }

  return { extremePrecip, floodDepthAtReturnPeriod };
}

export const cotalityPropertyAdapter: Adapter = {
  adapterKey: "cotality:property",
  tier: "federal",
  sourceKind: "national-aggregator",
  layerKind: "cotality-property",
  provider: COTALITY_PROVIDER_LABEL,
  jurisdictionGate: {},
  timeoutMs: COTALITY_TIMEOUT_MS,
  appliesTo: cotalityAppliesGeocoded,
  async run(ctx): Promise<AdapterResult> {
    const clipCtx = await clipFor(ctx, this.adapterKey);
    const clip = clipCtx.clip;

    const [detail, avm, txHistory] = await Promise.all([
      cotalityGetWithApp({
        app: "property",
        path: `/${clip}/property-detail`,
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
        adapterKeyForLog: this.adapterKey,
        label: "property-detail",
      }),
      cotalityGetWithApp({
        app: "property",
        path: `/${clip}/avm/thv/${COTALITY_AVM_MODEL}/summary`,
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
        adapterKeyForLog: this.adapterKey,
        label: "property-avm",
      }).catch(() => null),
      cotalityGetWithApp({
        app: "property",
        path: `/${clip}/transaction-history`,
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
        adapterKeyForLog: this.adapterKey,
        label: "property-transaction-history",
      }).catch(() => null),
    ]);

    const detailRec = pickRecord(detail);
    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: providerLabel(clipCtx.county),
      snapshotDate: snapshotDateFromJson(detail),
      payload: {
        kind: "cotality-property",
        clip,
        propertyDetail: detailRec,
        avm: avm ?? null,
        transactionHistory: txHistory ?? null,
        ...cotalityAdapterMeta(this.adapterKey, "property"),
      },
    };
  },
};

export const cotalityClimateAdapter: Adapter = {
  adapterKey: "cotality:climate",
  tier: "federal",
  sourceKind: "national-aggregator",
  layerKind: "cotality-climate",
  provider: COTALITY_PROVIDER_LABEL,
  jurisdictionGate: {},
  timeoutMs: COTALITY_TIMEOUT_MS,
  appliesTo: cotalityAppliesGeocoded,
  async run(ctx): Promise<AdapterResult> {
    const clipCtx = await clipFor(ctx, this.adapterKey);
    const clip = clipCtx.clip;
    const lat = ctx.parcel.latitude;
    const lng = ctx.parcel.longitude;

    const propertyCra = await cotalityGetWithApp({
      app: "property",
      path: `/${clip}/climate-risk-analytics/ar6/comprehensive`,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      adapterKeyForLog: this.adapterKey,
      label: "property-cra-ar6",
    }).catch(() => null);

    const riskMeterClimate = await cotalityGetWithApp({
      app: "riskmeter",
      path: "/climate-risk",
      query: { clip, lat, lon: lng, latitude: lat, longitude: lng },
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      adapterKeyForLog: this.adapterKey,
      label: "riskmeter-climate-risk",
    }).catch(() => null);

    const riskMeterInlandFlood = await cotalityGetWithApp({
      app: "riskmeter",
      path: "/us-inland-flood-cat-model",
      query: { clip, lat, lon: lng, latitude: lat, longitude: lng },
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      adapterKeyForLog: this.adapterKey,
      label: "riskmeter-inland-flood",
    }).catch(() => null);

    if (!propertyCra && !riskMeterClimate && !riskMeterInlandFlood) {
      throw new AdapterRunError(
        "no-coverage",
        "Cotality climate endpoints returned no data (Property CRA + RiskMeter climate/flood).",
      );
    }

    const payloadBase = {
      kind: "cotality-climate",
      clip,
      propertyCra,
      riskMeterClimate,
      riskMeterInlandFlood,
      horizons: ["current", "2030", "2040", "2050"],
      scenarios: ["SSP1-2.6", "SSP2-4.5", "SSP5-8.5", "RCP"],
      ...cotalityAdapterMeta(this.adapterKey, "property"),
      riskMeterMeta: cotalityAdapterMeta(this.adapterKey, "riskmeter"),
    };
    const forcing = extractClimateForcingFields(payloadBase);

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: providerLabel(clipCtx.county),
      snapshotDate: snapshotDateFromJson(propertyCra ?? riskMeterClimate),
      payload: {
        ...payloadBase,
        extremePrecip: forcing.extremePrecip,
        floodDepthAtReturnPeriod: forcing.floodDepthAtReturnPeriod,
      },
    };
  },
};

const HAZARD_ENDPOINTS: ReadonlyArray<{
  key: string;
  path: string;
  label: string;
}> = [
  { key: "floodRiskScore", path: "/flood-risk-score", label: "flood-risk-score" },
  {
    key: "floodRiskScoreFfh",
    path: "/flood-risk-score-ffh",
    label: "flood-risk-score-ffh",
  },
  {
    key: "flashFloodRiskScore",
    path: "/flash-flood-risk-score",
    label: "flash-flood-risk-score",
  },
  {
    key: "usInlandFloodCatModel",
    path: "/us-inland-flood-cat-model",
    label: "us-inland-flood-cat-model",
  },
  { key: "wildfireRisk", path: "/wildfire-risk", label: "wildfire-risk" },
  { key: "hailRisk", path: "/hail-risk", label: "hail-risk" },
  { key: "windRiskScore", path: "/wind-risk-score", label: "wind-risk-score" },
  {
    key: "earthquakeRiskScore",
    path: "/earthquake-risk-score",
    label: "earthquake-risk-score",
  },
  {
    key: "floodZoneDetermination",
    path: "/flood-zone-determination",
    label: "flood-zone-determination",
  },
  { key: "firstFloorHeight", path: "/first-floor-height", label: "first-floor-height" },
];

export const cotalityHazardsAdapter: Adapter = {
  adapterKey: "cotality:hazards",
  tier: "federal",
  sourceKind: "national-aggregator",
  layerKind: "cotality-hazards",
  provider: COTALITY_PROVIDER_LABEL,
  jurisdictionGate: {},
  timeoutMs: COTALITY_TIMEOUT_MS,
  appliesTo: cotalityAppliesGeocoded,
  async run(ctx): Promise<AdapterResult> {
    const clipCtx = await clipFor(ctx, this.adapterKey);
    const query = {
      clip: clipCtx.clip,
      lat: ctx.parcel.latitude,
      lon: ctx.parcel.longitude,
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      address: ctx.parcel.address ?? undefined,
    };

    const perils: Record<string, unknown> = {};
    const errors: Record<string, string> = {};

    await Promise.all(
      HAZARD_ENDPOINTS.map(async (ep) => {
        try {
          perils[ep.key] = await cotalityGetWithApp({
            app: "riskmeter",
            path: ep.path,
            query,
            fetchImpl: ctx.fetchImpl,
            signal: ctx.signal,
            adapterKeyForLog: this.adapterKey,
            label: ep.label,
          });
        } catch (err) {
          errors[ep.key] =
            err instanceof Error ? err.message : String(err);
        }
      }),
    );

    const populated = Object.keys(perils).length;
    if (populated === 0) {
      throw new AdapterRunError(
        "no-coverage",
        "Cotality RiskMeter hazard endpoints returned no peril data for this parcel.",
      );
    }

    const inland = pickRecord(perils.usInlandFloodCatModel);
    const floodDepthAtReturnPeriod: Record<string, unknown> = {};
    for (const period of ["50", "100", "250", "500"]) {
      const val =
        inland[`EstimatedFloodDepth_${period}`] ??
        inland[`estimatedFloodDepth${period}Year`];
      if (val != null) {
        floodDepthAtReturnPeriod[`estimatedFloodDepth_${period}yr`] = val;
      }
    }

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: providerLabel(clipCtx.county),
      snapshotDate: new Date().toISOString(),
      payload: {
        kind: "cotality-hazards",
        clip: clipCtx.clip,
        perils,
        partialErrors: Object.keys(errors).length > 0 ? errors : undefined,
        floodDepthAtReturnPeriod,
        ...cotalityAdapterMeta(this.adapterKey, "riskmeter"),
      },
    };
  },
};

export const cotalityReplacementCostAdapter: Adapter = {
  adapterKey: "cotality:replacementcost",
  tier: "federal",
  sourceKind: "national-aggregator",
  layerKind: "cotality-replacement-cost",
  provider: COTALITY_PROVIDER_LABEL,
  jurisdictionGate: {},
  timeoutMs: COTALITY_TIMEOUT_MS,
  appliesTo: cotalityAppliesGeocoded,
  async run(ctx): Promise<AdapterResult> {
    const clipCtx = await clipFor(ctx, this.adapterKey);
    const query = {
      clip: clipCtx.clip,
      lat: ctx.parcel.latitude,
      lon: ctx.parcel.longitude,
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      address: ctx.parcel.address ?? undefined,
    };

    const [residential, commercial] = await Promise.all([
      cotalityGetWithApp({
        app: "riskmeter",
        path: "/residential-replacement-cost",
        query,
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
        adapterKeyForLog: this.adapterKey,
        label: "residential-replacement-cost",
      }).catch(() => null),
      cotalityGetWithApp({
        app: "riskmeter",
        path: "/commercial-replacement-cost",
        query,
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
        adapterKeyForLog: this.adapterKey,
        label: "commercial-replacement-cost",
      }).catch(() => null),
    ]);

    if (!residential && !commercial) {
      throw new AdapterRunError(
        "no-coverage",
        "Cotality RiskMeter replacement-cost endpoints returned no RCV data.",
      );
    }

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: providerLabel(clipCtx.county),
      snapshotDate: new Date().toISOString(),
      payload: {
        kind: "cotality-replacement-cost",
        clip: clipCtx.clip,
        residentialReplacementCost: residential,
        commercialReplacementCost: commercial,
        ...cotalityAdapterMeta(this.adapterKey, "riskmeter"),
      },
    };
  },
};

export const cotalityMineralAdapter: Adapter = {
  adapterKey: "cotality:mineral",
  tier: "federal",
  sourceKind: "national-aggregator",
  layerKind: "cotality-mineral",
  provider: COTALITY_PROVIDER_LABEL,
  jurisdictionGate: {},
  timeoutMs: COTALITY_TIMEOUT_MS,
  appliesTo: cotalityAppliesGeocoded,
  async run(ctx): Promise<AdapterResult> {
    const clipCtx = await clipFor(ctx, this.adapterKey);
    const tier =
      process.env.COTALITY_SPATIAL_OG_TIER ?? "SpatialRecordOGBasic";

    const json = await cotalityGetWithApp({
      app: "spatialtile",
      path: `/parcels/${tier}`,
      query: {
        lat: ctx.parcel.latitude,
        lon: ctx.parcel.longitude,
        latitude: ctx.parcel.latitude,
        longitude: ctx.parcel.longitude,
        clip: clipCtx.clip,
        pageNumber: 0,
        pageSize: 1,
        address: ctx.parcel.address ?? undefined,
      },
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      adapterKeyForLog: this.adapterKey,
      label: "spatialtile-og",
    });

    const rec = pickRecord(json);
    const hasData =
      (Array.isArray(rec.parcels) && rec.parcels.length > 0) ||
      (Array.isArray(rec.items) && rec.items.length > 0) ||
      rec.wells != null ||
      rec.leases != null;
    if (!hasData) {
      throw new AdapterRunError(
        "no-coverage",
        "Cotality Spatial Tile O&G record returned no mineral/lease/well data for this parcel.",
      );
    }

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: providerLabel(clipCtx.county),
      snapshotDate: snapshotDateFromJson(json),
      payload: {
        kind: "cotality-mineral",
        clip: clipCtx.clip,
        spatialRecordTier: tier,
        oilAndGas: json,
        reconciliationNote:
          "Operator has a separate existing O&G app — do not assume this Cotality SpatialRecord feed replaces it until reconciled.",
        ...cotalityAdapterMeta(this.adapterKey, "spatialtile"),
      },
    };
  },
};

export const cotalityUtilityAdapter: Adapter = {
  adapterKey: "cotality:utility",
  tier: "federal",
  sourceKind: "national-aggregator",
  layerKind: "cotality-utility",
  provider: COTALITY_PROVIDER_LABEL,
  jurisdictionGate: {},
  timeoutMs: COTALITY_TIMEOUT_MS,
  appliesTo: cotalityAppliesGeocoded,
  async run(ctx): Promise<AdapterResult> {
    const clipCtx = await clipFor(ctx, this.adapterKey);
    const tier =
      process.env.COTALITY_SPATIAL_UT_TIER ?? "SpatialRecordUTBasic";

    const json = await cotalityGetWithApp({
      app: "spatialtile",
      path: `/parcels/${tier}`,
      query: {
        lat: ctx.parcel.latitude,
        lon: ctx.parcel.longitude,
        latitude: ctx.parcel.latitude,
        longitude: ctx.parcel.longitude,
        clip: clipCtx.clip,
        pageNumber: 0,
        pageSize: 1,
        address: ctx.parcel.address ?? undefined,
      },
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      adapterKeyForLog: this.adapterKey,
      label: "spatialtile-utility",
    });

    const rec = pickRecord(json);
    const hasData =
      (Array.isArray(rec.parcels) && rec.parcels.length > 0) ||
      (Array.isArray(rec.items) && rec.items.length > 0) ||
      rec.utilities != null ||
      rec.infrastructure != null;
    if (!hasData) {
      throw new AdapterRunError(
        "no-coverage",
        "Cotality Spatial Tile utility record returned no infrastructure data for this parcel.",
      );
    }

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: providerLabel(clipCtx.county),
      snapshotDate: snapshotDateFromJson(json),
      payload: {
        kind: "cotality-utility",
        clip: clipCtx.clip,
        spatialRecordTier: tier,
        utilityInfrastructure: json,
        ...cotalityAdapterMeta(this.adapterKey, "spatialtile"),
      },
    };
  },
};

/** All extended Cotality adapters for registry import. */
export const COTALITY_EXTENDED_ADAPTERS = [
  cotalityPropertyAdapter,
  cotalityClimateAdapter,
  cotalityHazardsAdapter,
  cotalityReplacementCostAdapter,
  cotalityMineralAdapter,
  cotalityUtilityAdapter,
] as const;
