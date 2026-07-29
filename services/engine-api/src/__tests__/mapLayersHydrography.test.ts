/**
 * Unit coverage for the `hydrography` map-layer slot (feat/hydrography-map-layer):
 * county-MAPPED water features from a county-configured ArcGIS source
 * (authoritative-over-derived; the D8 `hydrology-flow` slot stays as report
 * input). Mocked ArcGIS upstream per the slot-test convention; pins:
 *   - features + provenance stamping (county layer URL, layerName, vintage,
 *     kind: "county-mapped-hydrography")
 *   - honest-empty ("no county-mapped streams in this viewport")
 *   - unconfigured county -> honest-unavailable, never an error, never a
 *     derived substitution
 *   - bbox guard: large viewport degrades honestly WITHOUT fetching
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MapLayersAssembleRequest } from "@hauska-engine/engine-core/map-layers";
import { resolveWave3MapLayerSlot } from "../lib/mapLayersWave3.js";
import { HYDROGRAPHY_MAX_AREA_KM2 } from "../lib/mapLayerBboxGuard.js";

const EMPTY_OUTCOMES = new Map();

const BASTROP_HYDROGRAPHY_URL =
  "https://maps.co.bastrop.tx.us/server/rest/services/Hydrography/Creeks_Streams/MapServer/0";

// Gold-parcel viewport bbox in Bastrop County (~30.11, -97.32).
const bastropBbox = {
  westLng: -97.322,
  southLat: 30.108,
  eastLng: -97.318,
  northLat: 30.112,
};

// A ZOOMED-OUT viewport in Bastrop County (~60 km per side, far over the
// hydrography area threshold).
const zoomedOutBastropBbox = {
  westLng: -97.6,
  southLat: 30.0,
  eastLng: -97.0,
  northLat: 30.5,
};

// Moab, UT — no county hydrography source configured.
const moabBbox = {
  westLng: -109.552,
  southLat: 38.568,
  eastLng: -109.548,
  northLat: 38.572,
};

function requestFor(bbox: typeof bastropBbox): MapLayersAssembleRequest {
  return {
    parcel: {
      latitude: (bbox.southLat + bbox.northLat) / 2,
      longitude: (bbox.westLng + bbox.eastLng) / 2,
      parcelKey: "test-parcel",
    },
    jurisdiction: { stateKey: "texas", localKey: "bastrop-tx" },
    bbox,
  };
}

/** ArcGIS query JSON shaped like the live Creeks_Streams layer response. */
function creeksStreamsResponse(): Response {
  return new Response(
    JSON.stringify({
      features: [
        {
          attributes: {
            GNIS_Name: "Piney Creek",
            FEATURE_TY: "STREAM/RIVER",
            ReachCode: "12090301000319",
          },
          geometry: {
            paths: [
              [
                [-97.3298, 30.1269],
                [-97.33, 30.1265],
                [-97.3305, 30.126],
              ],
            ],
          },
        },
        {
          attributes: { GNIS_Name: " ", FEATURE_TY: "ARTIFICIAL PATH" },
          geometry: {
            paths: [
              [
                [-97.3016, 30.1167],
                [-97.302, 30.1168],
              ],
            ],
          },
        },
      ],
      exceededTransferLimit: false,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

type HydrographyPayload = {
  kind: string;
  geojson?: { type: string; features: Array<Record<string, unknown>> };
  attributes?: {
    provenance?: {
      source?: string;
      layerName?: string;
      vintage?: string | null;
      kind?: string;
    };
    honestEmptyReason?: string;
    honestUnavailableReason?: string;
    degradeReason?: string;
    featureCount?: number;
    sourceConfigured?: boolean;
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hydrography slot (county-mapped streams)", () => {
  it("serves county-MAPPED features as GeoJSON with full provenance", async () => {
    const fetchSpy = vi.fn(async () => creeksStreamsResponse());
    vi.stubGlobal("fetch", fetchSpy);

    const slot = await resolveWave3MapLayerSlot(
      "hydrography",
      requestFor(bastropBbox),
      EMPTY_OUTCOMES,
    );

    expect(slot.layerKey).toBe("hydrography");
    expect(slot.status).toBe("ok");
    expect(slot.adapterKey).toBe("bastrop-county:Creeks_Streams");

    const payload = slot.envelope!.payload as unknown as HydrographyPayload;
    expect(payload.kind).toBe("hydrography");

    // PROVENANCE: county layer URL + layerName + vintage + kind stamp.
    expect(payload.attributes?.provenance?.kind).toBe(
      "county-mapped-hydrography",
    );
    expect(payload.attributes?.provenance?.source).toBe(BASTROP_HYDROGRAPHY_URL);
    expect(payload.attributes?.provenance?.layerName).toBe(
      "Bastrop County Creeks & Streams",
    );
    // The county publishes no dataset vintage — honest null, never invented.
    expect(payload.attributes?.provenance?.vintage).toBeNull();

    // GeoJSON LineStrings with name attribute when the county carries one.
    expect(payload.geojson?.type).toBe("FeatureCollection");
    expect(payload.geojson?.features.length).toBe(2);
    const named = payload.geojson!.features[0] as {
      geometry: { type: string; coordinates: number[][] };
      properties: { name: string | null; featureType: string | null };
    };
    expect(named.geometry.type).toBe("LineString");
    expect(named.geometry.coordinates[0]![0]).toBeCloseTo(-97.3298, 4);
    expect(named.properties.name).toBe("Piney Creek");
    // Whitespace-only county name -> null (unnamed), never a blank label.
    const unnamed = payload.geojson!.features[1] as {
      properties: { name: string | null };
    };
    expect(unnamed.properties.name).toBeNull();
    expect(slot.envelope!.coverage.degraded).toBe(false);
  });

  it("returns honest-empty when the county maps no streams in the viewport", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ features: [], exceededTransferLimit: false }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const slot = await resolveWave3MapLayerSlot(
      "hydrography",
      requestFor(bastropBbox),
      EMPTY_OUTCOMES,
    );

    expect(slot.status).toBe("ok");
    const payload = slot.envelope!.payload as unknown as HydrographyPayload;
    expect(payload.geojson?.features).toEqual([]);
    expect(payload.attributes?.honestEmptyReason).toBe(
      "no county-mapped streams in this viewport",
    );
    // Checked absence still stamps the county provenance (what was checked).
    expect(payload.attributes?.provenance?.kind).toBe(
      "county-mapped-hydrography",
    );
    // Genuine, checked absence — not a degraded answer.
    expect(slot.envelope!.coverage.degraded).toBe(false);
  });

  it("returns honest-unavailable for a county WITHOUT a configured source — never an error, never substitution", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("fetch must NOT be called for an unconfigured county");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const slot = await resolveWave3MapLayerSlot(
      "hydrography",
      requestFor(moabBbox),
      EMPTY_OUTCOMES,
    );

    // NEVER an error, NEVER a derived (OSM/D8) substitution.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(slot.status).toBe("ok");
    expect(slot.error).toBeUndefined();

    const payload = slot.envelope!.payload as unknown as HydrographyPayload;
    expect(payload.geojson?.features).toEqual([]);
    expect(payload.attributes?.honestUnavailableReason).toBe(
      "no hydrography source configured for this county",
    );
    expect(payload.attributes?.sourceConfigured).toBe(false);
    expect(slot.envelope!.coverage.degraded).toBe(true);
  });

  it("bbox guard: large viewport honest-degrades WITHOUT fetching", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("fetch must NOT be called for a guarded large bbox");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const slot = await resolveWave3MapLayerSlot(
      "hydrography",
      requestFor(zoomedOutBastropBbox),
      EMPTY_OUTCOMES,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(slot.status).toBe("ok");
    const payload = slot.envelope!.payload as unknown as HydrographyPayload;
    expect(payload.geojson?.features).toEqual([]);
    const reason =
      payload.attributes?.honestEmptyReason ?? payload.attributes?.degradeReason;
    expect(reason).toContain("zoom in");
    expect(reason).toContain(`${HYDROGRAPHY_MAX_AREA_KM2} km²`);
    expect(slot.envelope!.coverage.degraded).toBe(true);
  });

  it("degrades to pending with the real reason when the county fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("upstream down", { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    const slot = await resolveWave3MapLayerSlot(
      "hydrography",
      requestFor(bastropBbox),
      EMPTY_OUTCOMES,
    );

    expect(slot.status).toBe("pending");
    expect(slot.pendingReason).toContain("county hydrography fetch failed");
  });

  it("flags truncation honestly when the county transfer limit is hit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              features: [
                {
                  attributes: { GNIS_Name: "Colorado River" },
                  geometry: {
                    paths: [
                      [
                        [-97.342, 30.1226],
                        [-97.3409, 30.1227],
                      ],
                    ],
                  },
                },
              ],
              exceededTransferLimit: true,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const slot = await resolveWave3MapLayerSlot(
      "hydrography",
      requestFor(bastropBbox),
      EMPTY_OUTCOMES,
    );

    expect(slot.status).toBe("ok");
    const payload = slot.envelope!.payload as unknown as {
      attributes?: { truncated?: boolean };
    };
    expect(payload.attributes?.truncated).toBe(true);
    expect(slot.envelope!.coverage.degraded).toBe(true);
  });
});
