import { createHash } from "node:crypto";

import {
  fetchUsgs3depDem,
  selectAdaptiveResolutionMeters,
  DEFAULT_TERRAIN_RESOLUTION_METERS,
  type BboxWgs84,
} from "@hauska-engine/adapters";
import type { ParcelTerrainModelAtomInstance } from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import { parseDemBytes, type ParsedDem } from "../site-topography/index.js";
import { assertTerrainElevationIntegrity, TERRAIN_VERTICAL_DATUM } from "./elevation.js";
import { emitDxf3dFace, emitDxfContoursFromPolylines, emitIfc } from "./emitters.js";
import { resolveContourSource } from "./contour-source.js";
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
  // Reframed 2026-07-27: default to ~1m (3DEP serves lidar-derived 1m across
  // CONUS). selectAdaptiveResolutionMeters auto-relaxes coarser if a large bbox
  // would blow the 4096px/axis cap, so this never fails hard on a big extent.
  const resolutionMetersRequested = options.resolutionMeters ?? DEFAULT_TERRAIN_RESOLUTION_METERS;
  const { resolutionMetersAdapted } = selectAdaptiveResolutionMeters(
    resolved.bbox,
    resolutionMetersRequested,
  );
  const contourIntervalMeters = options.contourIntervalMeters ?? 1;
  const fetchDem = options.fetchDem ?? fetchUsgs3depDem;
  const demFetch = await fetchDem(resolved.bbox, {
    resolutionMeters: resolutionMetersAdapted,
    resolveActualResolution: true,
  });
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
  // Authoritative 1-ft contour tier where covered (Bastrop), else honest
  // 3DEP-derived fallback. Mesh Z is untouched (still 3DEP + integrity gate);
  // only the contour lines are upgraded.
  const contourSource = await resolveContourSource({
    dem,
    bbox: resolved.bbox,
    contourIntervalMeters,
  });
  const authoritativeContours = contourSource.provenance.tier === "authoritative-1ft";
  const contours = await emitDxfContoursFromPolylines(contourSource.polylines);
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
      resolutionMetersAdapted,
      touchesNodata: dem.nodataCount > 0,
      contourSource: {
        tier: contourSource.provenance.tier,
        source: contourSource.provenance.source,
        vintage: contourSource.provenance.vintage,
        intervalLabel: contourSource.provenance.intervalLabel,
        polylineCount: contourSource.provenance.polylineCount,
        ...(contourSource.provenance.fallbackReason
          ? { fallbackReason: contourSource.provenance.fallbackReason }
          : {}),
      },
    },
    confidence: authoritativeContours
      ? {
          // Contour lines are drawn from an authoritative LiDAR-derived 1-ft
          // source (Bastrop Contour1Ft2017, 2017 StratMap). Mesh Z is still
          // 3DEP, so this is a bounded bump over the 0.6 3DEP-only baseline,
          // not a fabricated number: the elevation deliverable is county
          // survey-grade contours, honestly named below.
          value: 0.72,
          kind: "asserted",
          provenance:
            `Mesh Z: USGS 3DEP DEM field (${TERRAIN_VERTICAL_DATUM.summary}); ` +
            `contours: ${contourSource.provenance.source} (${contourSource.provenance.vintage}, ` +
            `${contourSource.provenance.intervalLabel}); ` +
            `mesh Z band [${elev.minZ.toFixed(3)}, ${elev.maxZ.toFixed(3)}] m; ` +
            `calibration pending${resolutionAdaptedNote}`,
          n: 0,
          intervalWidth: 1,
        }
      : {
          value: 0.6,
          kind: "asserted",
          provenance:
            `USGS 3DEP DEM field; Z=${TERRAIN_VERTICAL_DATUM.summary}; ` +
            `contours: ${contourSource.provenance.source} (${contourSource.provenance.tier}); ` +
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
