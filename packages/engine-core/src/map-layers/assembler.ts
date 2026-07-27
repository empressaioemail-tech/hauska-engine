import type { MapLayerAdapterOutcome } from "./adapterOutcome.js";

import {
  degradedCoverage,
  okCoverage,
  resolveReadPathConfidence,
  sealEnvelope,
  type EngineEnvelope,
} from "../envelope/index.js";
import {
  MAP_LAYER_KEYS,
  type MapLayerGeometryPayload,
  type MapLayerKey,
  type MapLayerSlot,
  type MapLayersAssemblePayload,
  type MapLayersAssembleRequest,
  type MapLayersAssembleResult,
} from "./contract.js";
import { adapterKeysForMapLayers, specForLayer } from "./layerSpecs.js";

export interface MapLayersAssembleContext {
  tenantId: string;
  product: string;
  requestId: string;
}

function defaultParcelKey(req: MapLayersAssembleRequest): string {
  if (req.parcel.parcelKey) return req.parcel.parcelKey;
  const { latitude, longitude } = req.parcel;
  return `coord:${latitude.toFixed(6)},${longitude.toFixed(6)}`;
}

function outcomeByAdapterKey(
  outcomes: ReadonlyArray<MapLayerAdapterOutcome>,
): Map<string, MapLayerAdapterOutcome> {
  const map = new Map<string, MapLayerAdapterOutcome>();
  for (const o of outcomes) {
    map.set(o.adapterKey, o);
  }
  return map;
}

function payloadFromAdapterOutcome(
  outcome: MapLayerAdapterOutcome,
): MapLayerGeometryPayload | null {
  if (outcome.status !== "ok" || !outcome.result) return null;
  const { payload, provider, snapshotDate } = outcome.result;
  const kind =
    typeof payload.kind === "string" ? payload.kind : outcome.layerKind;
  const geojson =
    payload.parcel ??
    payload.zoning ??
    payload.features ??
    payload.geometry ??
    payload.geojson ??
    undefined;
  return {
    kind,
    geojson,
    attributes: payload as Record<string, unknown>,
    provider,
    snapshotDate,
    note: outcome.result.note,
  };
}

function hasRenderableGeometry(body: MapLayerGeometryPayload): boolean {
  const g = body.geojson;
  if (g == null) return false;
  if (typeof g !== "object") return false;
  const obj = g as Record<string, unknown>;
  if (obj.type === "FeatureCollection") {
    const features = obj.features;
    return Array.isArray(features) && features.length > 0;
  }
  if (obj.type === "Feature") {
    const geom = obj.geometry as Record<string, unknown> | undefined;
    if (!geom) return false;
    const coords = geom.coordinates;
    return Array.isArray(coords) && coords.length > 0;
  }
  if (obj.geometry && typeof obj.geometry === "object") {
    const coords = (obj.geometry as Record<string, unknown>).coordinates;
    return Array.isArray(coords) && coords.length > 0;
  }
  if (Array.isArray(obj.coordinates) && obj.coordinates.length > 0) {
    return true;
  }
  return false;
}

function envelopeFromOutcome(
  outcome: MapLayerAdapterOutcome,
  layerKey: MapLayerKey,
): EngineEnvelope<MapLayerGeometryPayload> {
  if (outcome.status === "ok" && outcome.result) {
    const body = payloadFromAdapterOutcome(outcome)!;
    return sealEnvelope(body, {
      confidence: resolveReadPathConfidence({ deterministic: true }),
      dataVintage: outcome.result.snapshotDate ?? null,
      coverage: okCoverage(),
      source: {
        adapter: outcome.adapterKey,
        citationIds: [layerKey],
      },
    });
  }

  const reason =
    outcome.error?.message ??
    (outcome.status === "no-coverage"
      ? "adapter does not cover this parcel"
      : outcome.status === "dead-expected"
        ? "adapter intentionally retired (dead-expected)"
        : "adapter run failed");

  return sealEnvelope(
    {
      kind: layerKey,
      note: reason,
    },
    {
      confidence: resolveReadPathConfidence({ deterministic: true }),
      dataVintage: null,
      coverage: degradedCoverage(reason),
      source: { adapter: outcome.adapterKey },
    },
  );
}

function pendingSlot(
  layerKey: MapLayerKey,
  reason: string,
): MapLayerSlot {
  return {
    layerKey,
    status: "pending",
    pendingReason: reason,
    envelope: sealEnvelope(
      { kind: layerKey, note: reason },
      {
        confidence: resolveReadPathConfidence({ deterministic: true }),
        dataVintage: null,
        coverage: degradedCoverage(reason),
        source: { adapter: `map-layers:${layerKey}` },
      },
    ),
  };
}

function slotFromSpec(
  layerKey: MapLayerKey,
  outcomesByKey: Map<string, MapLayerAdapterOutcome>,
): MapLayerSlot {
  const spec = specForLayer(layerKey);

  const adapterKeys = spec.adapterKeys ?? [];
  let chosen: MapLayerAdapterOutcome | undefined;
  for (const key of adapterKeys) {
    const hit = outcomesByKey.get(key);
    if (hit?.status === "ok") {
      chosen = hit;
      break;
    }
    if (!chosen) chosen = hit;
  }

  if (!chosen) {
    if (spec.requiresGeometry) {
      return pendingSlot(
        layerKey,
        spec.pendingReason ??
          `Cotality adapter did not run for ${layerKey}`,
      );
    }
    return {
      layerKey,
      status: "no-coverage",
      envelope: sealEnvelope(
        { kind: layerKey, note: "no adapter outcome" },
        {
          confidence: resolveReadPathConfidence({ deterministic: true }),
          dataVintage: null,
          coverage: degradedCoverage("no adapter registered for layer"),
          source: { adapter: `map-layers:${layerKey}` },
        },
      ),
    };
  }

  if (chosen.status === "ok") {
    const body = payloadFromAdapterOutcome(chosen);
    if (
      spec.requiresGeometry &&
      (!body || !hasRenderableGeometry(body))
    ) {
      const reason =
        spec.pendingReason ??
        `Cotality returned no geometry for ${layerKey}`;
      return pendingSlot(layerKey, reason);
    }
    return {
      layerKey,
      status: "ok",
      adapterKey: chosen.adapterKey,
      envelope: envelopeFromOutcome(chosen, layerKey),
    };
  }

  if (spec.requiresGeometry) {
    const reason =
      chosen.error?.message ??
      spec.pendingReason ??
      `Cotality did not return geometry for ${layerKey}`;
    return pendingSlot(layerKey, reason);
  }

  return {
    layerKey,
    status:
      chosen.status === "no-coverage"
        ? "no-coverage"
        : chosen.status === "dead-expected"
          ? "dead-expected"
          : "failed",
    adapterKey: chosen.adapterKey,
    error: chosen.error
      ? { code: chosen.error.code, message: chosen.error.message }
      : undefined,
    envelope: envelopeFromOutcome(chosen, layerKey),
  };
}

export interface MapLayersAssemblerDeps {
  runAdapterOutcomes: (
    request: MapLayersAssembleRequest,
    adapterKeys: string[],
  ) => Promise<MapLayerAdapterOutcome[]>;
  /** Wave-3 geometry slots (floodway, dem, topography, OZ tract). */
  resolveWave3Slot?: (
    layerKey: MapLayerKey,
    request: MapLayersAssembleRequest,
    outcomesByKey: Map<string, MapLayerAdapterOutcome>,
  ) => Promise<MapLayerSlot>;
}

export async function assembleMapLayers(
  request: MapLayersAssembleRequest,
  ctx: MapLayersAssembleContext,
  deps: MapLayersAssemblerDeps,
): Promise<MapLayersAssembleResult> {
  const layerKeys = request.layers ?? [...MAP_LAYER_KEYS];
  const adapterKeys = adapterKeysForMapLayers(layerKeys);
  const outcomes =
    adapterKeys.length > 0
      ? await deps.runAdapterOutcomes(request, adapterKeys)
      : [];
  const outcomesByKey = outcomeByAdapterKey(outcomes);

  const layers = await Promise.all(
    layerKeys.map(async (layerKey) => {
      const spec = specForLayer(layerKey);
      if (spec.wave3 && deps.resolveWave3Slot) {
        return deps.resolveWave3Slot(layerKey, request, outcomesByKey);
      }
      return slotFromSpec(layerKey, outcomesByKey);
    }),
  );

  const okLayers = layers.filter((l) => l.status === "ok");
  const failedLayers = layers.filter(
    (l) =>
      l.status === "failed" ||
      l.status === "no-coverage" ||
      l.status === "dead-expected",
  );
  const pendingLayers = layers.filter((l) => l.status === "pending");

  const payload: MapLayersAssemblePayload = {
    parcelKey: defaultParcelKey(request),
    place: {
      latitude: request.parcel.latitude,
      longitude: request.parcel.longitude,
      formattedAddress: request.parcel.address ?? null,
    },
    tenantScope: ctx.tenantId,
    layers,
    assembledAt: new Date().toISOString(),
  };

  return { payload };
}

/** Aggregate coverage for the outer assemble envelope. */
export function aggregateMapLayersCoverage(
  layers: ReadonlyArray<MapLayerSlot>,
): ReturnType<typeof okCoverage> | ReturnType<typeof degradedCoverage> {
  const pending = layers.filter((l) => l.status === "pending").length;
  const failed = layers.filter(
    (l) =>
      l.status === "failed" ||
      l.status === "no-coverage" ||
      l.status === "dead-expected",
  ).length;
  const ok = layers.filter((l) => l.status === "ok").length;

  if (ok === 0 && failed > 0) {
    return degradedCoverage(`${failed} layer(s) failed or uncovered`);
  }
  if (pending > 0 || failed > 0) {
    return degradedCoverage(
      `partial: ${ok} ok, ${pending} pending wave-3, ${failed} failed/uncovered`,
      true,
    );
  }
  return okCoverage();
}

export function vintageFromMapLayers(
  layers: ReadonlyArray<MapLayerSlot>,
): string | null {
  const dates = layers
    .filter((l) => l.status === "ok" && l.envelope?.dataVintage)
    .map((l) => l.envelope!.dataVintage as string);
  return dates.sort().at(-1) ?? null;
}
