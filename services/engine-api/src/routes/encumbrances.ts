import { Hono } from "hono";
import { z } from "zod";

import {
  degradedCoverage,
  okCoverage,
  resolveReadPathConfidence,
} from "@hauska-engine/engine-core/envelope";
import { envelopeJson } from "../lib/envelopeResponse.js";

const encumbranceBodySchema = z.object({
  parcelId: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  address: z.string().optional(),
});

/**
 * Encumbrance query surface — v1 returns an honest empty state until
 * title/lien adapters wire through Cotality or county recorder feeds.
 */
export function buildEncumbrancesRoutes(): Hono {
  const app = new Hono();

  app.post("/query", async (c) => {
    const parsed = encumbranceBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", details: parsed.error.flatten() },
        400,
      );
    }

    const hasLocator =
      parsed.data.parcelId ||
      (parsed.data.latitude != null && parsed.data.longitude != null) ||
      parsed.data.address;

    if (!hasLocator) {
      return envelopeJson(
        c,
        {
          status: "empty",
          encumbrances: [],
          message: "parcel locator required (parcelId, lat/lng, or address)",
        },
        {
          confidence: resolveReadPathConfidence({ assertedBaseline: 0 }),
          dataVintage: null,
          coverage: degradedCoverage("missing parcel locator"),
          source: { adapter: "encumbrances:none" },
        },
      );
    }

    return envelopeJson(
      c,
      {
        status: "empty",
        encumbrances: [],
        message:
          "No encumbrance adapter configured on engine-api; title/lien feeds pending",
      },
      {
        confidence: resolveReadPathConfidence({ assertedBaseline: 0 }),
        dataVintage: null,
        coverage: degradedCoverage("encumbrance data source not configured"),
        source: { adapter: "encumbrances:unconfigured" },
      },
    );
  });

  return app;
}
