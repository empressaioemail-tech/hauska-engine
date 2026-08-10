/**
 * Bounded async bridge from a Readable producing GeoJSONSeq lines to an
 * async generator. Pauses the Readable when the queue hits highWaterMark
 * and resumes at lowWaterMark so producers cannot outrun slow consumers
 * (NFHL statewide apply OOM pattern — ldt #403).
 */

import type { Readable } from "node:stream";

export const STREAM_QUEUE_HIGH_WATER = 32;
export const STREAM_QUEUE_LOW_WATER = 8;

export interface GeoJsonFeatureLike {
  type?: string;
  geometry?: { type?: string; coordinates?: unknown };
  properties?: Record<string, unknown>;
  id?: string | number;
}

export async function* streamGeoJsonSeqWithBackpressure(
  stdout: Readable,
  opts: {
    highWaterMark?: number;
    lowWaterMark?: number;
    onClose?: Promise<{ code: number | null; spawnError: Error | null }>;
    onQueueDepth?: (depth: number) => void;
  } = {},
): AsyncGenerator<GeoJsonFeatureLike> {
  const highWater = opts.highWaterMark ?? STREAM_QUEUE_HIGH_WATER;
  const lowWater = opts.lowWaterMark ?? STREAM_QUEUE_LOW_WATER;
  if (highWater < 1) {
    throw new Error("highWaterMark must be >= 1");
  }
  if (lowWater < 0 || lowWater >= highWater) {
    throw new Error("lowWaterMark must satisfy 0 <= lowWaterMark < highWaterMark");
  }

  let buffer = "";
  const featureQueue: GeoJsonFeatureLike[] = [];
  let resolveNext: (() => void) | null = null;
  let done = false;
  let parseError: Error | null = null;
  let exitError: Error | null = null;
  let paused = false;

  function reportDepth(): void {
    opts.onQueueDepth?.(featureQueue.length);
  }

  function wake(): void {
    resolveNext?.();
    resolveNext = null;
  }

  function applyBackpressure(): void {
    if (!paused && featureQueue.length >= highWater) {
      stdout.pause();
      paused = true;
    }
  }

  function drainBuffer(): void {
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      if (featureQueue.length >= highWater) {
        applyBackpressure();
        return;
      }
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      pushFeature(line);
      if (parseError) return;
    }
  }

  function releaseBackpressure(): void {
    if (paused && featureQueue.length <= lowWater) {
      stdout.resume();
      paused = false;
      drainBuffer();
    }
  }

  function pushFeature(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) return;
    try {
      featureQueue.push(JSON.parse(trimmed) as GeoJsonFeatureLike);
      reportDepth();
      applyBackpressure();
      wake();
    } catch (err) {
      parseError =
        err instanceof Error
          ? err
          : new Error(`invalid GeoJSONSeq line: ${trimmed.slice(0, 120)}`);
      wake();
    }
  }

  stdout.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    drainBuffer();
  });

  stdout.on("end", () => {
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      pushFeature(line);
    }
    if (buffer.trim()) pushFeature(buffer);
    buffer = "";
    done = true;
    wake();
  });

  stdout.on("error", (err) => {
    parseError = err;
    done = true;
    wake();
  });

  if (opts.onClose) {
    void opts.onClose.then(({ code, spawnError }) => {
      if (spawnError) {
        parseError = spawnError;
      } else if (code !== 0 && code !== null) {
        exitError = new Error(`producer exited ${code}`);
      }
      done = true;
      wake();
    });
  }

  try {
    while (true) {
      if (parseError) throw parseError;
      if (exitError) throw exitError;
      if (featureQueue.length > 0) {
        const next = featureQueue.shift()!;
        reportDepth();
        releaseBackpressure();
        yield next;
        continue;
      }
      if (done) return;
      await new Promise<void>((resolveWait) => {
        resolveNext = resolveWait;
      });
    }
  } finally {
    if (paused) {
      stdout.resume();
      paused = false;
    }
  }
}
