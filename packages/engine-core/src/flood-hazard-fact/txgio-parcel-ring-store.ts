/**
 * Production ParcelRingStore adapter: SELECT geometry FROM txgio_parcel.
 *
 * Database: neondb on cortex-prod (fancy-fire-06136146), table txgio_parcel.
 * Not hauska_mcp.atoms. parcel-node is an entity_type inside atoms, not a
 * table — this adapter has no parcel-node join.
 *
 * Keying matches write-flood-hazard-fact-county.mjs:
 *   parcelKey = prop_id ?? `_feature-${feature_index}`
 */

import type { Sql } from "postgres";

import {
  MemoryParcelRingStore,
  type ParcelRingRef,
} from "./containment.js";

/**
 * Single-row adapter for a prop_id key. Quoted in RETURN-B6 as the
 * demonstration that the check reads txgio_parcel, not the atom.
 */
export const TXGIO_PARCEL_RING_BY_PROP_ID_SQL = `
SELECT geometry
FROM txgio_parcel
WHERE county_fips = $1
  AND prop_id = $2
ORDER BY feature_index
LIMIT 1
`.trim();

/**
 * Single-row adapter for a `_feature-${feature_index}` key (prop_id was null
 * at writer keying time).
 */
export const TXGIO_PARCEL_RING_BY_FEATURE_INDEX_SQL = `
SELECT geometry
FROM txgio_parcel
WHERE county_fips = $1
  AND feature_index = $2
  AND prop_id IS NULL
ORDER BY feature_index
LIMIT 1
`.trim();

/**
 * County batch used by the writer. Independent of the centroid page: the
 * classifier never receives that page's geometry objects.
 */
export const TXGIO_PARCEL_RING_COUNTY_BATCH_SQL = `
SELECT DISTINCT ON (feature_index)
       feature_index, prop_id, geometry
FROM txgio_parcel
WHERE county_fips = $1
  AND (
    prop_id = ANY($2::text[])
    OR (prop_id IS NULL AND feature_index = ANY($3::int[]))
  )
ORDER BY feature_index
`.trim();

export type FloodParcelStoreKey =
  | { kind: "prop_id"; countyFips: string; propId: string }
  | { kind: "feature_index"; countyFips: string; featureIndex: number };

export function parseFloodParcelStoreKey(
  countyFips: string,
  parcelKey: string,
): FloodParcelStoreKey {
  const key = parcelKey.trim();
  const m = /^_feature-(\d+)$/.exec(key);
  if (m) {
    return {
      kind: "feature_index",
      countyFips,
      featureIndex: Number(m[1]),
    };
  }
  return { kind: "prop_id", countyFips, propId: key };
}

function assertCountyFips(countyFips: string): string {
  if (!/^\d{5}$/.test(countyFips)) {
    throw new Error(
      `unsafe countyFips for txgio_parcel ring lookup: ${countyFips}`,
    );
  }
  return countyFips;
}

/**
 * One ring from txgio_parcel. Used as the named production adapter.
 * Tests do not call this against live prod.
 */
export async function fetchTxgioParcelRing(
  sql: Sql,
  ref: ParcelRingRef,
): Promise<{ status: "present"; geometry: unknown } | { status: "absent" }> {
  const countyFips = assertCountyFips(ref.countyFips);
  const parsed = parseFloodParcelStoreKey(countyFips, ref.parcelKey);
  if (parsed.kind === "prop_id") {
    const rows = await sql.unsafe<Array<{ geometry: unknown }>>(
      TXGIO_PARCEL_RING_BY_PROP_ID_SQL,
      [countyFips, parsed.propId],
    );
    const geometry = rows[0]?.geometry;
    return geometry == null
      ? { status: "absent" }
      : { status: "present", geometry };
  }
  const rows = await sql.unsafe<Array<{ geometry: unknown }>>(
    TXGIO_PARCEL_RING_BY_FEATURE_INDEX_SQL,
    [countyFips, parsed.featureIndex],
  );
  const geometry = rows[0]?.geometry;
  return geometry == null
    ? { status: "absent" }
    : { status: "present", geometry };
}

/**
 * Prefill a MemoryParcelRingStore from txgio_parcel rows.
 * First write for a parcelKey wins. That matches selectPlannableParcels
 * first-key-wins (lowest feature_index on the writer page). Last-write-wins
 * pairs feature A's centroid with feature B's ring.
 *
 * This is SS-W17's duplicate-resolution convention, not a second derivation
 * of which feature the parcel is. Reproducing 229 licenses apply against
 * that baseline.
 */
export function ingestTxgioParcelRingRows(
  store: MemoryParcelRingStore,
  countyFips: string,
  rows: ReadonlyArray<{
    feature_index: number;
    prop_id: string | null;
    geometry: unknown;
  }>,
): void {
  const fips = assertCountyFips(countyFips);
  for (const row of rows) {
    const parcelKey = row.prop_id ?? `_feature-${row.feature_index}`;
    if (store.getRing({ countyFips: fips, parcelKey }).status === "present") {
      continue;
    }
    store.set(fips, parcelKey, row.geometry);
  }
}

/**
 * Prefetch rings for the county writer. SECOND query, keyed by the same
 * parcelKeys the centroid page produced. Does not reuse that page's
 * GeoJSON objects.
 */
export async function loadTxgioParcelRingStore(
  sql: Sql,
  countyFips: string,
  parcelKeys: ReadonlyArray<string>,
): Promise<MemoryParcelRingStore> {
  const fips = assertCountyFips(countyFips);
  const store = new MemoryParcelRingStore("txgio_parcel");
  const propIds: string[] = [];
  const featureIndexes: number[] = [];
  for (const key of parcelKeys) {
    const parsed = parseFloodParcelStoreKey(fips, key);
    if (parsed.kind === "prop_id") propIds.push(parsed.propId);
    else featureIndexes.push(parsed.featureIndex);
  }
  if (propIds.length === 0 && featureIndexes.length === 0) return store;

  const rows = await sql.unsafe<
    Array<{ feature_index: number; prop_id: string | null; geometry: unknown }>
  >(TXGIO_PARCEL_RING_COUNTY_BATCH_SQL, [fips, propIds, featureIndexes]);

  ingestTxgioParcelRingRows(store, fips, rows);
  return store;
}
