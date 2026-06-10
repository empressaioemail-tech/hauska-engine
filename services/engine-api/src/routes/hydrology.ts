import { Hono } from "hono";
import { z } from "zod";

import { runHydrologyWorker } from "@hauska-engine/adapters/hydrology";
import { fetchUsgs3depDem } from "@hauska-engine/adapters/topography";
import { resolveRainfallForcing } from "@hauska-engine/adapters/hydrology";

const bboxSchema = z.object({
  westLng: z.number(),
  southLat: z.number(),
  eastLng: z.number(),
  northLat: z.number(),
});

const demBodySchema = z.object({
  bbox: bboxSchema,
  resolutionMeters: z.number().positive().optional(),
});

const drainageBodySchema = z.object({
  demBytesBase64: z.string(),
  pourLng: z.number(),
  pourLat: z.number(),
  catchmentBbox: bboxSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  rainfallDepthMm: z.number().optional(),
  accumulationThreshold: z.number().optional(),
});

const rainfallBodySchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  manualDepthMm: z.number().optional(),
});

export function buildHydrologyRoutes(): Hono {
  const app = new Hono();

  app.post("/dem", async (c) => {
    const parsed = demBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", details: parsed.error.flatten() },
        400,
      );
    }
    try {
      const result = await fetchUsgs3depDem(parsed.data.bbox, {
        resolutionMeters: parsed.data.resolutionMeters ?? 10,
      });
      return c.json({
        widthPx: result.widthPx,
        heightPx: result.heightPx,
        bbox: result.bbox,
        demBytesBase64: Buffer.from(result.bytes).toString("base64"),
      });
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

  app.post("/drainage", async (c) => {
    const parsed = drainageBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", details: parsed.error.flatten() },
        400,
      );
    }
    const demBytes = Buffer.from(parsed.data.demBytesBase64, "base64");
    const elevation = new Float32Array(
      demBytes.buffer,
      demBytes.byteOffset,
      demBytes.byteLength / 4,
    );
    const result = await runHydrologyWorker({
      demBytes: demBytes.buffer.slice(
        demBytes.byteOffset,
        demBytes.byteOffset + demBytes.byteLength,
      ),
      pourLng: parsed.data.pourLng,
      pourLat: parsed.data.pourLat,
      catchmentBbox: parsed.data.catchmentBbox,
      width: parsed.data.width,
      height: parsed.data.height,
      elevation,
      rainfallDepthMm: parsed.data.rainfallDepthMm,
      accumulationThreshold: parsed.data.accumulationThreshold,
    });
    return c.json(result);
  });

  app.post("/rainfall-forcing", async (c) => {
    const parsed = rainfallBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", details: parsed.error.flatten() },
        400,
      );
    }
    const result = await resolveRainfallForcing({
      lat: parsed.data.latitude,
      lng: parsed.data.longitude,
      manualDepthInches: parsed.data.manualDepthMm
        ? parsed.data.manualDepthMm / 25.4
        : undefined,
    });
    return c.json(result);
  });

  return app;
}
