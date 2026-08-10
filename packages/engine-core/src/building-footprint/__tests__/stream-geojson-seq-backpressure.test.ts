import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  STREAM_QUEUE_HIGH_WATER,
  streamGeoJsonSeqWithBackpressure,
} from "../stream-geojson-seq-backpressure.js";

describe("streamGeoJsonSeqWithBackpressure", () => {
  function featureLine(id: number): string {
    return JSON.stringify({
      type: "Feature",
      properties: { id },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-97.8, 30.1],
            [-97.79, 30.1],
            [-97.79, 30.11],
            [-97.8, 30.11],
            [-97.8, 30.1],
          ],
        ],
      },
    });
  }

  function makeGatedProducer(total: number): Readable {
    let nextId = 0;
    const stream = new Readable({
      read() {
        while (nextId < total && !this.isPaused()) {
          const ok = this.push(featureLine(nextId++) + "\n");
          if (!ok) break;
        }
        if (nextId >= total) {
          this.push(null);
        }
      },
    });
    return stream;
  }

  it("keeps queue depth near highWaterMark under a slow consumer", async () => {
    const highWater = 4;
    const lowWater = 1;
    const total = 60;
    const stream = makeGatedProducer(total);
    let yielded = 0;
    let peakDepth = 0;
    let pauseCalls = 0;
    const origPause = stream.pause.bind(stream);
    stream.pause = ((...args: []) => {
      pauseCalls += 1;
      return origPause(...args);
    }) as typeof stream.pause;

    for await (const _ of streamGeoJsonSeqWithBackpressure(stream, {
      highWaterMark: highWater,
      lowWaterMark: lowWater,
      onQueueDepth: (d) => {
        if (d > peakDepth) peakDepth = d;
      },
    })) {
      yielded += 1;
      await new Promise((r) => setTimeout(r, 2));
    }

    expect(yielded).toBe(total);
    expect(pauseCalls).toBeGreaterThan(0);
    expect(peakDepth).toBeLessThanOrEqual(highWater + 1);
    expect(peakDepth).toBeLessThan(total / 2);
  });

  it("defaults to NFHL high-water 32", () => {
    expect(STREAM_QUEUE_HIGH_WATER).toBe(32);
  });
});
