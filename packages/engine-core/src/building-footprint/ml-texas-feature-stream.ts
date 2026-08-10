/**
 * Stream features from Texas.geojson inside the legacy ML zip partition.
 * Uses stream-json v3 over yauzl entry read stream + NFHL backpressure queue.
 */

import { PassThrough, type Readable } from "node:stream";
import chain from "stream-chain";
import { parser } from "stream-json";
import { streamArray } from "stream-json/streamers/stream-array.js";
import type { ZipFile } from "yauzl";

import { ML_TEXAS_ZIP_ENTRY_NAME } from "./constants.js";
import type { GeoJsonFeatureLike } from "./stream-geojson-seq-backpressure.js";
import {
  STREAM_QUEUE_HIGH_WATER,
  STREAM_QUEUE_LOW_WATER,
  streamGeoJsonSeqWithBackpressure,
} from "./stream-geojson-seq-backpressure.js";

export interface StreamTexasMlFeaturesOptions {
  zipPath: string;
  highWaterMark?: number;
  lowWaterMark?: number;
  onQueueDepth?: (depth: number) => void;
  openZip?: (zipPath: string) => Promise<ZipFile>;
}

function openZipDefault(zipPath: string): Promise<ZipFile> {
  return import("yauzl").then(
    ({ open }) =>
      new Promise((resolve, reject) => {
        open(zipPath, { lazyEntries: true }, (err, zipfile) => {
          if (err || !zipfile) reject(err ?? new Error(`open failed: ${zipPath}`));
          else resolve(zipfile);
        });
      }),
  );
}

function openZipEntryReadStream(zipfile: ZipFile, entryName: string): Promise<Readable> {
  return new Promise((resolve, reject) => {
    let matched = false;
    zipfile.readEntry();
    zipfile.on("entry", (entry) => {
      if (entry.fileName === entryName) {
        matched = true;
        zipfile.openReadStream(entry, (err, stream) => {
          if (err || !stream) reject(err ?? new Error("openReadStream failed"));
          else resolve(stream);
        });
        return;
      }
      zipfile.readEntry();
    });
    zipfile.on("end", () => {
      if (!matched) {
        reject(new Error(`zip entry not found: ${entryName}`));
      }
    });
    zipfile.on("error", reject);
  });
}

function featureArrayToLineStream(arrayStream: Readable): Readable {
  const out = new PassThrough();
  arrayStream.on("data", (data: { key: number; value: unknown }) => {
    const line = JSON.stringify(data.value);
    if (!out.write(`${line}\n`)) {
      arrayStream.pause();
      out.once("drain", () => arrayStream.resume());
    }
  });
  arrayStream.on("end", () => out.end());
  arrayStream.on("error", (err: Error) => out.destroy(err));
  return out;
}

export async function* streamTexasMlFeatures(
  opts: StreamTexasMlFeaturesOptions,
): AsyncGenerator<GeoJsonFeatureLike> {
  const openZip = opts.openZip ?? openZipDefault;
  const zipfile = await openZip(opts.zipPath);
  let entryStream: Readable;
  try {
    entryStream = await openZipEntryReadStream(zipfile, ML_TEXAS_ZIP_ENTRY_NAME);
  } catch (err) {
    zipfile.close();
    throw err;
  }

  const jsonPipeline = chain([
    entryStream,
    parser(),
    streamArray(),
  ]) as Readable;

  const lineStream = featureArrayToLineStream(jsonPipeline);

  const closePromise = new Promise<{ code: number | null; spawnError: Error | null }>(
    (resolve) => {
      lineStream.on("end", () => resolve({ code: 0, spawnError: null }));
      lineStream.on("error", (spawnError) =>
        resolve({ code: 1, spawnError }),
      );
      entryStream.on("error", (spawnError) =>
        resolve({ code: 1, spawnError }),
      );
    },
  );

  try {
    yield* streamGeoJsonSeqWithBackpressure(lineStream, {
      highWaterMark: opts.highWaterMark ?? STREAM_QUEUE_HIGH_WATER,
      lowWaterMark: opts.lowWaterMark ?? STREAM_QUEUE_LOW_WATER,
      onQueueDepth: opts.onQueueDepth,
      onClose: closePromise,
    });
  } finally {
    zipfile.close();
  }
}

export interface StreamTexasMlStats {
  partitionsStreamed: number;
  featuresRead: number;
  peakQueueDepth: number;
}

export async function countTexasMlFeatures(
  opts: StreamTexasMlFeaturesOptions,
): Promise<StreamTexasMlStats> {
  let featuresRead = 0;
  let peakQueueDepth = 0;
  for await (const _ of streamTexasMlFeatures({
    ...opts,
    onQueueDepth: (d) => {
      if (d > peakQueueDepth) peakQueueDepth = d;
      opts.onQueueDepth?.(d);
    },
  })) {
    featuresRead += 1;
  }
  return {
    partitionsStreamed: 1,
    featuresRead,
    peakQueueDepth,
  };
}
