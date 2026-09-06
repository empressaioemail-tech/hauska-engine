/**
 * atoms_geom_bbox write-path support (migration 012_geom_near_bbox_perf.sql).
 *
 * road-node / building-footprint near-bbox viewport queries can't use an
 * index against the raw jsonb centerline/footprintGeometry coordinate
 * arrays — testing bbox membership means walking every point of every
 * candidate row (measured: 24.5s for a real Caldwell-county road-node
 * query, comfortably past a 10s proxy timeout). atoms_geom_bbox holds a
 * precomputed scalar bounding box per atom so the read path can filter
 * with plain comparisons instead, mirroring tx_special_district's already-
 * proven approach. This module computes that box in JS from the instance
 * already in hand at write time (cheap — no extra jsonb scan needed,
 * unlike the one-time backfill script which has to derive it from
 * already-persisted rows) and upserts it alongside the atom write.
 */
import postgres from "postgres";

export type GeomBboxEntityType = "road-node" | "building-footprint";

export interface GeomBboxRow {
  atomDid: string;
  entityType: GeomBboxEntityType;
  countyFips: string | null;
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

/** Bounding box of a flat [lng, lat] coordinate array, or null if empty/invalid. */
export function computeLngLatBbox(
  coords: ReadonlyArray<readonly [number, number]> | null | undefined,
): { westLng: number; southLat: number; eastLng: number; northLat: number } | null {
  if (!Array.isArray(coords) || coords.length === 0) return null;
  let westLng = Infinity;
  let eastLng = -Infinity;
  let southLat = Infinity;
  let northLat = -Infinity;
  for (const pt of coords) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const [lng, lat] = pt;
    if (typeof lng !== "number" || typeof lat !== "number") continue;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    if (lng < westLng) westLng = lng;
    if (lng > eastLng) eastLng = lng;
    if (lat < southLat) southLat = lat;
    if (lat > northLat) northLat = lat;
  }
  if (!Number.isFinite(westLng) || !Number.isFinite(southLat)) return null;
  return { westLng, southLat, eastLng, northLat };
}

/**
 * Minimal shape this module needs off a written instance — matches both
 * RoadNodeAtomInstance and BuildingFootprintAtomInstance without importing
 * either (avoids a circular/tight coupling; pg-storage.ts already has the
 * real types and passes them in as `unknown`-safe structural values).
 */
export interface GeomBboxSourceInstance {
  atomDid: string;
  entityType: string;
  parcelNodeId?: string;
  centerline?: { coordinates?: ReadonlyArray<readonly [number, number]> } | null;
  footprintGeometry?: {
    coordinates?: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
  } | null;
}

/** Extracts the atoms_geom_bbox row for one instance, or null if not applicable/no usable geometry. */
export function geomBboxRowFromInstance(
  instance: GeomBboxSourceInstance & Record<string, unknown>,
): GeomBboxRow | null {
  if (instance.entityType === "road-node") {
    const coords = (instance as { centerline?: { coordinates?: unknown } }).centerline
      ?.coordinates as ReadonlyArray<readonly [number, number]> | undefined;
    const box = computeLngLatBbox(coords);
    if (!box) return null;
    const countyFips =
      typeof (instance as { countyFips?: unknown }).countyFips === "string"
        ? ((instance as { countyFips?: string }).countyFips as string)
        : null;
    return { atomDid: instance.atomDid, entityType: "road-node", countyFips, ...box };
  }
  if (instance.entityType === "building-footprint") {
    const rings = (instance as { footprintGeometry?: { coordinates?: unknown } })
      .footprintGeometry?.coordinates as
      | ReadonlyArray<ReadonlyArray<readonly [number, number]>>
      | undefined;
    const outerRing = Array.isArray(rings) ? rings[0] : undefined;
    const box = computeLngLatBbox(outerRing);
    if (!box) return null;
    const parcelNodeId = (instance as { parcelNodeId?: unknown }).parcelNodeId;
    const countyFips =
      typeof parcelNodeId === "string" ? parcelNodeId.split(":")[0] ?? null : null;
    return { atomDid: instance.atomDid, entityType: "building-footprint", countyFips, ...box };
  }
  return null;
}

/** Extracts atoms_geom_bbox rows for every applicable instance in a batch (skips the rest silently). */
export function geomBboxRowsFromInstances(
  instances: ReadonlyArray<Record<string, unknown>>,
): GeomBboxRow[] {
  const out: GeomBboxRow[] = [];
  for (const inst of instances) {
    const row = geomBboxRowFromInstance(inst as GeomBboxSourceInstance & Record<string, unknown>);
    if (row) out.push(row);
  }
  return out;
}

/** Idempotent batched upsert into atoms_geom_bbox. No-op on an empty array. */
export async function upsertGeomBboxRows(
  sql: postgres.Sql,
  rows: ReadonlyArray<GeomBboxRow>,
): Promise<void> {
  if (rows.length === 0) return;
  await sql`
    INSERT INTO atoms_geom_bbox
      (atom_did, entity_type, county_fips, west_lng, south_lat, east_lng, north_lat)
    SELECT * FROM UNNEST(
      ${rows.map((r) => r.atomDid)}::text[],
      ${rows.map((r) => r.entityType)}::text[],
      ${rows.map((r) => r.countyFips)}::text[],
      ${rows.map((r) => r.westLng)}::float8[],
      ${rows.map((r) => r.southLat)}::float8[],
      ${rows.map((r) => r.eastLng)}::float8[],
      ${rows.map((r) => r.northLat)}::float8[]
    )
    ON CONFLICT (atom_did) DO UPDATE SET
      county_fips = EXCLUDED.county_fips,
      west_lng = EXCLUDED.west_lng,
      south_lat = EXCLUDED.south_lat,
      east_lng = EXCLUDED.east_lng,
      north_lat = EXCLUDED.north_lat,
      updated_at = now()
  `;
}
