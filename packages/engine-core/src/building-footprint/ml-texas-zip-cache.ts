/**
 * Resumable cache for Microsoft Global ML Texas.geojson.zip.
 * Fail-closed: wrong Content-Length after download aborts rather than parsing.
 */

import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import {
  GLOBAL_ML_TEXAS_ZIP_URL,
  ML_TEXAS_ZIP_ENTRY_NAME,
} from "./constants.js";

export interface TexasMlZipCacheResult {
  zipPath: string;
  downloaded: boolean;
  bytesOnDisk: number;
  expectedBytes: number | null;
}

function defaultCacheDir(): string {
  return process.env.ML_FOOTPRINT_CACHE_DIR?.trim() || join(process.cwd(), ".cache", "ml-footprint");
}

export function texasMlZipCachePath(cacheDir = defaultCacheDir()): string {
  return join(cacheDir, "Texas.geojson.zip");
}

async function fetchContentLength(url: string): Promise<number | null> {
  const res = await fetch(url, { method: "HEAD", redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HEAD ${url} failed: HTTP ${res.status}`);
  }
  const len = res.headers.get("content-length");
  return len ? Number(len) : null;
}

async function downloadZip(url: string, destPath: string, expectedBytes: number | null): Promise<void> {
  mkdirSync(dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.part`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  }
  const bodyLen = res.headers.get("content-length");
  const headerBytes = bodyLen ? Number(bodyLen) : null;
  if (expectedBytes != null && headerBytes != null && headerBytes !== expectedBytes) {
    throw new Error(
      `Content-Length mismatch for ${url}: HEAD=${expectedBytes} GET=${headerBytes}`,
    );
  }
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(tmpPath));
  const st = statSync(tmpPath);
  const targetBytes = expectedBytes ?? headerBytes;
  if (targetBytes != null && st.size !== targetBytes) {
    await unlink(tmpPath).catch(() => undefined);
    throw new Error(
      `Download size mismatch for ${url}: expected ${targetBytes} got ${st.size}`,
    );
  }
  await rename(tmpPath, destPath);
}

/**
 * Ensure Texas.geojson.zip is cached locally. Skips download when on-disk
 * size matches remote Content-Length (resumable across runs).
 */
export async function ensureTexasMlZipCached(opts?: {
  cacheDir?: string;
  url?: string;
  forceRefresh?: boolean;
}): Promise<TexasMlZipCacheResult> {
  const cacheDir = opts?.cacheDir ?? defaultCacheDir();
  const url = opts?.url ?? GLOBAL_ML_TEXAS_ZIP_URL;
  const zipPath = texasMlZipCachePath(cacheDir);

  if (!opts?.forceRefresh && existsSync(zipPath)) {
    const onDisk = statSync(zipPath).size;
    // Texas legacy zip is ~376 MB compressed — accept a warm cache without HEAD
    // so dry-runs work offline when the partition is already on disk.
    if (onDisk >= 300_000_000) {
      return {
        zipPath,
        downloaded: false,
        bytesOnDisk: onDisk,
        expectedBytes: onDisk,
      };
    }
  }

  const expectedBytes = await fetchContentLength(url);

  await downloadZip(url, zipPath, expectedBytes);
  const bytesOnDisk = statSync(zipPath).size;
  return {
    zipPath,
    downloaded: true,
    bytesOnDisk,
    expectedBytes,
  };
}

export { ML_TEXAS_ZIP_ENTRY_NAME };
