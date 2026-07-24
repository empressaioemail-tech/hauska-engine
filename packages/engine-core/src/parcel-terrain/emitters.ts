import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveContoursGeoJson, type BboxWgs84, type ParsedDem } from "../site-topography/index.js";
import type { TerrainMeshGeometry } from "./mesh.js";

const text = new TextEncoder();

export interface DxfWorkerResult {
  status: "ok" | "error";
  dxfText?: string;
  entityCount?: number;
  kind?: string;
  message?: string;
}

export interface ContourPolyline2d {
  elevation: number;
  points: Array<[number, number]>;
}

function dxfWorkerPath(): string {
  return (
    process.env.DXF_WORKER_PATH ??
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "artifacts", "dxf-worker", "run.py")
  );
}

function dxfPython(): string {
  return process.env.DXF_PYTHON ?? process.env.IFC_PYTHON ?? "python3";
}

async function runDxfWorker(input: unknown): Promise<DxfWorkerResult> {
  const workerPath = dxfWorkerPath();
  const python = dxfPython();
  const payload = JSON.stringify(input);
  return new Promise((resolve) => {
    const child = spawn(python, [workerPath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      resolve({ status: "error", message: "dxf worker timed out" });
    }, Number(process.env.DXF_WORKER_TIMEOUT_MS ?? 60_000));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ status: "error", message: error.message });
    });
    child.on("close", () => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(stdout) as DxfWorkerResult);
      } catch {
        resolve({ status: "error", message: stderr || "dxf worker returned invalid JSON" });
      }
    });
    child.stdin.end(payload);
  });
}

/**
 * Collect contour rings in parcel-local ENU meters for the DXF worker.
 * Geometry derivation stays in TypeScript; only the R2000 file write is
 * delegated to ezdxf (handles, BLOCK_RECORD, OBJECTS/LAYOUT).
 */
export function collectContourPolylines(
  dem: ParsedDem,
  bbox: BboxWgs84,
  intervalMeters: number,
): ContourPolyline2d[] {
  const { featureCollection } = deriveContoursGeoJson(dem, bbox, intervalMeters);
  const meanLat = ((bbox.southLat + bbox.northLat) / 2) * (Math.PI / 180);
  const metersPerLng = 111_320 * Math.cos(meanLat);
  const polylines: ContourPolyline2d[] = [];
  for (const feature of featureCollection.features) {
    const elevation = feature.properties.elevationMeters;
    const polygons =
      feature.geometry.type === "MultiPolygon" ? feature.geometry.coordinates : [];
    for (const polygon of polygons) {
      for (const ring of polygon) {
        if (ring.length < 2) continue;
        const points: Array<[number, number]> = ring.map(([lng, lat]) => [
          (lng - bbox.westLng) * metersPerLng,
          (lat - bbox.southLat) * 111_320,
        ]);
        polylines.push({ elevation, points });
      }
    }
  }
  return polylines;
}

export async function emitDxf3dFace(geometry: TerrainMeshGeometry): Promise<Uint8Array> {
  const result = await runDxfWorker({
    kind: "3dface",
    layer: "TERRAIN",
    positions: Array.from(geometry.positions),
    indices: Array.from(geometry.indices),
  });
  if (result.status !== "ok" || !result.dxfText) {
    throw new Error(`DXF 3DFACE emission failed: ${result.message ?? "unknown worker error"}`);
  }
  return text.encode(result.dxfText);
}

/**
 * Contour DXF via ezdxf R2000 writer. Never emits 3DFACE. Contours are closed
 * 3D POLYLINE + VERTEX (Z on each vertex), not LWPOLYLINE.
 */
export async function emitDxfContours(
  dem: ParsedDem,
  bbox: BboxWgs84,
  intervalMeters: number,
): Promise<{ bytes: Uint8Array; polylineCount: number }> {
  const polylines = collectContourPolylines(dem, bbox, intervalMeters);
  const result = await runDxfWorker({
    kind: "contours",
    layer: "TERRAIN_CONTOURS",
    polylines,
  });
  if (result.status !== "ok" || !result.dxfText) {
    throw new Error(`DXF contour emission failed: ${result.message ?? "unknown worker error"}`);
  }
  return {
    bytes: text.encode(result.dxfText),
    polylineCount: result.entityCount ?? polylines.length,
  };
}

export interface IfcSpatialValidation {
  IfcProject: number;
  IfcSite: number;
  IfcRelAggregates: number;
  IfcRelContainedInSpatialStructure: number;
  IfcLocalPlacement: number;
  IfcGeographicElement: number;
  IfcMapConversion: number;
  IfcProjectedCRS: number;
  projectAggregatesSite: boolean;
  siteContainsElement: boolean;
  elementHasPlacement: boolean;
  siteHasPlacement: boolean;
  ok: boolean;
  errors: string[];
}

export interface IfcWorkerResult {
  status: "ok" | "error";
  ifcText?: string;
  vertexCount?: number;
  triangleCount?: number;
  spatialValidation?: IfcSpatialValidation;
  message?: string;
}

export async function emitIfc(
  geometry: TerrainMeshGeometry,
  sourceCitation: string,
): Promise<IfcWorkerResult> {
  const workerPath =
    process.env.IFC_WORKER_PATH ??
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "artifacts", "ifc-worker", "run.py");
  const python = process.env.IFC_PYTHON ?? "python3";
  const input = JSON.stringify({
    positions: Array.from(geometry.positions),
    indices: Array.from(geometry.indices),
    georefOrigin: geometry.georefOrigin,
    crsConvention: geometry.crsConvention,
    provenance: { sourceCitation, hasHoles: geometry.hasHoles },
  });
  return new Promise((resolve) => {
    const child = spawn(python, [workerPath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      resolve({ status: "error", message: "ifc worker timed out" });
    }, Number(process.env.IFC_WORKER_TIMEOUT_MS ?? 45_000));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ status: "error", message: error.message });
    });
    child.on("close", () => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(stdout) as IfcWorkerResult);
      } catch {
        resolve({ status: "error", message: stderr || "ifc worker returned invalid JSON" });
      }
    });
    child.stdin.end(input);
  });
}
