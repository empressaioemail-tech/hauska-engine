import { describe, expect, it } from "vitest";

import { projectWgs84ToLocalEnu } from "../../../parcel-terrain/mesh.js";
import {
  AERIAL_CONTEXT_PAD_FRACTION,
  aerialImagePixelSize,
  buildAerialExportUrl,
  computeAerialMercatorBbox,
  fetchAerialImagery,
  lngLatToWebMercator,
  localEnuToWgs84,
  localEnuToWebMercator,
  looksLikePng,
  makeAerialOverlayTransform,
} from "../aerial.js";

const bbox = { westLng: -98.5, southLat: 29.4, eastLng: -98.4995, northLat: 29.4004 };

const ringWgs84: Array<[number, number]> = [
  [-98.4998, 29.4001],
  [-98.4996, 29.4001],
  [-98.4996, 29.4003],
  [-98.4998, 29.4003],
];

const ringLocal = ringWgs84.map(([lng, lat]) => projectWgs84ToLocalEnu(lng, lat, bbox));

describe("web mercator projection", () => {
  it("maps the origin to (0,0) and the antimeridian to the known EPSG:3857 bound", () => {
    const origin = lngLatToWebMercator(0, 0);
    expect(origin.x).toBeCloseTo(0, 6);
    expect(origin.y).toBeCloseTo(0, 6);
    const edge = lngLatToWebMercator(180, 0);
    expect(edge.x).toBeCloseTo(20037508.342789244, 3);
  });

  it("matches an independently computed reference point", () => {
    // Reference: x = R*lng*pi/180, y = R*ln(tan(pi/4+lat*pi/360)), R=6378137.
    const { x, y } = lngLatToWebMercator(-98.4997, 29.4002);
    expect(x).toBeCloseTo((6378137 * -98.4997 * Math.PI) / 180, 3);
    expect(y).toBeCloseTo(6378137 * Math.log(Math.tan(Math.PI / 4 + (29.4002 * Math.PI) / 360)), 3);
  });
});

describe("localEnuToWgs84 (exact inverse of projectWgs84ToLocalEnu)", () => {
  it("roundtrips every ring vertex losslessly", () => {
    for (const [lng, lat] of ringWgs84) {
      const local = projectWgs84ToLocalEnu(lng, lat, bbox);
      const back = localEnuToWgs84(local, bbox);
      expect(back.lng).toBeCloseTo(lng, 10);
      expect(back.lat).toBeCloseTo(lat, 10);
    }
  });
});

describe("computeAerialMercatorBbox", () => {
  it("contains the parcel's mercator extent with >=30% context pad and matches the requested aspect", () => {
    const aspect = 1.4;
    const merc = ringLocal.map((p) => localEnuToWebMercator(p, bbox));
    const xs = merc.map((p) => p.x);
    const ys = merc.map((p) => p.y);
    const box = computeAerialMercatorBbox(ringLocal, bbox, aspect);

    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    expect(AERIAL_CONTEXT_PAD_FRACTION).toBeGreaterThanOrEqual(0.3);
    // Pad on each side is at least padFraction * larger span.
    expect(Math.min(...xs) - box.xmin).toBeGreaterThanOrEqual(span * AERIAL_CONTEXT_PAD_FRACTION - 1e-6);
    expect(box.xmax - Math.max(...xs)).toBeGreaterThanOrEqual(span * AERIAL_CONTEXT_PAD_FRACTION - 1e-6);
    expect(Math.min(...ys) - box.ymin).toBeGreaterThanOrEqual(span * AERIAL_CONTEXT_PAD_FRACTION - 1e-6);
    expect(box.ymax - Math.max(...ys)).toBeGreaterThanOrEqual(span * AERIAL_CONTEXT_PAD_FRACTION - 1e-6);
    // Aspect-matched exactly (expand-only) so the PNG maps onto the page
    // image rect without distortion.
    expect((box.xmax - box.xmin) / (box.ymax - box.ymin)).toBeCloseTo(aspect, 6);
  });

  it("refuses degenerate input", () => {
    expect(() => computeAerialMercatorBbox(ringLocal.slice(0, 2), bbox, 1.4)).toThrow(/>=3 points/);
    expect(() => computeAerialMercatorBbox(ringLocal, bbox, 0)).toThrow(/aspect/);
  });
});

describe("makeAerialOverlayTransform (imagery alignment)", () => {
  const rect = { x: 34.5, y: 120, width: 543, height: 388 };

  it("maps the mercator bbox corners onto the image rect corners", () => {
    const box = computeAerialMercatorBbox(ringLocal, bbox, rect.width / rect.height);
    const toPage = makeAerialOverlayTransform(box, rect, bbox);
    // Invert: find the local point whose mercator position is the bbox SW/NE
    // corner by walking back through the (linear) local->wgs84 mapping.
    // Instead, verify with the forward chain: any local point's page position
    // must equal the imagery pixel position for the same ground coordinate.
    const swLocal = mercatorToLocal(box.xmin, box.ymin);
    const neLocal = mercatorToLocal(box.xmax, box.ymax);
    const sw = toPage(swLocal);
    const ne = toPage(neLocal);
    expect(sw.x).toBeCloseTo(rect.x, 6);
    expect(sw.y).toBeCloseTo(rect.y, 6);
    expect(ne.x).toBeCloseTo(rect.x + rect.width, 6);
    expect(ne.y).toBeCloseTo(rect.y + rect.height, 6);
  });

  it("places every ring vertex exactly where the imagery renders that ground coordinate (pixel-mapping parity)", () => {
    const box = computeAerialMercatorBbox(ringLocal, bbox, rect.width / rect.height);
    const size = aerialImagePixelSize(box);
    const toPage = makeAerialOverlayTransform(box, rect, bbox);
    for (const p of ringLocal) {
      const page = toPage(p);
      // Independent pixel mapping: the export renders mercator linearly into
      // the PNG; that pixel then lands on the page via the rect placement.
      const merc = localEnuToWebMercator(p, bbox);
      const px = ((merc.x - box.xmin) / (box.xmax - box.xmin)) * size.width;
      const pyFromTop = ((box.ymax - merc.y) / (box.ymax - box.ymin)) * size.height;
      const expectedX = rect.x + (px / size.width) * rect.width;
      const expectedY = rect.y + rect.height - (pyFromTop / size.height) * rect.height;
      expect(page.x).toBeCloseTo(expectedX, 6);
      expect(page.y).toBeCloseTo(expectedY, 6);
      // And the vertex must land strictly inside the padded imagery rect.
      expect(page.x).toBeGreaterThan(rect.x);
      expect(page.x).toBeLessThan(rect.x + rect.width);
      expect(page.y).toBeGreaterThan(rect.y);
      expect(page.y).toBeLessThan(rect.y + rect.height);
    }
  });

  it("preserves orientation: east is +x, north is +y on the page", () => {
    const box = computeAerialMercatorBbox(ringLocal, bbox, rect.width / rect.height);
    const toPage = makeAerialOverlayTransform(box, rect, bbox);
    const west = toPage(ringLocal[0]!); // [-98.4998, 29.4001]
    const east = toPage(ringLocal[1]!); // [-98.4996, 29.4001]
    const north = toPage(ringLocal[2]!); // [-98.4996, 29.4003]
    expect(east.x).toBeGreaterThan(west.x);
    expect(east.y).toBeCloseTo(west.y, 4);
    expect(north.y).toBeGreaterThan(east.y);
  });

  /** Inverse helper for the corner test: mercator -> wgs84 -> local ENU. */
  function mercatorToLocal(mx: number, my: number): { x: number; y: number } {
    const lng = (mx / 6378137 / Math.PI) * 180;
    const lat = ((2 * Math.atan(Math.exp(my / 6378137)) - Math.PI / 2) * 180) / Math.PI;
    return projectWgs84ToLocalEnu(lng, lat, bbox);
  }
});

describe("buildAerialExportUrl", () => {
  it("targets the keyless Esri World Imagery export endpoint in 3857 with a PNG image response", () => {
    const box = computeAerialMercatorBbox(ringLocal, bbox, 1.4);
    const url = new URL(buildAerialExportUrl(box, aerialImagePixelSize(box)));
    expect(url.origin + url.pathname).toBe(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export",
    );
    expect(url.searchParams.get("bboxSR")).toBe("3857");
    expect(url.searchParams.get("imageSR")).toBe("3857");
    expect(url.searchParams.get("format")).toBe("png");
    expect(url.searchParams.get("f")).toBe("image");
    const [xmin, ymin, xmax, ymax] = url.searchParams.get("bbox")!.split(",").map(Number);
    expect(xmin).toBeCloseTo(box.xmin, 6);
    expect(ymin).toBeCloseTo(box.ymin, 6);
    expect(xmax).toBeCloseTo(box.xmax, 6);
    expect(ymax).toBeCloseTo(box.ymax, 6);
    const [w, h] = url.searchParams.get("size")!.split(",").map(Number);
    expect(w! / h!).toBeCloseTo((box.xmax - box.xmin) / (box.ymax - box.ymin), 1);
  });
});

describe("fetchAerialImagery (never throws)", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  it("returns ok with the bytes for a PNG body", async () => {
    const result = await fetchAerialImagery("https://example.test/export", {
      fetchImage: async () => PNG,
    });
    expect(result).toEqual({ ok: true, bytes: PNG, url: "https://example.test/export" });
  });

  it("degrades to ok:false on a thrown fetch error", async () => {
    const result = await fetchAerialImagery("https://example.test/export", {
      fetchImage: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("ECONNREFUSED");
  });

  it("degrades to ok:false on a non-PNG body (Esri JSON error with HTTP 200)", async () => {
    const result = await fetchAerialImagery("https://example.test/export", {
      fetchImage: async () => new TextEncoder().encode('{"error":{}}'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("non-PNG");
  });

  it("passes an abort signal so the fetch is time-bounded", async () => {
    let sawSignal: AbortSignal | undefined;
    await fetchAerialImagery("https://example.test/export", {
      timeoutMs: 1234,
      fetchImage: async (_url, init) => {
        sawSignal = init.signal;
        return PNG;
      },
    });
    expect(sawSignal).toBeInstanceOf(AbortSignal);
  });

  it("looksLikePng accepts the signature and rejects everything else", () => {
    expect(looksLikePng(PNG)).toBe(true);
    expect(looksLikePng(new TextEncoder().encode("GIF89a"))).toBe(false);
    expect(looksLikePng(new Uint8Array(0))).toBe(false);
  });
});
