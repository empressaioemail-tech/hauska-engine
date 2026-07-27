/**
 * Unit coverage for the two new map-layer slots (qa/topo-map-slots):
 *   - topography-1ft: authoritative Bastrop 1-ft contours vs honest degrade
 *   - hydrology-flow: bbox -> D8 flow channels GeoJSON or honest-empty
 *
 * The real 3DEP-derived fallback + real D8 compute are exercised by the LIVE
 * probe (they need a real GeoTIFF DEM the ImageServer returns); these unit
 * tests pin the authoritative path, the provenance stamping, and the honest
 * degrade/empty contracts with stubbed upstreams.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MapLayersAssembleRequest } from "@hauska-engine/engine-core/map-layers";
import { resolveWave3MapLayerSlot } from "../lib/mapLayersWave3.js";

const EMPTY_OUTCOMES = new Map();

// Gold-parcel viewport bbox in Bastrop County (~30.11, -97.32).
const bastropBbox = {
  westLng: -97.322,
  southLat: 30.108,
  eastLng: -97.318,
  northLat: 30.112,
};

// Moab, UT bbox (~38.57, -109.55) — outside Bastrop 1-ft footprint.
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

/** ArcGIS FeatureServer query JSON with two 1-ft contour polylines. */
function arcgisContourResponse(): Response {
  return new Response(
    JSON.stringify({
      features: [
        {
          attributes: { contour: 500, mod10: 1 },
          geometry: {
            paths: [
              [
                [-97.321, 30.109],
                [-97.3205, 30.1095],
                [-97.32, 30.11],
              ],
            ],
          },
        },
        {
          attributes: { contour: 501, mod10: 0 },
          geometry: {
            paths: [
              [
                [-97.3215, 30.1085],
                [-97.321, 30.109],
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

const US_SURVEY_FOOT_METERS = 1200 / 3937;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("topography-1ft slot", () => {
  it("serves AUTHORITATIVE Bastrop 1-ft contours as WGS84 GeoJSON with ft->m provenance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => arcgisContourResponse()),
    );

    const slot = await resolveWave3MapLayerSlot(
      "topography-1ft",
      requestFor(bastropBbox),
      EMPTY_OUTCOMES,
    );

    expect(slot.layerKey).toBe("topography-1ft");
    expect(slot.status).toBe("ok");
    const payload = slot.envelope!.payload as unknown as {
      geojson: {
        type: string;
        features: Array<{
          geometry: { type: string; coordinates: number[][] };
          properties: { contour: number; contourFeet: number; index: boolean };
        }>;
      };
      attributes: {
        contourSource: {
          tier: string;
          source: string;
          intervalLabel: string;
          unit: string;
          contourCount: number;
        };
      };
    };

    // HONESTY: labelled 1-ft authoritative, NOT 3DEP.
    expect(payload.attributes.contourSource.tier).toBe("authoritative-1ft");
    expect(payload.attributes.contourSource.source).toBe(
      "bastrop-county:Contour1Ft2017",
    );
    expect(payload.attributes.contourSource.intervalLabel).toContain("1-ft");

    // GeoJSON LineStrings in WGS84 lng/lat.
    expect(payload.geojson.type).toBe("FeatureCollection");
    expect(payload.geojson.features.length).toBe(2);
    const line0 = payload.geojson.features[0]!;
    expect(line0.geometry.type).toBe("LineString");
    expect(line0.geometry.coordinates[0]![0]).toBeCloseTo(-97.321, 4);

    // ft -> m US survey foot conversion is correct (500 ft -> ~152.4 m).
    expect(line0.properties.contourFeet).toBe(500);
    expect(line0.properties.contour).toBeCloseTo(500 * US_SURVEY_FOOT_METERS, 6);
    expect(line0.properties.index).toBe(true);
    expect(payload.attributes.contourSource.contourCount).toBe(2);
  });

  it("does NOT claim 1-ft authoritative outside Bastrop (Moab) — never mislabels 3DEP", async () => {
    // Outside the Bastrop footprint the resolver skips the county fetch and
    // falls to the 3DEP path. With the DEM fetch stubbed to fail, it must
    // honestly degrade (pending), NEVER stamp authoritative-1ft.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "network disabled" }), {
            status: 404,
          }),
      ),
    );

    const slot = await resolveWave3MapLayerSlot(
      "topography-1ft",
      requestFor(moabBbox),
      EMPTY_OUTCOMES,
    );

    expect(slot.layerKey).toBe("topography-1ft");
    const tier =
      (slot.envelope?.payload as { attributes?: { contourSource?: { tier?: string } } })
        ?.attributes?.contourSource?.tier ?? null;
    // Either it degraded (pending, no tier) or it served the 3dep-fallback tier,
    // but it must NEVER be authoritative-1ft outside Bastrop.
    expect(tier).not.toBe("authoritative-1ft");
    if (slot.status === "pending") {
      expect(slot.pendingReason).toBeTruthy();
    }
  });

  it("honestly falls back when the Bastrop 1-ft service returns no contours", async () => {
    // Bastrop bbox but empty county result -> 3DEP fallback path. DEM fetch
    // stubbed to fail -> honest pending (never a fabricated 1-ft contour).
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) {
          // Empty county contour result.
          return new Response(
            JSON.stringify({ features: [], exceededTransferLimit: false }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ error: "dem disabled" }), {
          status: 404,
        });
      }),
    );

    const slot = await resolveWave3MapLayerSlot(
      "topography-1ft",
      requestFor(bastropBbox),
      EMPTY_OUTCOMES,
    );
    const tier =
      (slot.envelope?.payload as { attributes?: { contourSource?: { tier?: string } } })
        ?.attributes?.contourSource?.tier ?? null;
    expect(tier).not.toBe("authoritative-1ft");
  });
});

describe("hydrology-flow slot", () => {
  it("returns honest-empty (not a fabricated line) when the DEM fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "network disabled" }), {
            status: 404,
          }),
      ),
    );

    const slot = await resolveWave3MapLayerSlot(
      "hydrology-flow",
      requestFor(bastropBbox),
      EMPTY_OUTCOMES,
    );

    expect(slot.layerKey).toBe("hydrology-flow");
    // No DEM -> honest degrade. The payload must carry an empty FeatureCollection
    // and a real reason, never invented channels.
    const payload = slot.envelope?.payload as
      | {
          geojson?: { type: string; features: unknown[] };
          attributes?: { channelCount?: number; honestEmptyReason?: string };
        }
      | undefined;
    if (slot.status === "pending") {
      expect(slot.pendingReason).toBeTruthy();
    } else {
      expect(payload?.geojson?.features).toEqual([]);
      expect(payload?.attributes?.channelCount).toBe(0);
      expect(slot.envelope!.coverage.degraded).toBe(true);
    }
  });
});
