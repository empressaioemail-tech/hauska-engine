/**
 * Bulk acquisition for depth-warm-bastrop-batch (2026-08-08).
 * All network/DB round trips happen here; the per-parcel loop is compute-only.
 */

import {
  BASTROP_PARCELS_ONE_CLICK_LAYER_23,
  getSetbackTableForZoning,
  parseBastropPerParcelAttributes,
  resolveBastropLayer23DominantRow,
} from "@hauska-engine/adapters";

import { exteriorRingFromGeoJson } from "../src/boundary-primitive/adjacency-grid.ts";
import { fetchBcadParcelRings, ringCentroidLngLat } from "../src/boundary-primitive/index.ts";
import {
  selectLiveGeneration,
  BoundaryPrimitiveMissingError,
} from "../src/boundary-primitive/read.ts";
import { propIdFromParcelNodeId } from "../src/property-reasoning/bastrop-per-parcel-setback.ts";
import { setbackTableDescriptorFromAdapter } from "../src/property-reasoning/setback-table-from-adapter.ts";
import { DEPTH_WARM_PROMOTION_MARKER } from "../src/depth-warm/types.ts";

const LAYER23_OUT_FIELDS =
  "prop_id,ZoneTypeClass,FrontSetback_,FrontSetback,SideSetback_,SideSetback,RearSetback_,RearSetback,MaxBuildingHt,MinimumLotSize_,MaxImpervisionCoverage,Ordinance_Link,Shape__Area";

const BCAD_CHUNK_SIZE = 150;

function normalizePropId(propId) {
  return String(propId).trim().replace(/^0+/, "") || "0";
}

/** @param {string[]} propIds */
export async function bulkLoadSitusByPropId(txSql, countyFips, propIds) {
  /** @type {Map<string, string | null>} */
  const out = new Map();
  if (!propIds.length) return out;
  const rows = await txSql`
    SELECT prop_id, situs_address
    FROM txgio_parcel
    WHERE county_fips = ${countyFips}
      AND prop_id = ANY(${propIds})
  `;
  for (const row of rows) {
    const raw = typeof row.situs_address === "string" ? row.situs_address.trim() : "";
    out.set(String(row.prop_id), raw || null);
  }
  return out;
}

/** @param {ReadonlyArray<string>} propIds */
export async function bulkLoadBcadRingsByPropId(propIds, fetchImpl = fetch) {
  /** @type {Map<string, import('../src/boundary-primitive/lot-line-scrub.ts').BcadParcelFetchResult>} */
  const out = new Map();
  const unique = [...new Set(propIds.map((id) => String(id).trim()).filter(Boolean))];
  for (let i = 0; i < unique.length; i += BCAD_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + BCAD_CHUNK_SIZE);
    const rows = await fetchBcadParcelRings(chunk, fetchImpl);
    for (const row of rows) {
      out.set(normalizePropId(row.propId), row);
    }
  }
  return out;
}

/**
 * Parcel-currency gate from a pre-fetched BCAD map (same semantics as assertParcelCurrencyInBcad).
 * @param {string} propId
 * @param {Map<string, import('../src/boundary-primitive/lot-line-scrub.ts').BcadParcelFetchResult>} bcadByPropId
 */
export function parcelCurrencyFromBcadMap(propId, bcadByPropId) {
  const id = String(propId).trim();
  if (!id) {
    return {
      ok: false,
      propId: id,
      code: "superseded-prop-id",
      reason: "empty prop_id",
    };
  }
  const hit = bcadByPropId.get(normalizePropId(id));
  if (!hit?.ring?.length) {
    return {
      ok: false,
      propId: id,
      code: "superseded-prop-id",
      reason: `prop_id ${id} absent from county cadastral — superseded; re-key manifest to successor parcel(s)`,
    };
  }
  return { ok: true, propId: id, ring: hit.ring, bcad: hit };
}

/** @param {import('postgres').Sql} sql @param {string[]} parcelNodeIds */
export async function bulkLoadAlreadyPromotedSet(sql, parcelNodeIds) {
  const promoted = new Set();
  if (!parcelNodeIds.length) return promoted;
  const rows = await sql`
    SELECT DISTINCT body->>'parcelNodeId' AS parcel_node_id
    FROM atoms
    WHERE entity_type = 'buildable-envelope'
      AND body->>'parcelNodeId' = ANY(${parcelNodeIds})
      AND body->>'depthWarmPromotion' = ${DEPTH_WARM_PROMOTION_MARKER}
  `;
  for (const row of rows) {
    if (row.parcel_node_id) promoted.add(row.parcel_node_id);
  }
  return promoted;
}

/** @param {import('postgres').Sql} txSql @param {string} countyFips @param {string[]} propIds */
export async function bulkLoadTxgioGeometryByPropId(txSql, countyFips, propIds) {
  /** @type {Map<string, { ring: import('../src/depth-warm/geometry.ts').Ring | null; sourceVintage: string | null }>} */
  const out = new Map();
  if (!propIds.length) return out;
  const rows = await txSql`
    SELECT prop_id, geometry, source_vintage
    FROM txgio_parcel
    WHERE county_fips = ${countyFips}
      AND prop_id = ANY(${propIds})
    ORDER BY prop_id, ingested_at DESC
  `;
  const seen = new Set();
  for (const row of rows) {
    const pid = String(row.prop_id);
    if (seen.has(pid)) continue;
    seen.add(pid);
    const ring = row.geometry ? exteriorRingFromGeoJson(row.geometry) : null;
    out.set(pid, {
      ring: ring?.length >= 3 ? ring : null,
      sourceVintage: row.source_vintage ?? null,
    });
  }
  return out;
}

/** @param {import('postgres').Sql} sql @param {string[]} parcelNodeIds */
export async function bulkLoadBoundaryEdgesByParcel(sql, parcelNodeIds) {
  /** @type {Map<string, import('@hauska-engine/atoms').BoundaryEdgeAtomInstance[]>} */
  const out = new Map();
  if (!parcelNodeIds.length) return out;
  const rows = await sql`
    SELECT body
    FROM atoms
    WHERE entity_type = 'property-boundary-edge'
      AND body->>'parcelNodeId' = ANY(${parcelNodeIds})
      AND coalesce(body->>'status', 'active') = 'active'
  `;
  /** @type {Map<string, import('@hauska-engine/atoms').BoundaryEdgeAtomInstance[]>} */
  const grouped = new Map();
  for (const row of rows) {
    const body = row.body;
    const pid = body?.parcelNodeId;
    if (!pid) continue;
    if (!grouped.has(pid)) grouped.set(pid, []);
    grouped.get(pid).push(body);
  }
  for (const [parcelNodeId, edges] of grouped) {
    try {
      const live = selectLiveGeneration(edges);
      out.set(
        parcelNodeId,
        [...live].sort((a, b) => a.edgeIndex - b.edgeIndex),
      );
    } catch {
      /* mixed generation — omit; loop falls back like BoundaryPrimitiveMissing */
    }
  }
  return out;
}

/**
 * Page-down Bastrop layer 23 once for the cohort (replaces per-parcel ArcGIS queries).
 * @returns {Promise<Map<string, Array<{ attributes: Record<string, unknown> }>>>}
 */
export async function bulkLoadLayer23FeatureIndex(fetchImpl = fetch) {
  /** @type {Map<string, Array<{ attributes: Record<string, unknown> }>>} */
  const byPropId = new Map();
  let offset = 0;
  const pageSize = 2000;
  while (true) {
    const url = new URL(`${BASTROP_PARCELS_ONE_CLICK_LAYER_23.replace(/\/$/, "")}/query`);
    url.searchParams.set("where", "1=1");
    url.searchParams.set("outFields", LAYER23_OUT_FIELDS);
    url.searchParams.set("returnGeometry", "false");
    url.searchParams.set("f", "json");
    url.searchParams.set("resultOffset", String(offset));
    url.searchParams.set("resultRecordCount", String(pageSize));

    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Layer-23 bulk fetch failed: HTTP ${response.status}`);
    }
    const body = await response.json();
    const features = body.features ?? [];
    for (const feature of features) {
      const attrs = feature.attributes ?? feature.properties ?? {};
      const raw = attrs.prop_id ?? attrs.PROP_ID ?? attrs.Prop_ID;
      if (raw == null) continue;
      const key = normalizePropId(String(raw));
      if (!byPropId.has(key)) byPropId.set(key, []);
      byPropId.get(key).push({ attributes: attrs });
    }
    if (features.length < pageSize) break;
    offset += pageSize;
  }
  return byPropId;
}

/**
 * Build per-parcel layer-23 descriptor from bulk index (single call replaces probe+build pair).
 * @param {import('../src/property-reasoning/types.ts').JurisdictionDescriptor} baseDescriptor
 * @param {string} parcelNodeId
 * @param {string} district
 * @param {string} cityKey
 * @param {Map<string, Array<{ attributes: Record<string, unknown> }>>} layer23Index
 * @param {[number, number] | undefined} centroidLngLat
 */
export function buildLayer23DescriptorFromIndex(
  baseDescriptor,
  parcelNodeId,
  district,
  cityKey,
  layer23Index,
  centroidLngLat,
) {
  const propId = propIdFromParcelNodeId(parcelNodeId);
  if (!propId) {
    return {
      ok: false,
      code: "invalid-parcel-node-id",
      reason: `Expected {fips}:{prop_id}, got ${parcelNodeId}`,
    };
  }
  const normalized = normalizePropId(propId);
  const features = layer23Index.get(normalized) ?? [];
  if (!features.length) {
    return {
      ok: false,
      code: "bastrop-per-parcel-not-found",
      reason: `No layer-23 row for prop_id=${normalized}.`,
    };
  }

  const resolved = resolveBastropLayer23DominantRow(features, district);
  if (!resolved) {
    return {
      ok: false,
      code: "bastrop-per-parcel-empty-features",
      reason: `Layer 23 returned no usable attributes for prop_id=${normalized}.`,
    };
  }

  const parsed = parseBastropPerParcelAttributes(resolved.dominant, normalized);
  if (parsed.kind !== "parsed") {
    return {
      ok: false,
      code: parsed.code,
      reason: parsed.reason,
    };
  }

  parsed.resolvedDistrictCode = resolved.dominantDistrictCode;
  parsed.splitZoneMinorZones =
    resolved.minorZones.length > 0 ? resolved.minorZones : undefined;

  const governingDistrict = (parsed.resolvedDistrictCode ?? district).trim() || district;
  const adapterTable = getSetbackTableForZoning(cityKey, governingDistrict, {
    bastropPerParcelRecord: parsed,
    districtCode: governingDistrict,
  });
  const setbackTable = setbackTableDescriptorFromAdapter(adapterTable);
  if (!setbackTable?.rows?.length) {
    return {
      ok: false,
      code: "setback-table-missing",
      reason: "Per-parcel record did not produce a setback table row.",
    };
  }

  return {
    ok: true,
    record: parsed,
    governingDistrict,
    descriptor: {
      ...baseDescriptor,
      setbackTable,
      sourceAdapter: "bastrop-per-parcel-record-layer-23",
      sourceUrl: parsed.ordinanceLink,
    },
  };
}

/**
 * Pre-build layer-23 descriptors for all cohort parcels (once per parcel, not twice).
 * @param {import('../src/property-reasoning/types.ts').JurisdictionDescriptor} baseDescriptor
 * @param {Array<{ parcel_node_id: string; district: string | null }>} parcelRows
 * @param {string} cityKey
 * @param {Map<string, import('../src/boundary-primitive/lot-line-scrub.ts').BcadParcelFetchResult>} bcadByPropId
 * @param {Map<string, Array<{ attributes: Record<string, unknown> }>>} layer23Index
 * @param {(row: { parcel_node_id: string; district: string | null }) => string | null} resolveDistrict
 */
export function buildLayer23DescriptorCache(
  baseDescriptor,
  parcelRows,
  cityKey,
  bcadByPropId,
  layer23Index,
  resolveDistrict,
) {
  /** @type {Map<string, ReturnType<typeof buildLayer23DescriptorFromIndex>>} */
  const cache = new Map();
  for (const row of parcelRows) {
    const parcelNodeId = row.parcel_node_id;
    const district = resolveDistrict(row);
    if (!district) continue;
    const propId = propIdFromParcelNodeId(parcelNodeId);
    if (!propId) continue;
    let centroidLngLat;
    const bcad = bcadByPropId.get(normalizePropId(propId));
    if (bcad?.ring?.length) {
      centroidLngLat = ringCentroidLngLat(bcad.ring);
    }
    cache.set(
      parcelNodeId,
      buildLayer23DescriptorFromIndex(
        baseDescriptor,
        parcelNodeId,
        district,
        cityKey,
        layer23Index,
        centroidLngLat,
      ),
    );
  }
  return cache;
}

/** Read boundary edges from bulk map; returns null when absent (same as missing primitive). */
export function boundaryEdgesFromBulkMap(bulkMap, parcelNodeId) {
  const edges = bulkMap.get(parcelNodeId);
  if (!edges?.length) return null;
  return edges;
}

export { BoundaryPrimitiveMissingError, normalizePropId };
