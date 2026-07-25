import { createHash } from "node:crypto";

import {
  fetchUsgs3depDem,
  selectAdaptiveResolutionMeters,
  type BboxWgs84,
} from "@hauska-engine/adapters";
import type { ParcelTerrainModelAtomInstance } from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import { parseDemBytes, type ParsedDem } from "../site-topography/index.js";
import { assertTerrainElevationIntegrity, TERRAIN_VERTICAL_DATUM } from "./elevation.js";
import { emitDxf3dFace, emitDxfContours, emitIfc } from "./emitters.js";
import { buildTerrainMeshGeometry, emitGlb } from "./mesh.js";


export interface ResolvedParcelGeometry {
  bbox: BboxWgs84;
  sourceRef: string;
  /**
   * Exterior boundary ring in WGS84 [lng, lat] pairs, closed or open (first
   * point need not repeat last). Optional: bbox-only resolvers (unchanged
   * legacy behavior) omit it, and any site-plan PROPERTY_LINE consumer must
   * fail closed rather than approximate a ring from the bbox rectangle.
   */
  ring?: Array<[number, number]>;
}

export interface ParcelGeometryResolver {
  resolve(parcelNodeId: string): Promise<ResolvedParcelGeometry | null>;
}

export interface TerrainArtifactStore {
  put(input: { parcelNodeId: string; format: string; bytes: Uint8Array; contentType: string }): Promise<string>;
}

export interface AuthorParcelTerrainExportOptions {
  parcelNodeId: string;
  /** Interim test/operator override until a county_fips:prop_id polygon store is wired. */
  bboxOverride?: BboxWgs84;
  resolver: ParcelGeometryResolver;
  storage: StoragePort;
  artifactStore: TerrainArtifactStore;
  resolutionMeters?: number;
  contourIntervalMeters?: number;
  fetchDem?: typeof fetchUsgs3depDem;
  parseDem?: (bytes: Uint8Array) => Promise<ParsedDem>;
  emitIfc?: typeof emitIfc;
}

function checksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Authors a single paid terrain-export atom. There is no jurisdiction-specific
 * branch: geometry is resolved by parcel node id through the injected spine
 * resolver, while bboxOverride is an explicitly documented test interim.
 */
export async function authorParcelTerrainExport(
  options: AuthorParcelTerrainExportOptions,
): Promise<ParcelTerrainModelAtomInstance> {
  const resolved = options.bboxOverride
    ? { bbox: options.bboxOverride, sourceRef: "request:bbox-override" }
    : await options.resolver.resolve(options.parcelNodeId);
  if (!resolved) {
    throw new Error(
      `Parcel geometry unavailable for ${options.parcelNodeId}; configure a spine place/gold-bake resolver or supply bboxOverride for a test.`,
    );
  }
  const fetchedAt = new Date().toISOString();
  const resolutionMetersRequested = options.resolutionMeters ?? 10;
  const { resolutionMetersAdapted } = selectAdaptiveResolutionMeters(
    resolved.bbox,
    resolutionMetersRequested,
  );
  const contourIntervalMeters = options.contourIntervalMeters ?? 1;
  const fetchDem = options.fetchDem ?? fetchUsgs3depDem;
  const demFetch = await fetchDem(resolved.bbox, { resolutionMeters: resolutionMetersAdapted });
  const resolutionAdaptedNote =
    resolutionMetersAdapted !== resolutionMetersRequested
      ? `; DEM fetch auto-tightened to ${resolutionMetersAdapted}m/px (requested ${resolutionMetersRequested}m/px for 16px floor)`
      : "";
  const dem = await (options.parseDem ?? parseDemBytes)(demFetch.bytes);
  const mesh = buildTerrainMeshGeometry(dem, resolved.bbox);
  const elev = assertTerrainElevationIntegrity(mesh, dem);

  const artifacts: ParcelTerrainModelAtomInstance["artifacts"] = {};
  const persist = async (
    format: "glb" | "ifc" | "dxf-3dface" | "dxf-contour",
    bytes: Uint8Array,
    contentType: string,
    extra: Record<string, number> = {},
  ) => {
    artifacts[format] = {
      format,
      ref: await options.artifactStore.put({ parcelNodeId: options.parcelNodeId, format, bytes, contentType }),
      byteCount: bytes.byteLength,
      ...extra,
    };
  };

  await persist("glb", await emitGlb(mesh), "model/gltf-binary", {
    vertexCount: mesh.vertexCount,
    triangleCount: mesh.triangleCount,
  });
  await persist("dxf-3dface", await emitDxf3dFace(mesh), "application/dxf", {
    vertexCount: mesh.vertexCount,
    triangleCount: mesh.triangleCount,
  });
  const contours = await emitDxfContours(dem, resolved.bbox, contourIntervalMeters);
  await persist("dxf-contour", contours.bytes, "application/dxf", {
    contourIntervalMeters,
    contourPolylineCount: contours.polylineCount,
  });



  const ifc = await (options.emitIfc ?? emitIfc)(mesh, "USGS 3DEP");
  if (ifc.status !== "ok" || !ifc.ifcText) {
    throw new Error(`IFC4 emission failed: ${ifc.message ?? "unknown worker error"}`);
  }
  if (!ifc.spatialValidation?.ok) {
    throw new Error(
      `IFC4 spatial model incomplete (refusing to ship empty Project tree): ${
        ifc.spatialValidation?.errors?.join("; ") ?? ifc.message ?? "validation missing"
      }`,
    );
  }
  await persist("ifc", new TextEncoder().encode(ifc.ifcText), "application/step", {
    vertexCount: ifc.vertexCount ?? mesh.vertexCount,
    triangleCount: ifc.triangleCount ?? mesh.triangleCount,
  });

  artifacts["landxml-tin"] = {
    format: "landxml-tin",
    ref: "deferred:landxml-tin",
    deferred: true,
    deferredReason:
      "LandXML TIN writer is deferred; when shipped, CoordinateSystem must set " +
      `verticalDatum=${TERRAIN_VERTICAL_DATUM.name} (orthometric ${TERRAIN_VERTICAL_DATUM.units}).`,
  };


  const atom: ParcelTerrainModelAtomInstance = {
    entityType: "parcel-terrain-model",
    atomDid: `pterrain_${checksum(`${options.parcelNodeId}:${fetchedAt}`).slice(0, 16)}`,
    entityId: options.parcelNodeId,
    parcelNodeId: options.parcelNodeId,
    jurisdictionTenant: "property-spine",
    fetchedAt,
    extractedAt: fetchedAt,
    sourceAdapter: "usgs:3dep-dem",
    sourceUrl: demFetch.endpoint,
    sourceCitation: "USGS 3DEP",
    accessPolicy: "public-paid",
    atomTier: "data",
    status: "active",
    contentHash: "",
    reasoningChain: {
      reasoningKind: "derived",
      derivationMethod: "parcel-terrain-mesh-ifc-v1",
      inputAtomRefs: [{ atomDid: resolved.sourceRef, role: "reference-field", citationLabel: "usgs-3dep-dem" }],
    },
    artifacts,
    coverage: {
      coverageFraction: 1 - dem.nodataCount / (dem.width * dem.height),
      nodataCount: dem.nodataCount,
      totalCells: dem.width * dem.height,
      resolutionMetersRequested,
      resolutionMetersActual: demFetch.resolutionMetersActual,
      touchesNodata: dem.nodataCount > 0,
    },
    confidence: {
      value: 0.6,
      kind: "asserted",
      provenance:
        `USGS 3DEP DEM field; Z=${TERRAIN_VERTICAL_DATUM.summary}; ` +
        `mesh Z band [${elev.minZ.toFixed(3)}, ${elev.maxZ.toFixed(3)}] m; ` +
        `calibration pending${resolutionAdaptedNote}`,
      n: 0,
      intervalWidth: 1,
    },
  };
  atom.contentHash = checksum(atom);
  await options.storage.writePropertyAtom(atom);
  return atom;
}
