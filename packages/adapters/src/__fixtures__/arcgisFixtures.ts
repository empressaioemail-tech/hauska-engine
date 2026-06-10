/**
 * Recorded ArcGIS REST response shapes used across the adapter unit
 * tests. The fixtures intentionally minimize attributes — every adapter
 * passes `outFields=*` so they read attributes opaquely (the runner
 * does not care what columns the upstream service returns).
 */

export const arcgisFeatureWithGeometry = {
  features: [
    {
      attributes: {
        OBJECTID: 1,
        PARCEL_ID: "01-12345",
        OWNER: "Sample Owner",
        ACRES: 0.5,
      },
      geometry: {
        rings: [
          [
            [-109.5, 38.6],
            [-109.4999, 38.6],
            [-109.4999, 38.6001],
            [-109.5, 38.6001],
            [-109.5, 38.6],
          ],
        ],
        spatialReference: { wkid: 4326 },
      },
    },
  ],
  fields: [
    { name: "OBJECTID", type: "esriFieldTypeOID" },
    { name: "PARCEL_ID", type: "esriFieldTypeString" },
  ],
};

export const arcgisFeatureZoning = {
  features: [
    {
      attributes: {
        OBJECTID: 7,
        ZONE_CODE: "R-1",
        ZONE_DESC: "Single-Family Residential",
      },
      geometry: { rings: [], spatialReference: { wkid: 4326 } },
    },
  ],
};

export const arcgisFeatureFloodplain = {
  features: [
    {
      attributes: { OBJECTID: 99, FLD_ZONE: "AE", FLOODPLAIN: "100yr" },
    },
  ],
};

export const arcgisEmpty = { features: [] };

export const arcgisErrorEnvelope = {
  error: { code: 400, message: "Invalid query parameter" },
};

/** Overpass API response shape (subset used by the roads fallback). */
export const osmRoadsResponse = {
  version: 0.6,
  generator: "Overpass API",
  elements: [
    {
      type: "way",
      id: 12345,
      tags: { highway: "residential", name: "Sample St" },
      nodes: [],
    },
  ],
};

/**
 * Build a Response-like object the adapter helper accepts. The fetch
 * mock in tests returns these directly.
 */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
