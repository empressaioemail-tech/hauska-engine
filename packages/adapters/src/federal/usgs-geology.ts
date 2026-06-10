/**
 * USGS State Geologic Map Compilation (SGMC) — federal geology adapter.
 *
 * The SGMC geodatabase is published as an ArcGIS FeatureServer covering
 * the conterminous United States. A point intersect yields the surficial /
 * bedrock formation name, lithology major class, and age range.
 *
 * Alaska, Hawaii, territories, and offshore parcels outside the SGMC
 * extent emit a deterministic `no-coverage` verdict.
 */

import { arcgisPointQuery } from "../arcgis";
import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";
import {
  federalGeocodeApplies,
  isConterminousUsLatLng,
} from "./_federalGeocodeGate";

export const USGS_SGMC_GEOLOGY_LAYER =
  "https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/SB_5888bf4fe4b05ccb964bab9d_USGS_SGMC_feature/FeatureServer/3";

export const USGS_GEOLOGY_PROVIDER_LABEL =
  "USGS State Geologic Map Compilation (SGMC)";

/** SGMC v1.1 (2017) with periodic errata — 24-month freshness window. */
export const USGS_GEOLOGY_FRESHNESS_THRESHOLD_MONTHS = 24;

function nowIso(): string {
  return new Date().toISOString();
}

function pickString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pickNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export const usgsGeologyAdapter: Adapter = {
  adapterKey: "usgs:geology",
  tier: "federal",
  sourceKind: "federal-adapter",
  layerKind: "usgs-geology",
  provider: USGS_GEOLOGY_PROVIDER_LABEL,
  jurisdictionGate: {},
  appliesTo(ctx) {
    return (
      federalGeocodeApplies(ctx) &&
      isConterminousUsLatLng(ctx.parcel.latitude, ctx.parcel.longitude)
    );
  },
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await arcgisPointQuery({
      serviceUrl: USGS_SGMC_GEOLOGY_LAYER,
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      outFields:
        "STATE,SGMC_LABEL,UNIT_NAME,MAJOR1,MAJOR2,MINOR1,AGE_MIN,AGE_MAX,ROCKTYPE1,ROCKTYPE2",
      returnGeometry: false,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      upstreamLabel: "USGS SGMC",
    });

    if (result.features.length === 0) {
      throw new AdapterRunError(
        "no-coverage",
        "No SGMC geologic map unit is mapped at this location.",
      );
    }

    const attrs = result.features[0].attributes;
    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: {
        kind: "geology-formation",
        state: pickString(attrs.STATE),
        mapUnitLabel: pickString(attrs.SGMC_LABEL),
        unitName: pickString(attrs.UNIT_NAME),
        majorLithology1: pickString(attrs.MAJOR1),
        majorLithology2: pickString(attrs.MAJOR2),
        minorLithology1: pickString(attrs.MINOR1),
        rockType1: pickString(attrs.ROCKTYPE1),
        rockType2: pickString(attrs.ROCKTYPE2),
        ageMinMa: pickNumber(attrs.AGE_MIN),
        ageMaxMa: pickNumber(attrs.AGE_MAX),
        features: result.features,
      },
    };
  },
};
