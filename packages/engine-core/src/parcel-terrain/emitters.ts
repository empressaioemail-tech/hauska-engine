import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveContoursGeoJson, type BboxWgs84, type ParsedDem } from "../site-topography/index.js";
import type { TerrainMeshGeometry } from "./mesh.js";

const text = new TextEncoder();

/**
 * AutoCAD 2000 DXF preamble shared by terrain emitters.
 *
 * Revit Import/Link CAD is pickier than AutoCAD: bare ENTITIES-only files and
 * LAYER rows that reference CONTINUOUS without an LTYPE table both trigger the
 * generic "ActiveX / proprietary components" dialog. Coordinates are
 * parcel-local ENU meters → $INSUNITS = 6 (meters).
 */
export function buildDxfPreamble(layers: readonly string[]): string[] {
  const uniqueLayers = [...new Set(layers.filter((name) => name && name !== "0"))];
  const lines = [
    "0",
    "SECTION",
    "2",
    "HEADER",
    "9",
    "$ACADVER",
    "1",
    "AC1015",
    "9",
    "$INSUNITS",
    "70",
    "6",
    "9",
    "$MEASUREMENT",
    "70",
    "1",
    "9",
    "$HANDSEED",
    "5",
    "FFFF",
    "0",
    "ENDSEC",
    "0",
    "SECTION",
    "2",
    "TABLES",
    // LTYPE must precede LAYER — layers reference CONTINUOUS.
    "0",
    "TABLE",
    "2",
    "LTYPE",
    "70",
    "1",
    "0",
    "LTYPE",
    "2",
    "CONTINUOUS",
    "70",
    "0",
    "3",
    "Solid line",
    "72",
    "65",
    "73",
    "0",
    "40",
    "0.0",
    "0",
    "ENDTAB",
    "0",
    "TABLE",
    "2",
    "LAYER",
    "70",
    `${uniqueLayers.length + 1}`,
    "0",
    "LAYER",
    "2",
    "0",
    "70",
    "0",
    "62",
    "7",
    "6",
    "CONTINUOUS",
  ];
  for (const layer of uniqueLayers) {
    lines.push("0", "LAYER", "2", layer, "70", "0", "62", "3", "6", "CONTINUOUS");
  }
  lines.push(
    "0",
    "ENDTAB",
    "0",
    "ENDSEC",
    // Empty BLOCKS section — required by several strict DXF readers (incl. Revit).
    "0",
    "SECTION",
    "2",
    "BLOCKS",
    "0",
    "ENDSEC",
  );
  return lines;
}

function finalizeDxf(lines: string[]): Uint8Array {
  return text.encode(`${lines.join("\n")}\n`);
}

export function emitDxf3dFace(geometry: TerrainMeshGeometry): Uint8Array {
  const lines = [
    ...buildDxfPreamble(["TERRAIN"]),
    "0",
    "SECTION",
    "2",
    "ENTITIES",
  ];
  for (let i = 0; i < geometry.indices.length; i += 3) {
    lines.push("0", "3DFACE", "8", "TERRAIN");
    for (let point = 0; point < 4; point++) {
      const index = geometry.indices[i + (point === 3 ? 2 : point)]! * 3;
      const code = point + 1;
      lines.push(
        `${10 + code - 1}`, `${geometry.positions[index]!}`,
        `${20 + code - 1}`, `${geometry.positions[index + 1]!}`,
        `${30 + code - 1}`, `${geometry.positions[index + 2]!}`,
      );
    }
  }
  lines.push("0", "ENDSEC", "0", "EOF");
  return finalizeDxf(lines);
}

/**
 * Reuses the engine's d3-contour marching-squares derivation. We remap its
 * WGS84 output into the mesh's local ENU frame and write classic 3D POLYLINE
 * + VERTEX entities (not LWPOLYLINE). Revit Site Plan Link/Import CAD is more
 * reliable with VERTEX Z (group 30) than elevated LWPOLYLINE (group 38).
 * Deliberately never emits faces.
 */
export function emitDxfContours(
  dem: ParsedDem,
  bbox: BboxWgs84,
  intervalMeters: number,
): { bytes: Uint8Array; polylineCount: number } {
  const { featureCollection } = deriveContoursGeoJson(dem, bbox, intervalMeters);
  const meanLat = ((bbox.southLat + bbox.northLat) / 2) * (Math.PI / 180);
  const metersPerLng = 111_320 * Math.cos(meanLat);
  const lines = [
    ...buildDxfPreamble(["TERRAIN_CONTOURS"]),
    "0",
    "SECTION",
    "2",
    "ENTITIES",
  ];
  let polylineCount = 0;
  for (const feature of featureCollection.features) {
    const elevation = feature.properties.elevationMeters;
    const polygons =
      feature.geometry.type === "MultiPolygon" ? feature.geometry.coordinates : [];
    for (const polygon of polygons) {
      for (const ring of polygon) {
        if (ring.length < 2) continue;
        // 70 = 1 (closed) + 8 (3D polyline)
        lines.push(
          "0",
          "POLYLINE",
          "8",
          "TERRAIN_CONTOURS",
          "66",
          "1",
          "70",
          "9",
          "10",
          "0.0",
          "20",
          "0.0",
          "30",
          "0.0",
        );
        for (const [lng, lat] of ring) {
          lines.push(
            "0",
            "VERTEX",
            "8",
            "TERRAIN_CONTOURS",
            "10",
            `${(lng - bbox.westLng) * metersPerLng}`,
            "20",
            `${(lat - bbox.southLat) * 111_320}`,
            "30",
            `${elevation}`,
            "70",
            "32",
          );
        }
        lines.push("0", "SEQEND", "8", "TERRAIN_CONTOURS");
        polylineCount++;
      }
    }
  }
  lines.push("0", "ENDSEC", "0", "EOF");
  return { bytes: finalizeDxf(lines), polylineCount };
}

export interface IfcWorkerResult {
  status: "ok" | "error";
  ifcText?: string;
  vertexCount?: number;
  triangleCount?: number;
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
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
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
