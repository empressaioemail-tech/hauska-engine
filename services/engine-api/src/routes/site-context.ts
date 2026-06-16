/**
 * Site-context adapter routes — gate-fronted entry for the lifted
 * `@hauska-engine/adapters` package (sprint 56 step 3 / GTM A1).
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
import {
  degradedCoverage,
  okCoverage,
  resolveReadPathConfidence,
} from "@hauska-engine/engine-core/envelope";
import { envelopeJson } from "../lib/envelopeResponse.js";

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

const placeBodySchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  address: z.string().nullable().optional(),
});

function vintageFromOutcomes(
  outcomes: ReadonlyArray<AdapterRunOutcome>,
): string | null {
  const dates = outcomes
    .filter((o) => o.status === "ok" && o.result?.snapshotDate)
    .map((o) => o.result!.snapshotDate);
  return dates.sort().at(-1) ?? null;
}

export function buildSiteContextRoutes(): Hono {
  const app = new Hono();

  app.get("/registry", (c) =>
    envelopeJson(
      c,
      {
        adapterCount: ALL_ADAPTERS.length,
        adapters: ALL_ADAPTERS.map((a) => ({
          adapterKey: a.adapterKey,
          tier: a.tier,
          layerKind: a.layerKind,
          sourceKind: a.sourceKind,
          provider: a.provider,
        })),
      },
      {
        confidence: resolveReadPathConfidence({ deterministic: true }),
        dataVintage: null,
        coverage: okCoverage(),
        source: { adapter: "site-context:registry" },
      },
    ),
  );

  app.post("/place", async (c) => {
    const parsed = placeBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", details: parsed.error.flatten() },
        400,
      );
    }

    const { latitude, longitude, address } = parsed.data;
    return envelopeJson(
      c,
      {
        place: {
          latitude,
          longitude,
          formattedAddress:
            address ??
            `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`,
          source: address ? "request-address" : "coordinates",
        },
      },
      {
        confidence: resolveReadPathConfidence({ deterministic: true }),
        dataVintage: null,
        coverage: address ? okCoverage() : degradedCoverage("place resolved from coordinates only", true),
        source: { adapter: "site-context:place" },
      },
    );
  });

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
      return envelopeJson(
        c,
        {
          status: "empty",
          outcomes: [],
          message: noApplicableAdaptersMessage({ jurisdiction, hasGeocode }),
        },
        {
          confidence: resolveReadPathConfidence({ deterministic: true }),
          dataVintage: null,
          coverage: degradedCoverage("no applicable adapters for jurisdiction/geocode"),
          source: { adapter: "site-context:run-adapters" },
        },
      );
    }

    const applicable = filterApplicableAdapters(context);
    const outcomes: AdapterRunOutcome[] = await runAdapters({
      adapters: applicable,
      context,
      forceRefresh: forceRefresh ?? false,
    });

    const failed = outcomes.filter((o) => o.status !== "ok");
    const coverage =
      failed.length > 0
        ? degradedCoverage(
            `${failed.length}/${outcomes.length} adapter(s) failed or timed out`,
            failed.length < outcomes.length,
          )
        : okCoverage();

    return envelopeJson(
      c,
      { outcomes },
      {
        confidence: resolveReadPathConfidence({ deterministic: true }),
        dataVintage: vintageFromOutcomes(outcomes),
        coverage,
        source: {
          adapter: "site-context:run-adapters",
          citationIds: outcomes
            .filter((o) => o.status === "ok")
            .map((o) => o.adapterKey),
        },
      },
    );
  });

  return app;
}
