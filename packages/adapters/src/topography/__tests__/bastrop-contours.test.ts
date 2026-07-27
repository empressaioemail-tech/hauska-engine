import { describe, it, expect, vi } from "vitest";

import {
  fetchBastropCountyContours,
  bastropContourCoverage,
  US_SURVEY_FOOT_METERS,
  BASTROP_CONTOUR_SOURCE,
  type BboxWgs84,
} from "../bastrop-contours.js";

/** A bbox inside the Bastrop County footprint (near the sampled features). */
const BASTROP_BBOX: BboxWgs84 = {
  westLng: -97.35,
  southLat: 30.41,
  eastLng: -97.34,
  northLat: 30.43,
};

/** A bbox far outside Bastrop (Moab, UT). */
const MOAB_BBOX: BboxWgs84 = {
  westLng: -109.5625,
  southLat: 38.5675,
  eastLng: -109.5375,
  northLat: 38.5775,
};

function contourResponse(
  features: Array<{ contour: number; mod10: number; paths: number[][][] }>,
  exceeded = false,
): Response {
  return new Response(
    JSON.stringify({
      geometryType: "esriGeometryPolyline",
      spatialReference: { wkid: 4326 },
      features: features.map((f) => ({
        attributes: { contour: f.contour, mod10: f.mod10 },
        geometry: { paths: f.paths },
      })),
      exceededTransferLimit: exceeded,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("bastropContourCoverage", () => {
  it("is true inside the county footprint and false outside", () => {
    expect(bastropContourCoverage(BASTROP_BBOX)).toBe(true);
    expect(bastropContourCoverage(MOAB_BBOX)).toBe(false);
  });
});

describe("fetchBastropCountyContours", () => {
  it("skips the network entirely for out-of-county bboxes", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchBastropCountyContours(MOAB_BBOX, { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.polylines).toHaveLength(0);
    expect(result.source).toBe(BASTROP_CONTOUR_SOURCE);
  });

  it("converts contour feet to metres with the US SURVEY foot, not the international foot", async () => {
    const fetchImpl = vi.fn(async () =>
      contourResponse([
        { contour: 552, mod10: 1, paths: [[[-97.347, 30.421], [-97.348, 30.422]]] },
      ]),
    );
    const result = await fetchBastropCountyContours(BASTROP_BBOX, { fetchImpl });
    expect(result.polylines).toHaveLength(1);
    const line = result.polylines[0]!;
    expect(line.elevationFeet).toBe(552);
    // 552 * (1200/3937) — must NOT equal 552 * 0.3048 (international foot).
    expect(line.elevationMeters).toBeCloseTo(552 * US_SURVEY_FOOT_METERS, 9);
    expect(line.elevationMeters).not.toBeCloseTo(552 * 0.3048, 9);
    expect(line.index).toBe(true);
    expect(line.points).toEqual([[-97.347, 30.421], [-97.348, 30.422]]);
  });

  it("requests outSR=4326 so ArcGIS reprojects horizontally server-side", async () => {
    let capturedUrl = "";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return contourResponse([]);
    });
    await fetchBastropCountyContours(BASTROP_BBOX, { fetchImpl });
    const url = new URL(capturedUrl);
    expect(url.searchParams.get("outSR")).toBe("4326");
    expect(url.searchParams.get("inSR")).toBe("4326");
    expect(url.searchParams.get("geometryType")).toBe("esriGeometryEnvelope");
    expect(url.searchParams.get("outFields")).toBe("contour,mod10");
  });

  it("paginates while exceededTransferLimit is set", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call === 1) {
        return contourResponse(
          [{ contour: 500, mod10: 0, paths: [[[-97.34, 30.42], [-97.341, 30.421]]] }],
          true,
        );
      }
      return contourResponse(
        [{ contour: 501, mod10: 0, paths: [[[-97.34, 30.42], [-97.341, 30.421]]] }],
        false,
      );
    });
    const result = await fetchBastropCountyContours(BASTROP_BBOX, { fetchImpl });
    expect(result.pagesFetched).toBe(2);
    expect(result.polylines).toHaveLength(2);
  });

  it("throws on an ArcGIS error envelope rather than fabricating contours", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "bad geometry" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(fetchBastropCountyContours(BASTROP_BBOX, { fetchImpl })).rejects.toThrow(
      /bad geometry/i,
    );
  });
});
