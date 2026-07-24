import postgres from "postgres";

import type { BboxWgs84 } from "@hauska-engine/adapters";

import type { ParcelGeometryResolver } from "./author.js";

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
  if (!values.length) return null;
  const lngs = values.map(([lng]) => lng);
  const lats = values.map(([, lat]) => lat);
  const bbox = {
    westLng: Math.min(...lngs), southLat: Math.min(...lats),
    eastLng: Math.max(...lngs), northLat: Math.max(...lats),
  };
  return bbox.eastLng > bbox.westLng && bbox.northLat > bbox.southLat ? bbox : null;
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

  async resolve(parcelNodeId: string): Promise<{ bbox: BboxWgs84; sourceRef: string } | null> {
    const parsed = parseParcelNodeId(parcelNodeId);
    if (!parsed) return null;
    const row = await this.query(parsed.countyFips, parsed.propId);
    if (!row || !validBbox(row)) return null;
    return {
      bbox: {
        westLng: row.westLng,
        southLat: row.southLat,
        eastLng: row.eastLng,
        northLat: row.northLat,
      },
      sourceRef: `txgio-parcel:${parsed.countyFips}:${parsed.propId}:${row.sourceVintage}`,
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

  async resolve(parcelNodeId: string): Promise<{ bbox: BboxWgs84; sourceRef: string } | null> {
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
    return bbox ? { bbox, sourceRef: `arcgis-parcel:${parsed.countyFips}:${parsed.propId}` } : null;
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
