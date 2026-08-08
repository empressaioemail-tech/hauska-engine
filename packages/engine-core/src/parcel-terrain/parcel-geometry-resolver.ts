import postgres from "postgres";

import type { BboxWgs84 } from "@hauska-engine/adapters";

import type { ParcelGeometryResolver, ResolvedParcelGeometry } from "./author.js";

export interface ParcelGeometryRow {
  geometry: unknown;
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
  sourceVintage: string;
}

export interface TxgioDatabaseResolverOptions {
  databaseUrl: string;
  /** Test seam; production queries the shared TxGIO table directly. */
  query?: (countyFips: string, propId: string) => Promise<ParcelGeometryRow | null>;
}

export interface ArcGisParcelSource {
  countyFips: string;
  queryUrl: string;
  propIdField: string;
}

function parseParcelNodeId(parcelNodeId: string): { countyFips: string; propId: string } | null {
  const match = /^(\d{5}):([^:\s]+)$/.exec(parcelNodeId.trim());
  return match ? { countyFips: match[1]!, propId: match[2]! } : null;
}

function validBbox(row: ParcelGeometryRow): row is ParcelGeometryRow {
  return [row.westLng, row.southLat, row.eastLng, row.northLat].every(Number.isFinite)
    && row.eastLng > row.westLng
    && row.northLat > row.southLat;
}

function bboxFromGeoJson(geometry: unknown): BboxWgs84 | null {
  const values = collectGeoJsonPoints(geometry);
  if (!values.length) return null;
  const lngs = values.map(([lng]) => lng);
  const lats = values.map(([, lat]) => lat);
  const bbox = {
    westLng: Math.min(...lngs), southLat: Math.min(...lats),
    eastLng: Math.max(...lngs), northLat: Math.max(...lats),
  };
  return bbox.eastLng > bbox.westLng && bbox.northLat > bbox.southLat ? bbox : null;
}

function collectGeoJsonPoints(geometry: unknown): Array<[number, number]> {
  const coordinates = (geometry as { coordinates?: unknown })?.coordinates;
  const values: Array<[number, number]> = [];
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      values.push([value[0], value[1]]);
      return;
    }
    value.forEach(visit);
  };
  visit(coordinates);
  return values;
}

/** Named, countable reason a geometry resolve declines rather than serving a ring. */
export const MULTI_PART_GEOMETRY_UNSUPPORTED = "MULTI_PART_GEOMETRY_UNSUPPORTED" as const;

/**
 * Result of attempting to reduce a GeoJSON Polygon/MultiPolygon to the single
 * exterior ring this resolver's downstream (openRing, projectRing, the
 * offset core, edge labeling) assumes. Multi-part geometry is a named,
 * explicit decline rather than a silently truncated ring — see
 * `_decisions/2026-08-08_multipolygon_fail_closed_and_the_real_fix.md`.
 */
type RingReductionResult =
  | { ok: true; ring: Array<[number, number]> }
  | { ok: false; reason: typeof MULTI_PART_GEOMETRY_UNSUPPORTED }
  | { ok: false; reason: null };

/**
 * Exterior ring only (first ring of the first polygon) for Polygon /
 * MultiPolygon GeoJSON. Returns an explicit decline rather than truncating a
 * multi-part geometry: a Polygon with interior rings (holes) or a
 * MultiPolygon with more than one part cannot be reduced to a single ring
 * without silently dropping area, so this fails closed with a named reason
 * (`MULTI_PART_GEOMETRY_UNSUPPORTED`) instead of returning the exterior ring
 * of only one part. Also declines (reason: null) for other geometry types
 * (e.g. Point) — a site-plan PROPERTY_LINE layer must not draw a fabricated
 * ring.
 *
 * Reducibility ruling: a MultiPolygon with exactly one part AND that part
 * has no interior rings is safely reducible — `coordinates[0][0]` is the
 * complete geometry in that case, not a truncation, so it is treated the
 * same as a simple Polygon. A MultiPolygon with one part that itself has
 * holes is NOT reducible and declines, same as a holed Polygon.
 */
function reduceToExteriorRing(geometry: unknown): RingReductionResult {
  const geom = geometry as { type?: string; coordinates?: unknown } | null;
  if (!geom || typeof geom !== "object") return { ok: false, reason: null };
  if (geom.type === "Polygon") {
    const rings = geom.coordinates as unknown;
    if (!Array.isArray(rings)) return { ok: false, reason: null };
    if (rings.length > 1) return { ok: false, reason: MULTI_PART_GEOMETRY_UNSUPPORTED };
    const exterior = rings[0];
    return Array.isArray(exterior) && exterior.length >= 3
      ? { ok: true, ring: exterior as Array<[number, number]> }
      : { ok: false, reason: null };
  }
  if (geom.type === "MultiPolygon") {
    const polygons = geom.coordinates as unknown;
    if (!Array.isArray(polygons)) return { ok: false, reason: null };
    if (polygons.length > 1) return { ok: false, reason: MULTI_PART_GEOMETRY_UNSUPPORTED };
    const onlyPolygon = polygons[0];
    if (!Array.isArray(onlyPolygon)) return { ok: false, reason: null };
    // Single part, but that part itself has interior rings (holes) — not
    // safely reducible either, same treatment as a holed Polygon.
    if (onlyPolygon.length > 1) return { ok: false, reason: MULTI_PART_GEOMETRY_UNSUPPORTED };
    const exterior = onlyPolygon[0];
    return Array.isArray(exterior) && exterior.length >= 3
      ? { ok: true, ring: exterior as Array<[number, number]> }
      : { ok: false, reason: null };
  }
  return { ok: false, reason: null };
}

/**
 * Transitional resolver for TxGIO-backed counties. It queries the same
 * `txgio_parcel` geometry store used by cortex-api by its canonical
 * `{county_fips}:{normalized_prop_id}` identity. This intentionally avoids an
 * invented cortex HTTP route: the existing buildable-envelope route is keyed
 * by place, not parcel node id.
 */
export class TxgioDatabaseParcelGeometryResolver implements ParcelGeometryResolver {
  private readonly sql: postgres.Sql | null;
  private readonly query: (countyFips: string, propId: string) => Promise<ParcelGeometryRow | null>;

  constructor(options: TxgioDatabaseResolverOptions) {
    this.sql = options.query ? null : postgres(options.databaseUrl, { max: 2 });
    this.query = options.query ?? ((countyFips, propId) => this.queryDatabase(countyFips, propId));
  }

  async resolve(parcelNodeId: string): Promise<ResolvedParcelGeometry | null> {
    const parsed = parseParcelNodeId(parcelNodeId);
    if (!parsed) return null;
    const row = await this.query(parsed.countyFips, parsed.propId);
    if (!row || !validBbox(row)) return null;
    const reduction = reduceToExteriorRing(row.geometry);
    return {
      bbox: {
        westLng: row.westLng,
        southLat: row.southLat,
        eastLng: row.eastLng,
        northLat: row.northLat,
      },
      sourceRef: `txgio-parcel:${parsed.countyFips}:${parsed.propId}:${row.sourceVintage}`,
      ring: reduction.ok ? reduction.ring : undefined,
      ringDeclineReason: !reduction.ok && reduction.reason ? reduction.reason : undefined,
    };
  }

  private async queryDatabase(countyFips: string, propId: string): Promise<ParcelGeometryRow | null> {
    if (!this.sql) return null;
    // Normalize digit-only IDs on both sides so a tile node ID and a
    // zero-padded source prop_id address the same parcel.
    const rows = await this.sql<ParcelGeometryRow[]>`
      SELECT
        geometry,
        west_lng AS "westLng",
        south_lat AS "southLat",
        east_lng AS "eastLng",
        north_lat AS "northLat",
        source_vintage AS "sourceVintage"
      FROM txgio_parcel
      WHERE county_fips = ${countyFips}
        AND regexp_replace(prop_id, '^0+', '') = regexp_replace(${propId}, '^0+', '')
      ORDER BY ingested_at DESC
      LIMIT 1
    `;
    return rows[0] ?? null;
  }
}

/**
 * Generic live county-ArcGIS resolver. County URLs/field names are deployment
 * configuration rather than jurisdiction literals in the reasoning module.
 */
export class ArcGisParcelGeometryResolver implements ParcelGeometryResolver {
  constructor(
    private readonly sources: ReadonlyArray<ArcGisParcelSource>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async resolve(parcelNodeId: string): Promise<ResolvedParcelGeometry | null> {
    const parsed = parseParcelNodeId(parcelNodeId);
    if (!parsed) return null;
    const source = this.sources.find((candidate) => candidate.countyFips === parsed.countyFips);
    if (!source) return null;
    const url = new URL(source.queryUrl.endsWith("/query") ? source.queryUrl : `${source.queryUrl.replace(/\/$/, "")}/query`);
    url.searchParams.set("where", `${source.propIdField} = '${parsed.propId.replace(/'/g, "''")}'`);
    url.searchParams.set("outFields", source.propIdField);
    url.searchParams.set("returnGeometry", "true");
    url.searchParams.set("f", "geojson");
    const response = await this.fetchImpl(url);
    if (!response.ok) return null;
    const body = await response.json() as { features?: Array<{ geometry?: unknown }> };
    const geometry = body.features?.[0]?.geometry;
    const bbox = geometry ? bboxFromGeoJson(geometry) : null;
    const reduction = geometry ? reduceToExteriorRing(geometry) : null;
    if (!bbox) return null;
    return {
      bbox,
      sourceRef: `arcgis-parcel:${parsed.countyFips}:${parsed.propId}`,
      ring: reduction?.ok ? reduction.ring : undefined,
      ringDeclineReason: reduction && !reduction.ok && reduction.reason ? reduction.reason : undefined,
    };
  }
}

export function createParcelGeometryResolverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ParcelGeometryResolver {
  const databaseUrl = env.TXGIO_DATABASE_URL ?? env.DATABASE_URL;
  let sources: ArcGisParcelSource[] = [];
  try {
    const parsed = JSON.parse(env.PARCEL_GEOMETRY_ARCGIS_SOURCES_JSON ?? "[]");
    if (Array.isArray(parsed)) {
      sources = parsed.filter((candidate): candidate is ArcGisParcelSource =>
        typeof candidate?.countyFips === "string" &&
        typeof candidate?.queryUrl === "string" &&
        typeof candidate?.propIdField === "string",
      );
    }
  } catch {
    // Invalid deployment config must not create a permissive resolver.
  }
  const resolvers: ParcelGeometryResolver[] = [];
  if (databaseUrl) resolvers.push(new TxgioDatabaseParcelGeometryResolver({ databaseUrl }));
  if (sources.length) resolvers.push(new ArcGisParcelGeometryResolver(sources));
  return {
    async resolve(parcelNodeId) {
      for (const resolver of resolvers) {
        const resolved = await resolver.resolve(parcelNodeId);
        if (resolved) return resolved;
      }
      return null;
    },
  };
}
