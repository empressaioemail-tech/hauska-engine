import { Hono } from "hono";
import { z } from "zod";

import {
  fetchUsgs3depDem,
  selectAdaptiveResolutionMeters,
  DEFAULT_TERRAIN_RESOLUTION_METERS,
} from "@hauska-engine/adapters/topography";
import {
  deriveContoursGeoJson,
  parseDemBytes,
} from "@hauska-engine/engine-core/site-topography";
import {
  degradedCoverage,
  okCoverage,
  resolveReadPathConfidence,
} from "@hauska-engine/engine-core/envelope";
import { envelopeJson } from "../lib/envelopeResponse.js";

const contoursBodySchema = z.object({
  demBytesBase64: z.string().optional(),
  rawGrid: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      valuesBase64: z.string(),
    })
    .optional(),
  bbox: z.object({
    westLng: z.number(),
    southLat: z.number(),
    eastLng: z.number(),
    northLat: z.number(),
  }),
  intervalMeters: z.number().positive().optional(),
});

export function buildTopographyRoutes(): Hono {
  const app = new Hono();

  app.post("/contours", async (c) => {
    const parsed = contoursBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", details: parsed.error.flatten() },
        400,
      );
    }

    try {
      let dem;
      if (parsed.data.rawGrid) {
        const { width, height, valuesBase64 } = parsed.data.rawGrid;
        const buf = Buffer.from(valuesBase64, "base64");
        const values = new Float32Array(
          buf.buffer,
          buf.byteOffset,
          buf.byteLength / 4,
        );
        let min = Infinity;
        let max = -Infinity;
        let nodataCount = 0;
        for (let i = 0; i < values.length; i++) {
          const v = values[i]!;
          if (!Number.isFinite(v)) {
            nodataCount++;
            continue;
          }
          if (v < min) min = v;
          if (v > max) max = v;
        }
        dem = {
          width,
          height,
          values,
          minElevation: min,
          maxElevation: max,
          nodataCount,
        };
      } else if (parsed.data.demBytesBase64) {
        const bytes = Buffer.from(parsed.data.demBytesBase64, "base64");
        dem = await parseDemBytes(new Uint8Array(bytes));
      } else {
        return c.json({ error: "invalid_request", message: "demBytesBase64 or rawGrid required" }, 400);
      }
      const interval = parsed.data.intervalMeters ?? 1;
      const { featureCollection, thresholds } = deriveContoursGeoJson(
        dem,
        parsed.data.bbox,
        interval,
      );
      const nodataRatio = dem.nodataCount / (dem.width * dem.height);
      return envelopeJson(
        c,
        { featureCollection, thresholds, nodataCount: dem.nodataCount },
        {
          confidence: resolveReadPathConfidence({ deterministic: true }),
          dataVintage: null,
          coverage:
            nodataRatio > 0.05
              ? degradedCoverage(
                  `${Math.round(nodataRatio * 100)}% nodata cells masked from contours`,
                  true,
                )
              : okCoverage(),
          source: { adapter: "site-topography:contours" },
        },
      );
    } catch (err) {
      return envelopeJson(
        c,
        {
          status: "empty",
          featureCollection: { type: "FeatureCollection", features: [] },
          message: err instanceof Error ? err.message : String(err),
        },
        {
          confidence: resolveReadPathConfidence({ deterministic: true }),
          dataVintage: null,
          coverage: degradedCoverage("contour derivation failed"),
          source: { adapter: "site-topography:contours" },
        },
      );
    }
  });

  app.post("/dem", async (c) => {
    const parsed = z
      .object({
        bbox: contoursBodySchema.shape.bbox,
        resolutionMeters: z.number().positive().optional(),
      })
      .safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", details: parsed.error.flatten() },
        400,
      );
    }
    try {
      const requested = parsed.data.resolutionMeters ?? DEFAULT_TERRAIN_RESOLUTION_METERS;
      const { resolutionMetersAdapted } = selectAdaptiveResolutionMeters(
        parsed.data.bbox,
        requested,
      );
      const result = await fetchUsgs3depDem(parsed.data.bbox, {
        resolutionMeters: resolutionMetersAdapted,
      });
      return envelopeJson(
        c,
        {
          widthPx: result.widthPx,
          heightPx: result.heightPx,
          bbox: result.bbox,
          demBytesBase64: Buffer.from(result.bytes).toString("base64"),
          resolutionMetersRequested: requested,
          resolutionMetersAdapted,
        },
        {
          confidence: resolveReadPathConfidence({ deterministic: true }),
          dataVintage: result.fetchedAt,
          coverage: okCoverage(),
          source: { adapter: "usgs:3dep-dem" },
        },
      );
    } catch (err) {
      return c.json(
        {
          error: "dem_fetch_failed",
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  });

  return app;
}
