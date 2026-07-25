import { runDxfWorker, runIfcWorker } from "../parcel-terrain/emitters.js";
import { TERRAIN_VERTICAL_DATUM } from "../parcel-terrain/elevation.js";
import type { TerrainMeshGeometry } from "../parcel-terrain/mesh.js";
import { buildTerrainSolidMass, type BuildTerrainSolidMassOptions } from "../parcel-terrain/solid-mass.js";
import type { LocalPoint } from "./ring-geometry.js";
import { anyNotSpecified } from "./setback-display.js";
import type { SitePlanModel } from "./site-model.js";

const text = new TextEncoder();

function meshMinZ(positions: Float32Array): number {
  let minZ = Infinity;
  for (let i = 2; i < positions.length; i += 3) {
    const z = positions[i]!;
    if (z < minZ) minZ = z;
  }
  return minZ;
}

function ring3(points: LocalPoint[], z: number): number[][] {
  return points.map((p) => [p.x, p.y, z]);
}

/**
 * Builds the DXF worker payload straight from the shared SitePlanModel — no
 * emitter derives its own geometry (WDLL item 2).
 */
export function buildDxfSitePlanRequest(model: SitePlanModel, mesh: TerrainMeshGeometry): Record<string, unknown> {
  const gradeZ = meshMinZ(mesh.positions);
  const dimensions = model.propertySegments.map((segment) => ({
    midpoint: [(segment.a.x + segment.b.x) / 2, (segment.a.y + segment.b.y) / 2, gradeZ],
    lengthFeet: segment.lengthFeet,
    citation: model.citations.propertyLine,
  }));
  const silentAxes = anyNotSpecified(model.setback.notSpecified);
  const setbackSegments = model.setback.segments.map((segment, index) => {
    const notSpecified = !!segment.notSpecified;
    let label: string;
    if (notSpecified) {
      label = `${segment.role.toUpperCase()} not specified — build-to-line governs`;
    } else if (segment.role === "unassigned" && silentAxes) {
      // Uniform-min geometry may inset every edge by the min specified axis;
      // do not print "UNASSIGNED 15 ft" as if S/R were also 15. One legend line.
      label = index === 0 ? model.setback.displayLine : "";
    } else {
      label = `${segment.role.toUpperCase()} ${segment.distanceFt} ft`;
    }
    return {
      midpoint: [(segment.a.x + segment.b.x) / 2, (segment.a.y + segment.b.y) / 2, gradeZ],
      role: segment.role,
      distanceFt: segment.distanceFt,
      notSpecified,
      label,
      citation: model.citations.setback,
    };
  });

  return {
    kind: "site_plan",
    verticalDatum: TERRAIN_VERTICAL_DATUM,
    gradeZ,
    textHeight: Math.max(0.2, Math.min(model.scaleBar.lengthMeters * 0.05, 1)),
    propertyLine: {
      points: ring3(model.ringLocal, gradeZ),
      citation: model.citations.propertyLine,
    },
    dimensions,
    setback: {
      offsetPoints: model.setback.offsetRingLocal ? ring3(model.setback.offsetRingLocal, gradeZ) : null,
      segments: setbackSegments,
      displayLine: model.setback.displayLine,
      notSpecified: model.setback.notSpecified ?? null,
      degenerate: model.setback.degenerate,
      degenerateReason: model.setback.degenerateReason ?? null,
      citation: model.citations.setback,
    },
    contours: model.contours.map((polyline) => ({
      elevation: polyline.elevation,
      points: polyline.points,
      citation: model.citations.contour,
    })),
    elevationLabels: model.elevationLabels.map((label) => ({
      point: [label.point.x, label.point.y, label.elevationMeters],
      elevationMeters: label.elevationMeters,
      citation: model.citations.contour,
    })),
    street: {
      anchors: model.streets.anchors.map((anchor) => ({
        name: anchor.name,
        points: anchor.pointsLocal.map((p) => [p.x, p.y]),
        citation: anchor.sourceRef ?? anchor.name,
      })),
      honestAbsence: model.streets.honestAbsence,
      reason: model.streets.reason ?? null,
    },
    north: {
      origin: [model.north.originLocal.x, model.north.originLocal.y],
      direction: [model.north.directionLocal.x, model.north.directionLocal.y],
      lengthMeters: model.north.lengthMeters,
    },
    scaleBar: {
      origin: [model.north.originLocal.x, model.north.originLocal.y - model.north.lengthMeters * 0.5],
      lengthMeters: model.scaleBar.lengthMeters,
    },
  };
}

export interface DxfSitePlanResult {
  bytes: Uint8Array;
  entityCount: number;
}

export async function emitDxfSitePlan(
  model: SitePlanModel,
  mesh: TerrainMeshGeometry,
): Promise<DxfSitePlanResult> {
  const request = buildDxfSitePlanRequest(model, mesh);
  const result = await runDxfWorker(request);
  if (result.status !== "ok" || !result.dxfText) {
    throw new Error(`DXF site-plan emission failed: ${result.message ?? "unknown worker error"}`);
  }
  if (!result.dxfText.includes("NAVD88")) {
    throw new Error("DXF site-plan missing NAVD88 vertical-datum declaration");
  }
  for (const layer of ["PROPERTY_LINE", "DIMENSION", "SETBACK", "CONTOUR", "ELEVATION_LABEL", "STREET", "NORTH"]) {
    if (!result.dxfText.includes(layer)) {
      throw new Error(`DXF site-plan missing required layer ${layer}`);
    }
  }
  return { bytes: text.encode(result.dxfText), entityCount: result.entityCount ?? 0 };
}

export interface IfcSitePlanResult {
  status: "ok" | "error";
  ifcText?: string;
  vertexCount?: number;
  triangleCount?: number;
  annotationCount?: number;
  message?: string;
  spatialValidation?: Record<string, unknown>;
  /** Diagnostic only: the grade Z the worker actually used for STREET
   * annotations this run. Must equal the same `gradeZ` passed to the DXF
   * worker and baked into PROPERTY_LINE/SETBACK — see HOLD 2. */
  streetGradeZ?: number;
}

/**
 * Builds the closed terrain solid mass in TypeScript (tested independently
 * in solid-mass.test.ts) and hands the IFC worker an already-watertight
 * mesh plus the site-plan annotation layers — the worker's job is IFC
 * entity construction, not geometry math.
 */
export async function emitIfcSitePlan(
  model: SitePlanModel,
  mesh: TerrainMeshGeometry,
  sourceCitation: string,
  solidMassOptions: BuildTerrainSolidMassOptions = {},
): Promise<IfcSitePlanResult> {
  const solid = buildTerrainSolidMass(mesh, solidMassOptions);
  const gradeZ = meshMinZ(mesh.positions);

  const result = await runIfcWorker({
    kind: "site_plan",
    positions: Array.from(solid.positions),
    indices: Array.from(solid.indices),
    georefOrigin: mesh.georefOrigin,
    crsConvention: mesh.crsConvention,
    verticalDatum: TERRAIN_VERTICAL_DATUM,
    provenance: { sourceCitation, hasHoles: mesh.hasHoles },
    solidMass: { skirtDepthMeters: solid.skirtDepthMeters, bottomZ: solid.bottomZ, minZ: solid.minZ },
    // Same grade Z the DXF worker gets and PROPERTY_LINE/SETBACK are already
    // baked to (via ring3 above) — STREET anchors arrive as 2D [x,y] pairs
    // and need the worker to add a Z; it must be this one, not a 0.0
    // default, or the shared-model same-source rule breaks for IFC STREET.
    gradeZ,
    propertyLine: {
      points: ring3(model.ringLocal, gradeZ),
      citation: model.citations.propertyLine,
    },
    setback: model.setback.offsetRingLocal
      ? { points: ring3(model.setback.offsetRingLocal, gradeZ), citation: model.citations.setback }
      : null,
    contours: model.contours.map((polyline) => ({
      elevation: polyline.elevation,
      points: polyline.points,
      citation: model.citations.contour,
    })),
    street: model.streets.honestAbsence
      ? null
      : model.streets.anchors.map((anchor) => ({
          name: anchor.name,
          points: anchor.pointsLocal.map((p) => [p.x, p.y]),
          citation: anchor.sourceRef ?? anchor.name,
        })),
  }) as unknown as IfcSitePlanResult;

  return result;
}
