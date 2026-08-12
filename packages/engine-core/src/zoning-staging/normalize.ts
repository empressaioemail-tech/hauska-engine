/**
 * Normalise an ArcGIS zoning feature into ZoningStagingPayload.
 * Harvest completeness: every source attribute lands in passthroughAttributes.
 */

import {
  assertTexasWgs84Bbox,
  bboxFromEsriRings,
  bboxFromGeoJsonCoordinates,
  type GeoBbox,
} from "./bbox.js";
import {
  assertPayloadContract,
  assertSourceTierSatisfied,
  buildStagingRowId,
  ZoningStagingContractError,
  type GeoJsonPolygon,
  type ZoningStagingPayload,
} from "./payload-contract.js";
import type { ZoningCityRegistryEntry } from "./registry.js";

export type ArcGisFeature = {
  attributes?: Record<string, unknown>;
  geometry?: {
    rings?: number[][][];
    type?: string;
    coordinates?: unknown;
  };
};

export type NormalizeOptions = {
  fetchedAt?: string;
  /** Override when a richer tier was actually used. */
  sourceTierSatisfied?: string[];
  sourceVintage?: string;
  /** Skip bbox assert (tests only). */
  skipBboxAssert?: boolean;
};

function esriRingsToGeoJson(rings: number[][][]): GeoJsonPolygon {
  return { type: "Polygon", coordinates: rings };
}

function applyCodeExtract(raw: string, regex: string | null): string | null {
  if (!regex) return raw;
  const m = new RegExp(regex).exec(raw);
  if (!m || m[1] == null || String(m[1]).trim() === "") return null;
  return String(m[1]).trim();
}

function mapDistrictCode(
  rawIn: unknown,
  entry: ZoningCityRegistryEntry,
): {
  districtCode: string | null;
  codeFieldRaw: string | null;
  codeDomainMapApplied: boolean;
} {
  if (rawIn == null || String(rawIn).trim() === "") {
    return { districtCode: null, codeFieldRaw: null, codeDomainMapApplied: false };
  }
  const codeFieldRaw = String(rawIn).trim();
  let extracted = applyCodeExtract(codeFieldRaw, entry.codeExtractRegex);
  if (extracted == null) {
    return { districtCode: null, codeFieldRaw, codeDomainMapApplied: false };
  }

  const nullSet = new Set(
    entry.nullDistrictCodes.map((c) => c.trim().toUpperCase()),
  );
  if (nullSet.has(extracted.toUpperCase())) {
    return { districtCode: null, codeFieldRaw, codeDomainMapApplied: false };
  }

  if (entry.codeDomainMap) {
    const mapped = entry.codeDomainMap[extracted];
    if (mapped == null) {
      // Map present → only listed values stamp (ZONING_LAYERS semantics).
      return { districtCode: null, codeFieldRaw, codeDomainMapApplied: false };
    }
    const applied = mapped !== extracted;
    return {
      districtCode: mapped,
      codeFieldRaw,
      codeDomainMapApplied: applied,
    };
  }

  return {
    districtCode: extracted,
    codeFieldRaw,
    codeDomainMapApplied: false,
  };
}

function geometryAndBbox(
  feature: ArcGisFeature,
  context: string,
  skipBboxAssert: boolean,
): { geometry: GeoJsonPolygon; bbox: GeoBbox; geometryCrs: string } {
  const g = feature.geometry;
  if (!g) {
    throw new ZoningStagingContractError(`${context}: missing geometry`);
  }

  let geometry: GeoJsonPolygon;
  let bbox: GeoBbox | null;

  if (Array.isArray(g.rings) && g.rings.length > 0) {
    geometry = esriRingsToGeoJson(g.rings);
    bbox = bboxFromEsriRings(g.rings);
  } else if (
    (g.type === "Polygon" || g.type === "MultiPolygon") &&
    g.coordinates != null
  ) {
    geometry = {
      type: g.type,
      coordinates: g.coordinates,
    };
    bbox = bboxFromGeoJsonCoordinates(g.coordinates);
  } else {
    throw new ZoningStagingContractError(
      `${context}: unsupported geometry (need rings or GeoJSON Polygon)`,
    );
  }

  if (!bbox) {
    throw new ZoningStagingContractError(`${context}: could not derive bbox`);
  }
  if (!skipBboxAssert) {
    assertTexasWgs84Bbox(bbox, context);
  }

  return { geometry, bbox, geometryCrs: "EPSG:4326" };
}

/**
 * Normalise one ArcGIS feature against a registry city entry.
 * Unmapped attributes → passthroughAttributes verbatim.
 */
export function normalizeZoningFeature(
  feature: ArcGisFeature,
  entry: ZoningCityRegistryEntry,
  opts: NormalizeOptions = {},
): ZoningStagingPayload | null {
  const attrs = feature.attributes ?? {};
  const objectIdRaw = attrs.OBJECTID ?? attrs.objectid ?? attrs.FID;
  if (objectIdRaw == null || String(objectIdRaw).trim() === "") {
    throw new ZoningStagingContractError(
      `${entry.cityKey}: feature missing OBJECTID`,
    );
  }
  const objectId = String(objectIdRaw).trim();
  const context = `${entry.cityKey}:${objectId}`;

  const mapped = mapDistrictCode(attrs[entry.codeField], entry);
  if (!mapped.districtCode) {
    return null; // honest skip — null district / unmapped domain
  }

  let districtName: string | null = null;
  if (entry.descriptionField && attrs[entry.descriptionField] != null) {
    const d = String(attrs[entry.descriptionField]).trim();
    districtName = d || null;
  }

  const { geometry, bbox, geometryCrs } = geometryAndBbox(
    feature,
    context,
    opts.skipBboxAssert === true,
  );

  const sourceTierSatisfied = assertSourceTierSatisfied(
    opts.sourceTierSatisfied ?? entry.sourceTier,
    context,
  );

  const isBase = entry.layerRole === "base";
  const isOverlay = entry.layerRole === "overlay";

  const payload: ZoningStagingPayload = {
    stagingRowId: buildStagingRowId(entry.cityKey, objectId),
    cityKey: entry.cityKey,
    cityGeoId: entry.cityGeoId,
    cityName: entry.cityName,
    parentCountyFips: entry.parentCountyFips,
    districtCode: mapped.districtCode,
    districtName,
    geometry,
    geometryCrs,
    isOverlay,
    isBaseDistrict: isBase,
    layerRole: entry.layerRole,
    geometryGrain: entry.geometryGrain,
    sourceUrl: entry.layerUrl,
    sourceLayerId: entry.layerId,
    fetchedAt: opts.fetchedAt ?? new Date().toISOString(),
    sourceTier: [...entry.sourceTier],
    sourceTierSatisfied,
    sourceVintage: opts.sourceVintage ?? `arcgis-live:${entry.cityKey}`,
    sourceCitation: entry.layerUrl,
    passthroughAttributes: { ...attrs },
    westLng: bbox.westLng,
    southLat: bbox.southLat,
    eastLng: bbox.eastLng,
    northLat: bbox.northLat,
    codeFieldRaw: mapped.codeFieldRaw,
    codeDomainMapApplied: mapped.codeDomainMapApplied,
    layerWhere: entry.layerWhere,
    objectId,
  };

  assertPayloadContract(payload, context);
  return payload;
}
