/**
 * Map layer assembly — gate-fronted spine capability (75i task 11).
 *
 * Lifts the cortex-api `generate-layers` layer geometry assembly to a
 * shared engine-api endpoint consumable by Cortex, the extension,
 * SmartCity, and Mox through hauska-mcp-server.
 */

import { Hono } from "hono";

import {
  ALL_ADAPTERS,
  DEFAULT_ADAPTER_TIMEOUT_MS,
  filterApplicableAdapters,
  runAdapters,
  type AdapterContext,
  type AdapterJurisdiction,
  type AdapterRunOutcome,
} from "@hauska-engine/adapters";
import {
  aggregateMapLayersCoverage,
  assembleMapLayers,
  mapLayersAssembleRequestSchema,
  vintageFromMapLayers,
  type MapLayerAdapterOutcome,
} from "@hauska-engine/engine-core/map-layers";
import { resolveReadPathConfidence } from "@hauska-engine/engine-core/envelope";
import { envelopeJson } from "../lib/envelopeResponse.js";
import { resolveWave3MapLayerSlot } from "../lib/mapLayersWave3.js";

function toMapLayerAdapterOutcomes(
  outcomes: AdapterRunOutcome[],
): MapLayerAdapterOutcome[] {
  return outcomes.map((o) => ({
    adapterKey: o.adapterKey,
    layerKind: o.layerKind,
    status: o.status,
    result: o.result,
    error: o.error,
  }));
}

export function buildMapLayersRoutes(): Hono {
  const app = new Hono();

  app.get("/contract", (c) =>
    envelopeJson(
      c,
      {
        capability: "map-layers",
        version: "2026-06-17",
        packageId: "map-layers",
        endpoint: "POST /v1/map-layers/assemble",
        layerKeys: [
          "parcel-polygon",
          "flood-zone",
          "floodway",
          "dem",
          "topography",
          "topography-1ft",
          "hydrology-flow",
          "opportunity-zone-tract",
          "zoning",
        ],
        gateExposure: {
          owner: "cc-agent-M",
          packageId: "map-layers",
          accessTiers: ["public-paid", "platform-internal", "tenant-private"],
          notes:
            "Max-tier map render; gate enforces tenantId + product + accessPolicy before proxying",
        },
        consumer: {
          owner: "cc-agent-C",
          surfaces: [
            "cortex-api BFF (replaces engagement generate-layers geometry fan-out)",
            "brief-extension map render",
            "SmartCity parcel view",
            "Mox portfolio map",
          ],
          migration:
            "Point ENGINE_API_BASE_URL assemble call; persist briefing_sources in cortex until storage lifts",
        },
        pendingWave3: [],
      },
      {
        confidence: resolveReadPathConfidence({ deterministic: true }),
        dataVintage: null,
        coverage: { degraded: false },
        source: { adapter: "map-layers:contract" },
      },
    ),
  );

  app.post("/assemble", async (c) => {
    const parsed = mapLayersAssembleRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", details: parsed.error.flatten() },
        400,
      );
    }

    const gateFront = c.get("gateFront");
    const request = parsed.data;

    const latitude = request.parcel.latitude;
    const longitude = request.parcel.longitude;
    const context: AdapterContext = {
      parcel: {
        latitude,
        longitude,
        address: request.parcel.address,
      },
      jurisdiction: request.jurisdiction as AdapterJurisdiction,
      timeoutMs: DEFAULT_ADAPTER_TIMEOUT_MS,
    };

    const { payload } = await assembleMapLayers(
      request,
      {
        tenantId: gateFront.tenantId,
        product: gateFront.product,
        requestId: gateFront.requestId,
      },
      {
        runAdapterOutcomes: async (req, adapterKeys) => {
          const selected = ALL_ADAPTERS.filter((a) =>
            adapterKeys.includes(a.adapterKey),
          );
          const runContext: AdapterContext = {
            ...context,
            parcel: {
              latitude: req.parcel.latitude,
              longitude: req.parcel.longitude,
              address: req.parcel.address,
            },
            jurisdiction: req.jurisdiction as AdapterJurisdiction,
          };
          const applicable = filterApplicableAdapters(runContext, selected);

          if (applicable.length === 0) {
            return toMapLayerAdapterOutcomes(
              selected.map((a) => ({
                adapterKey: a.adapterKey,
                tier: a.tier,
                layerKind: a.layerKind,
                status: "no-coverage" as const,
                fromCache: false,
                cachedAt: null,
                error: {
                  code: "no-coverage" as const,
                  message: "adapter not applicable for parcel/jurisdiction",
                },
              })),
            );
          }

          return toMapLayerAdapterOutcomes(
            await runAdapters({
              adapters: applicable,
              context: runContext,
              forceRefresh: req.forceRefresh ?? false,
            }),
          );
        },
        resolveWave3Slot: (layerKey, req, outcomesByKey) =>
          resolveWave3MapLayerSlot(layerKey, req, outcomesByKey),
      },
    );

    return envelopeJson(c, payload, {
      confidence: resolveReadPathConfidence({ deterministic: true }),
      dataVintage: vintageFromMapLayers(payload.layers),
      coverage: aggregateMapLayersCoverage(payload.layers),
      source: {
        adapter: "map-layers:assemble",
        citationIds: payload.layers
          .filter((l) => l.status === "ok")
          .map((l) => l.layerKey),
      },
    });
  });

  return app;
}
