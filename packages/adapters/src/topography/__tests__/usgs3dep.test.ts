/**
 * Tests for the USGS 3DEP DEM raster client (Phase 2D.1.1).
 *
 * Network is stubbed — no live calls to USGS. The integration smoke
 * test that does hit the live ImageServer belongs to the ingest worker
 * (Phase 2D.1.2) so a federal-endpoint hiccup cannot block the unit
 * test run.
 */

import { describe, it, expect, vi } from "vitest";

import {
  fetchUsgs3depDem,
  bboxMetersExtent,
  computeRasterSize,
  selectAdaptiveResolutionMeters,
  Usgs3depFetchError,
  USGS_3DEP_EXPORT_ENDPOINT,
  MAX_PIXELS_PER_AXIS,
  MIN_PIXELS_PER_AXIS,
  DEFAULT_TERRAIN_RESOLUTION_METERS,
  type BboxWgs84,
} from "../usgs3dep.js";

/**
 * Musgrave_Residence_B is around Moab, UT (~38.57N, 109.55W). This
 * bbox is the parcel + a generous upstream-catchment buffer — about
 * 2.2km east-west, 1.1km north-south. With 10m resolution that yields
 * ~220×110 pixels, well within the {@link MIN_PIXELS_PER_AXIS}-
 * {@link MAX_PIXELS_PER_AXIS} band.
 */
const MOAB_BBOX: BboxWgs84 = {
  westLng: -109.5625,
  southLat: 38.5675,
  eastLng: -109.5375,
  northLat: 38.5775,
};

/** ~30m x 30m parcel — fails through 2m/px, passes at 1m/px. */
const SMALL_PARCEL_BBOX: BboxWgs84 = {
  westLng: -97.7400,
  southLat: 30.2600,
  eastLng: -97.739689,
  northLat: 30.260269,
};

/** ~8m x 8m — below the 16px floor even at 1m/px. */
const TINY_PARCEL_BBOX: BboxWgs84 = {
  westLng: -97.7400,
  southLat: 30.2600,
  eastLng: -97.73993,
  northLat: 30.26007,
};

/**
 * Build a minimal 200 OK `Response` whose body is a tiny GeoTIFF
 * preamble — enough bytes for the client to verify it round-trips the
 * binary intact without depending on a full TIFF parser in tests. The
 * client treats the bytes as opaque, so a stand-in payload is fine.
 */
function tiffResponse(bytes: Uint8Array): Response {
  // Uint8Array is a valid BodyInit at runtime, but TS 5.9's generic
  // `Uint8Array<ArrayBufferLike>` (where the backing buffer could in
  // theory be SharedArrayBuffer) doesn't narrow to BodyInit without an
  // explicit cast. The runtime contract is unchanged.
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: { "content-type": "image/tiff" },
  });
}

function jsonErrorResponse(envelope: unknown, status = 200): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { "content-type": "application/json;charset=utf-8" },
  });
}

describe("bboxMetersExtent", () => {
  it("computes width × height in meters with cosine-latitude scaling", () => {
    // 0.025° lng span × 111320 × cos(38.5725°) ≈ 2175m
    // 0.01°  lat span × 111320               ≈ 1113m
    const { widthM, heightM } = bboxMetersExtent(MOAB_BBOX);
    expect(widthM).toBeGreaterThan(2100);
    expect(widthM).toBeLessThan(2200);
    expect(heightM).toBeGreaterThan(1100);
    expect(heightM).toBeLessThan(1115);
  });

  it("returns 0 when the bbox is degenerate", () => {
    const { widthM, heightM } = bboxMetersExtent({
      westLng: -109.5,
      southLat: 38.5,
      eastLng: -109.5,
      northLat: 38.5,
    });
    expect(widthM).toBe(0);
    expect(heightM).toBe(0);
  });
});

describe("computeRasterSize", () => {
  it("sizes a parcel-scale bbox to roughly target resolution", () => {
    // ~2175m wide / 10m -> ~218px wide; ~1113m tall / 10m -> ~112px tall.
    const size = computeRasterSize(MOAB_BBOX, 10);
    expect(size.widthPx).toBeGreaterThanOrEqual(217);
    expect(size.widthPx).toBeLessThanOrEqual(219);
    expect(size.heightPx).toBeGreaterThanOrEqual(111);
    expect(size.heightPx).toBeLessThanOrEqual(113);
  });

  it("throws raster-too-large when bbox + resolution would exceed the per-axis cap", () => {
    // 2175m at 0.1m/px = 21750px — well past the 4096px cap.
    expect(() => computeRasterSize(MOAB_BBOX, 0.1)).toThrowError(
      /raster-too-large|exceeds/i,
    );
    try {
      computeRasterSize(MOAB_BBOX, 0.1);
    } catch (err) {
      expect(err).toBeInstanceOf(Usgs3depFetchError);
      expect((err as Usgs3depFetchError).code).toBe("raster-too-large");
    }
  });

  it("throws raster-too-small when bbox + resolution would fall below the per-axis floor", () => {
    // 1113m tall / 1000m/px = 1.1px — below the 16px floor.
    try {
      computeRasterSize(MOAB_BBOX, 1000);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Usgs3depFetchError);
      expect((err as Usgs3depFetchError).code).toBe("raster-too-small");
    }
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["+Infinity", Number.POSITIVE_INFINITY],
  ])("rejects %s resolution", (_label, resolution) => {
    try {
      computeRasterSize(MOAB_BBOX, resolution as number);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Usgs3depFetchError);
      expect((err as Usgs3depFetchError).code).toBe("invalid-resolution");
    }
  });
});

describe("selectAdaptiveResolutionMeters", () => {
  it("defaults to ~1m (3DEP serves lidar 1m) and keeps it when the bbox fits the cap", () => {
    // MOAB_BBOX is ~2175m x ~1113m; at the 1m default that is ~2175x1113px,
    // within [16, 4096] on both axes, so no adaptation is needed.
    expect(DEFAULT_TERRAIN_RESOLUTION_METERS).toBe(1);
    const result = selectAdaptiveResolutionMeters(MOAB_BBOX);
    expect(result.resolutionMetersRequested).toBe(1);
    expect(result.resolutionMetersAdapted).toBe(1);
    expect(() => computeRasterSize(MOAB_BBOX, result.resolutionMetersAdapted)).not.toThrow();
  });

  it("auto-RELAXES coarser when a 1m request would blow the 4096px/axis cap", () => {
    // A ~9km-wide catchment bbox at 1m/px would be ~9000px (> 4096 cap); the
    // selector must step coarser (to 3m here) rather than throw raster-too-large.
    const bigBbox: BboxWgs84 = {
      westLng: -109.60,
      southLat: 38.50,
      eastLng: -109.50, // ~8.7km E-W at this latitude
      northLat: 38.58,
    };
    // Confirm 1m really does blow the cap so the test is meaningful.
    expect(() => computeRasterSize(bigBbox, 1)).toThrowError(/raster-too-large|exceeds/i);
    const result = selectAdaptiveResolutionMeters(bigBbox, 1);
    expect(result.resolutionMetersRequested).toBe(1);
    expect(result.resolutionMetersAdapted).toBeGreaterThan(1);
    // The adapted resolution must actually fit the cap.
    const size = computeRasterSize(bigBbox, result.resolutionMetersAdapted);
    expect(size.widthPx).toBeLessThanOrEqual(MAX_PIXELS_PER_AXIS);
    expect(size.heightPx).toBeLessThanOrEqual(MAX_PIXELS_PER_AXIS);
  });

  it("auto-tightens from 10m to 1m for a small parcel bbox", () => {
    try {
      computeRasterSize(SMALL_PARCEL_BBOX, 10);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Usgs3depFetchError);
      expect((err as Usgs3depFetchError).code).toBe("raster-too-small");
    }
    const result = selectAdaptiveResolutionMeters(SMALL_PARCEL_BBOX, 10);
    expect(result.resolutionMetersRequested).toBe(10);
    expect(result.resolutionMetersAdapted).toBe(1);
    expect(() => computeRasterSize(SMALL_PARCEL_BBOX, result.resolutionMetersAdapted)).not.toThrow();
  });

  it("declines honestly when even 1m/px cannot satisfy the 16px floor", () => {
    try {
      selectAdaptiveResolutionMeters(TINY_PARCEL_BBOX, 10);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Usgs3depFetchError);
      expect((err as Usgs3depFetchError).code).toBe("raster-too-small");
      expect((err as Usgs3depFetchError).message).toMatch(/decline/i);
    }
  });

  it("auto-relaxes a too-fine request that fits at a coarser ladder step", () => {
    // 0.1m on MOAB (~2175m) is ~21750px (> cap), but relaxing to 1m fits
    // (~2175px). The selector must return the relaxed value, not throw.
    const result = selectAdaptiveResolutionMeters(MOAB_BBOX, 0.1);
    expect(result.resolutionMetersRequested).toBe(0.1);
    expect(result.resolutionMetersAdapted).toBeGreaterThanOrEqual(1);
    expect(() => computeRasterSize(MOAB_BBOX, result.resolutionMetersAdapted)).not.toThrow();
  });

  it("throws raster-too-large only when even the coarsest ladder step cannot fit the cap", () => {
    // A continent-scale bbox cannot fit 4096px even at 30m/px.
    const hugeBbox: BboxWgs84 = {
      westLng: -120,
      southLat: 30,
      eastLng: -80, // ~40 degrees of longitude
      northLat: 48,
    };
    try {
      selectAdaptiveResolutionMeters(hugeBbox, 1);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Usgs3depFetchError);
      expect((err as Usgs3depFetchError).code).toBe("raster-too-large");
    }
  });
});

describe("fetchUsgs3depDem — bbox validation", () => {
  it("rejects non-finite corners", async () => {
    await expect(
      fetchUsgs3depDem(
        { westLng: Number.NaN, southLat: 0, eastLng: 1, northLat: 1 },
        { resolutionMeters: 10, fetchImpl: vi.fn() },
      ),
    ).rejects.toMatchObject({ code: "invalid-bbox" });
  });

  it("rejects out-of-range longitude", async () => {
    await expect(
      fetchUsgs3depDem(
        { westLng: -200, southLat: 0, eastLng: 1, northLat: 1 },
        { resolutionMeters: 10, fetchImpl: vi.fn() },
      ),
    ).rejects.toMatchObject({ code: "invalid-bbox" });
  });

  it("rejects out-of-range latitude", async () => {
    await expect(
      fetchUsgs3depDem(
        { westLng: -109, southLat: -95, eastLng: -108, northLat: 1 },
        { resolutionMeters: 10, fetchImpl: vi.fn() },
      ),
    ).rejects.toMatchObject({ code: "invalid-bbox" });
  });

  it("rejects inverted east/west", async () => {
    await expect(
      fetchUsgs3depDem(
        { westLng: -109, southLat: 38, eastLng: -110, northLat: 39 },
        { resolutionMeters: 10, fetchImpl: vi.fn() },
      ),
    ).rejects.toMatchObject({ code: "invalid-bbox" });
  });

  it("rejects inverted north/south", async () => {
    await expect(
      fetchUsgs3depDem(
        { westLng: -109, southLat: 39, eastLng: -108, northLat: 38 },
        { resolutionMeters: 10, fetchImpl: vi.fn() },
      ),
    ).rejects.toMatchObject({ code: "invalid-bbox" });
  });
});

describe("fetchUsgs3depDem — happy path", () => {
  it("composes the exportImage URL with bbox/size/format/pixelType and returns the bytes verbatim", async () => {
    const body = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
    let capturedUrl = "";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return tiffResponse(body);
    });

    const result = await fetchUsgs3depDem(MOAB_BBOX, {
      resolutionMeters: 10,
      fetchImpl,
    });

    expect(capturedUrl.startsWith(USGS_3DEP_EXPORT_ENDPOINT)).toBe(true);
    const url = new URL(capturedUrl);
    expect(url.searchParams.get("bbox")).toBe(
      `${MOAB_BBOX.westLng},${MOAB_BBOX.southLat},${MOAB_BBOX.eastLng},${MOAB_BBOX.northLat}`,
    );
    expect(url.searchParams.get("bboxSR")).toBe("4326");
    expect(url.searchParams.get("imageSR")).toBe("4326");
    expect(url.searchParams.get("format")).toBe("tiff");
    expect(url.searchParams.get("pixelType")).toBe("F32");
    expect(url.searchParams.get("f")).toBe("image");
    // size encodes the computed pixel grid (width,height).
    const sizeStr = url.searchParams.get("size");
    expect(sizeStr).toMatch(/^\d+,\d+$/);
    const [widthStr, heightStr] = sizeStr!.split(",");
    expect(Number(widthStr)).toBe(result.widthPx);
    expect(Number(heightStr)).toBe(result.heightPx);

    expect(result.bytes).toEqual(body);
    expect(result.contentType).toBe("image/tiff");
    expect(result.bbox).toEqual(MOAB_BBOX);
    expect(result.resolutionMeters).toBe(10);
    expect(result.endpoint).toBe(capturedUrl);
    expect(result.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("fetchUsgs3depDem — upstream error mapping", () => {
  it("maps HTTP 4xx to upstream-error with status preserved", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("Bad bbox", {
          status: 400,
          headers: { "content-type": "text/plain" },
        }),
    );
    try {
      await fetchUsgs3depDem(MOAB_BBOX, { resolutionMeters: 10, fetchImpl });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Usgs3depFetchError);
      const e = err as Usgs3depFetchError;
      expect(e.code).toBe("upstream-error");
      expect(e.httpStatus).toBe(400);
      expect(e.message).toContain("Bad bbox");
    }
  });

  it("maps HTTP 5xx to upstream-error", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("internal error", {
          status: 503,
          headers: { "content-type": "text/html" },
        }),
    );
    try {
      await fetchUsgs3depDem(MOAB_BBOX, { resolutionMeters: 10, fetchImpl });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Usgs3depFetchError);
      expect((err as Usgs3depFetchError).code).toBe("upstream-error");
      expect((err as Usgs3depFetchError).httpStatus).toBe(503);
    }
  });

  it("maps a 200-with-JSON-error-envelope to non-image-response", async () => {
    // The ImageServer answers 200 OK + application/json when `f=image`
    // is set but a parameter is invalid (e.g. an unsupported pixelType).
    // Surfacing this as upstream-error would mask the failure mode
    // since the HTTP status is 200; the non-image-response code lets
    // the ingest worker decide whether to retry or surface the body.
    const fetchImpl = vi.fn(async () =>
      jsonErrorResponse(
        { error: { code: 400, message: "Invalid pixelType" } },
        200,
      ),
    );
    try {
      await fetchUsgs3depDem(MOAB_BBOX, { resolutionMeters: 10, fetchImpl });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Usgs3depFetchError);
      const e = err as Usgs3depFetchError;
      expect(e.code).toBe("non-image-response");
      expect(e.message).toContain("application/json");
      expect(e.message).toContain("Invalid pixelType");
    }
  });

  it("maps a thrown network error to network-error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("ENETUNREACH");
    });
    try {
      await fetchUsgs3depDem(MOAB_BBOX, { resolutionMeters: 10, fetchImpl });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Usgs3depFetchError);
      expect((err as Usgs3depFetchError).code).toBe("network-error");
    }
  });
});

describe("fetchUsgs3depDem — abort + timeout", () => {
  it("maps a caller-aborted signal to aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      // Mirror the real fetch contract: throw an AbortError when the
      // signal is already aborted.
      if (init?.signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      return tiffResponse(new Uint8Array());
    });
    try {
      await fetchUsgs3depDem(MOAB_BBOX, {
        resolutionMeters: 10,
        fetchImpl,
        signal: controller.signal,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Usgs3depFetchError);
      expect((err as Usgs3depFetchError).code).toBe("aborted");
    }
  });

  it("maps a timeout (TimeoutError) to the timeout code", async () => {
    // Real timeout via AbortSignal.timeout(1) — the fetchImpl never
    // resolves so the timer is the only way the promise settles.
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const reason = (init.signal as AbortSignal & { reason?: unknown })
              .reason;
            if (reason instanceof Error) {
              reject(reason);
            } else {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            }
          });
        }),
    );
    try {
      await fetchUsgs3depDem(MOAB_BBOX, {
        resolutionMeters: 10,
        fetchImpl,
        timeoutMs: 5,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Usgs3depFetchError);
      expect((err as Usgs3depFetchError).code).toBe("timeout");
    }
  });
});

describe("fetchUsgs3depDem — resolveActualResolution probe", () => {
  it("leaves resolutionMetersActual null when the probe is not requested", async () => {
    const fetchImpl = vi.fn(async () => tiffResponse(new Uint8Array([0x49, 0x49])));
    const result = await fetchUsgs3depDem(MOAB_BBOX, { resolutionMeters: 1, fetchImpl });
    expect(result.resolutionMetersActual).toBeNull();
    expect(result.resolutionMetersRequested).toBe(1);
    // Only the raster GET — no second f=json call.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("resolves resolutionMetersActual from the f=json pixelSize envelope when requested", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.get("f") === "json") {
        // ~1m in degrees at MOAB latitude: 1 / (111320 * cos(38.57°)) ≈ 1.15e-5.
        return new Response(
          JSON.stringify({ pixelSizeX: 1.15e-5, pixelSizeY: 8.98e-6 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return tiffResponse(new Uint8Array([0x49, 0x49]));
    });
    const result = await fetchUsgs3depDem(MOAB_BBOX, {
      resolutionMeters: 1,
      fetchImpl,
      resolveActualResolution: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.resolutionMetersActual).not.toBeNull();
    // Both axes convert to ~1m; the finer axis is reported.
    expect(result.resolutionMetersActual!).toBeGreaterThan(0.5);
    expect(result.resolutionMetersActual!).toBeLessThan(1.5);
  });

  it("keeps resolutionMetersActual null when the probe fails (no fabricated number)", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.get("f") === "json") {
        return new Response("boom", { status: 500, headers: { "content-type": "text/plain" } });
      }
      return tiffResponse(new Uint8Array([0x49, 0x49]));
    });
    const result = await fetchUsgs3depDem(MOAB_BBOX, {
      resolutionMeters: 1,
      fetchImpl,
      resolveActualResolution: true,
    });
    expect(result.resolutionMetersActual).toBeNull();
  });
});

describe("fetchUsgs3depDem — provenance fields", () => {
  it("echoes bbox + resolution + computed pixel grid onto the result", async () => {
    const fetchImpl = vi.fn(async () =>
      tiffResponse(new Uint8Array([0x49, 0x49])),
    );
    const result = await fetchUsgs3depDem(MOAB_BBOX, {
      resolutionMeters: 10,
      fetchImpl,
    });
    expect(result.bbox).toEqual(MOAB_BBOX);
    expect(result.resolutionMeters).toBe(10);
    expect(result.widthPx).toBeGreaterThan(0);
    expect(result.heightPx).toBeGreaterThan(0);
    expect(result.widthPx).toBeLessThanOrEqual(MAX_PIXELS_PER_AXIS);
    expect(result.heightPx).toBeLessThanOrEqual(MAX_PIXELS_PER_AXIS);
    expect(() => new URL(result.endpoint)).not.toThrow();
    expect(new Date(result.fetchedAt).toString()).not.toBe("Invalid Date");
  });
});
