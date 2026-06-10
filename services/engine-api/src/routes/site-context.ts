/**
 * Site-context adapter routes — gate-fronted entry for the lifted
 * `@hauska-engine/adapters` package (sprint 56 step 3 / GTM A1).
 *
 * Persistence (briefing_sources rows) stays in cortex-api for now; this
 * route returns runner outcomes only so engine-core and the gate can
 * invoke adapters without reaching cortex-api in-process.
 */

import { Hono } from "hono";
import { z } from "zod";

import {
  ALL_ADAPTERS,
  DEFAULT_ADAPTER_TIMEOUT_MS,
  filterApplicableAdapters,
  hasApplicableAdapters,
  noApplicableAdaptersMessage,
  runAdapters,
  type AdapterContext,
  type AdapterJurisdiction,
  type AdapterRunOutcome,
} from "@hauska-engine/adapters";

const parcelSchema = z.object({
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  address: z.string().nullable().optional(),
});

const jurisdictionSchema = z.object({
  stateKey: z.enum(["utah", "idaho", "texas"]).nullable(),
  localKey: z
    .enum(["grand-county-ut", "lemhi-county-id", "bastrop-tx"])
    .nullable(),
  partnerCity: z.boolean().optional(),
});

const runAdaptersBodySchema = z.object({
  parcel: parcelSchema,
  jurisdiction: jurisdictionSchema,
  forceRefresh: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export function buildSiteContextRoutes(): Hono {
  const app = new Hono();

  app.get("/registry", (c) =>
    c.json({
      adapterCount: ALL_ADAPTERS.length,
      adapters: ALL_ADAPTERS.map((a) => ({
        adapterKey: a.adapterKey,
        tier: a.tier,
        layerKind: a.layerKind,
        sourceKind: a.sourceKind,
        provider: a.provider,
      })),
    }),
  );

  app.post("/run-adapters", async (c) => {
    const parsed = runAdaptersBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", details: parsed.error.flatten() },
        400,
      );
    }

    const { parcel, jurisdiction, forceRefresh, timeoutMs } = parsed.data;
    const latitude = parcel.latitude ?? Number.NaN;
    const longitude = parcel.longitude ?? Number.NaN;
    const context: AdapterContext = {
      parcel: {
        latitude,
        longitude,
        address: parcel.address,
      },
      jurisdiction: jurisdiction as AdapterJurisdiction,
      timeoutMs: timeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS,
    };

    const hasGeocode =
      Number.isFinite(latitude) && Number.isFinite(longitude);

    if (!hasApplicableAdapters(context)) {
      return c.json(
        {
          error: "no_applicable_adapters",
          message: noApplicableAdaptersMessage({ jurisdiction, hasGeocode }),
        },
        422,
      );
    }

    const applicable = filterApplicableAdapters(context);
    const outcomes: AdapterRunOutcome[] = await runAdapters({
      adapters: applicable,
      context,
      forceRefresh: forceRefresh ?? false,
    });

    return c.json({ outcomes });
  });

  return app;
}
