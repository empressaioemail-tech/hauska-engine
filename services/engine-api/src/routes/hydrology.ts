import { Hono } from "hono";
import { z } from "zod";

import { runHydrologyWorker } from "@hauska-engine/adapters/hydrology";
import {
  fetchUsgs3depDem,
  selectAdaptiveResolutionMeters,
  DEFAULT_TERRAIN_RESOLUTION_METERS,
} from "@hauska-engine/adapters/topography";
import { resolveRainfallForcing } from "@hauska-engine/adapters/hydrology";
import {
  degradedCoverage,
  okCoverage,
  resolveReadPathConfidence,
} from "@hauska-engine/engine-core/envelope";
import { envelopeJson } from "../lib/envelopeResponse.js";

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

/**
 * Drainage-grid cell cap (qa/topo-fidelity-1ft, 2026-07-27).
 *
 * Raised from 256² (65,536) to 512² (262,144). With the terrain path now
 * fetching ~1m 3DEP (MOVE 1), the DEM feeding hydrology is 4-10x finer; the old
 * 256² downsample threw most of that resolution away before D8/flow-accumulation
 * ran, so finer flow lines and drainage delineation needed this cap raised too.
 *
 * TRADEOFF: pysheds D8 + flow-accumulation is ~O(cells) in both time and memory
 * (several Float32/Int arrays per cell). 512² is 4x the cells of 256² — a
 * defensible bound that materially sharpens flow lines while staying well inside
 * a single Cloud Run worker's time/memory envelope. We did NOT uncap or jump to
 * 1024² (16x): a 16x compute/memory blow-up risks worker OOM/timeout on large
 * catchments for diminishing visual return. Ops can tune via
 * HYDROLOGY_MAX_DRAINAGE_CELLS without a code change; the value is clamped to a
 * hard 1024² ceiling so a misconfig cannot uncap the worker.
 */
const HYDROLOGY_MAX_DRAINAGE_CELLS_DEFAULT = 512 * 512;
const HYDROLOGY_MAX_DRAINAGE_CELLS_CEILING = 1024 * 1024;

function resolveMaxDrainageCells(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.HYDROLOGY_MAX_DRAINAGE_CELLS);
  if (!Number.isFinite(raw) || raw <= 0) return HYDROLOGY_MAX_DRAINAGE_CELLS_DEFAULT;
  return Math.min(Math.floor(raw), HYDROLOGY_MAX_DRAINAGE_CELLS_CEILING);
}

const MAX_DRAINAGE_CELLS = resolveMaxDrainageCells();

function downsampleElevation(
  elevation: Float32Array,
  width: number,
  height: number,
): { elevation: Float32Array; width: number; height: number } {
  const cells = width * height;
  if (cells <= MAX_DRAINAGE_CELLS) {
    return { elevation, width, height };
  }
  const scale = Math.ceil(Math.sqrt(cells / MAX_DRAINAGE_CELLS));
  const outW = Math.max(8, Math.floor(width / scale));
  const outH = Math.max(8, Math.floor(height / scale));
  const out = new Float32Array(outW * outH);
  for (let row = 0; row < outH; row++) {
    for (let col = 0; col < outW; col++) {
      const srcCol = Math.min(width - 1, col * scale);
      const srcRow = Math.min(height - 1, row * scale);
      out[row * outW + col] = elevation[srcRow * width + srcCol]!;
    }
  }
  return { elevation: out, width: outW, height: outH };
}

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
      // Default to ~1m (3DEP serves it) and auto-relax coarser for large
      // catchment bboxes so the finer DEM feeds D8/flow-accumulation where it
      // fits the pixel cap, without ever failing hard on a big extent.
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
          dataVintage: result.fetchedAt ?? null,
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

  app.post("/drainage", async (c) => {
    const parsed = drainageBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", details: parsed.error.flatten() },
        400,
      );
    }
    const demBytes = Buffer.from(parsed.data.demBytesBase64, "base64");
    let elevation = new Float32Array(
      demBytes.buffer,
      demBytes.byteOffset,
      demBytes.byteLength / 4,
    );
    let width = parsed.data.width;
    let height = parsed.data.height;
    const downsampled = downsampleElevation(elevation, width, height);
    elevation = downsampled.elevation;
    width = downsampled.width;
    height = downsampled.height;

    const result = await runHydrologyWorker({
      demBytes: demBytes.buffer.slice(
        demBytes.byteOffset,
        demBytes.byteOffset + demBytes.byteLength,
      ),
      pourLng: parsed.data.pourLng,
      pourLat: parsed.data.pourLat,
      catchmentBbox: parsed.data.catchmentBbox,
      width,
      height,
      elevation,
      rainfallDepthMm: parsed.data.rainfallDepthMm,
      accumulationThreshold: parsed.data.accumulationThreshold,
    });

    if (result.status === "error") {
      return envelopeJson(
        c,
        { status: "error", error: result },
        {
          confidence: resolveReadPathConfidence({ deterministic: true }),
          dataVintage: null,
          coverage: degradedCoverage(result.message),
          source: { adapter: "hydrology:drainage" },
        },
      );
    }

    const coverage =
      result.fallbackUsed
        ? degradedCoverage(
            result.fallbackReason ?? "pysheds unavailable; native D8 fallback",
          )
        : okCoverage();

    return envelopeJson(
      c,
      result,
      {
        confidence: resolveReadPathConfidence({ deterministic: true }),
        dataVintage: null,
        coverage,
        source: { adapter: `hydrology:${result.library}` },
      },
    );
  });

  app.post("/rainfall-forcing", async (c) => {
    const parsed = rainfallBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", details: parsed.error.flatten() },
        400,
      );
    }
    try {
      const result = await resolveRainfallForcing({
        lat: parsed.data.latitude,
        lng: parsed.data.longitude,
        manualDepthInches: parsed.data.manualDepthMm
          ? parsed.data.manualDepthMm / 25.4
          : undefined,
      });
      const degraded = result.kind !== "noaa-atlas-14";
      return envelopeJson(
        c,
        result,
        {
          confidence: resolveReadPathConfidence({ deterministic: true }),
          dataVintage:
            result.kind === "noaa-atlas-14" ? result.estimate.fetchedAt : null,
          coverage: degraded
            ? degradedCoverage("rainfall forcing used non-Atlas source or manual override")
            : okCoverage(),
          source: { adapter: `rainfall-forcing:${result.kind}` },
        },
      );
    } catch (err) {
      return envelopeJson(
        c,
        {
          status: "empty",
          message: err instanceof Error ? err.message : String(err),
        },
        {
          confidence: resolveReadPathConfidence({ deterministic: true }),
          dataVintage: null,
          coverage: degradedCoverage("rainfall forcing fetch failed"),
          source: { adapter: "rainfall-forcing:noaa-atlas-14" },
        },
      );
    }
  });

  return app;
}
