/**
 * Hydrology worker client — spawns the pysheds Python sidecar or falls
 * back to the inline TypeScript D8 engine.
 */

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runHydrologyNative,
  type GeoJsonFeatureCollection,
  type HydrologyNativeInput,
} from "./hydrologyNative";

export interface HydrologyWorkerRequest {
  demBytes: ArrayBuffer;
  pourLng: number;
  pourLat: number;
  catchmentBbox: HydrologyNativeInput["catchmentBbox"];
  width: number;
  height: number;
  elevation: Float32Array;
  rainfallDepthMm?: number;
  accumulationThreshold?: number;
}

export interface HydrologyWorkerSuccess {
  status: "ok";
  library: string;
  libraryVersion: string;
  routing: string;
  accumulationThreshold: number;
  drainageZonesGeoJson: GeoJsonFeatureCollection;
  flowLinesGeoJson: GeoJsonFeatureCollection;
  rainfallResultGeoJson: GeoJsonFeatureCollection | null;
  pourPoint: { lng: number; lat: number };
  /** True when pysheds was unavailable and native D8 fallback ran. */
  fallbackUsed?: boolean;
  fallbackReason?: string;
}

export type HydrologyWorkerResult =
  | HydrologyWorkerSuccess
  | { status: "error"; code: string; message: string };

const WORKER_REL = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "artifacts",
  "hydrology-worker",
  "run.py",
);

const WORKER_TIMEOUT_MS = Number(process.env.HYDROLOGY_WORKER_TIMEOUT_MS ?? 45_000);

function resolvePythonBin(): string {
  return process.env.HYDROLOGY_PYTHON?.trim() || "python3";
}

function shouldPreferNative(): boolean {
  return (
    process.env.SITE_DRAINAGE_NATIVE === "1" ||
    process.env.NODE_ENV === "test" ||
    process.env.VITEST === "true"
  );
}

async function spawnPyshedsWorker(
  demPath: string,
  req: Omit<HydrologyWorkerRequest, "demBytes" | "width" | "height" | "elevation" | "catchmentBbox"> & {
    rainfallDepthMm?: number;
  },
): Promise<HydrologyWorkerResult> {
  const python = resolvePythonBin();
  const payload = JSON.stringify({
    demPath,
    pourLng: req.pourLng,
    pourLat: req.pourLat,
    rainfallDepthMm: req.rainfallDepthMm ?? 0,
    accumulationThreshold: req.accumulationThreshold ?? 50,
  });

  return new Promise((resolve) => {
    const child = spawn(python, [WORKER_REL], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({
        status: "error",
        code: "worker-timeout",
        message: `pysheds worker exceeded ${WORKER_TIMEOUT_MS}ms`,
      });
    }, WORKER_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: "error",
        code: "spawn-failed",
        message: err.message,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve({
          status: "error",
          code: "worker-exit",
          message: stderr || `python exited ${code}`,
        });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as HydrologyWorkerResult;
        resolve(parsed);
      } catch (err) {
        resolve({
          status: "error",
          code: "parse-failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
}

/** Run hydrology analysis (Python pysheds sidecar or native D8 fallback). */
export async function runHydrologyWorker(
  req: HydrologyWorkerRequest,
): Promise<HydrologyWorkerResult> {
  if (shouldPreferNative()) {
    const native = runHydrologyNative({
      width: req.width,
      height: req.height,
      elevation: req.elevation,
      catchmentBbox: req.catchmentBbox,
      pourLng: req.pourLng,
      pourLat: req.pourLat,
      rainfallDepthMm: req.rainfallDepthMm,
      accumulationThreshold: req.accumulationThreshold,
    });
    if (native.status === "error") {
      return {
        status: "error",
        code: native.code ?? "native-failed",
        message: native.message ?? "native D8 hydrology failed",
      };
    }
    return native;
  }

  let tmpDir: string | null = null;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), "hydrology-dem-"));
    const demPath = join(tmpDir, "dem.tif");
    await writeFile(demPath, Buffer.from(req.demBytes));
    const result = await spawnPyshedsWorker(demPath, req);
    if (result.status === "ok") return result;
    const native = runHydrologyNative({
      width: req.width,
      height: req.height,
      elevation: req.elevation,
      catchmentBbox: req.catchmentBbox,
      pourLng: req.pourLng,
      pourLat: req.pourLat,
      rainfallDepthMm: req.rainfallDepthMm,
      accumulationThreshold: req.accumulationThreshold,
    });
    if (native.status === "error") {
      return {
        status: "error",
        code: native.code ?? "native-fallback-failed",
        message: native.message ?? result.message,
      };
    }
    return {
      ...native,
      fallbackUsed: true,
      fallbackReason: result.message,
    } satisfies HydrologyWorkerSuccess;
  } catch (err) {
    return {
      status: "error",
      code: "worker-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
