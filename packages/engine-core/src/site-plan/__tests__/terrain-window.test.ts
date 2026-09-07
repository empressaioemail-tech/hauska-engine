import { describe, expect, it } from "vitest";
import {
  bboxMetersExtent,
  selectAdaptiveResolutionMeters,
  Usgs3depFetchError,
  FINEST_PRACTICAL_RESOLUTION_METERS,
  MIN_PIXELS_PER_AXIS,
  type BboxWgs84,
} from "@hauska-engine/adapters";

import {
  requiredWindowExtentMeters,
  resolveTerrainWindowBbox,
} from "../terrain-window.js";
import { sitePlanUnavailableFromError } from "../site-plan-unavailable.js";

/** A bbox of the given metric extent, centred on Bastrop, TX. */
function bboxOfMeters(widthM: number, heightM: number): BboxWgs84 {
  const lat = 30.1105;
  const lng = -97.3153;
  const mPerDegLat = 111_320;
  const mPerDegLng = mPerDegLat * Math.cos((lat * Math.PI) / 180);
  return {
    westLng: lng - widthM / 2 / mPerDegLng,
    eastLng: lng + widthM / 2 / mPerDegLng,
    southLat: lat - heightM / 2 / mPerDegLat,
    northLat: lat + heightM / 2 / mPerDegLat,
  };
}

/** Did the adapter accept this bbox for a DEM fetch? */
function adapterAccepts(bbox: BboxWgs84, requestedMeters = 1): boolean {
  try {
    selectAdaptiveResolutionMeters(bbox, requestedMeters);
    return true;
  } catch (err) {
    if (err instanceof Usgs3depFetchError && err.code === "raster-too-small") return false;
    throw err;
  }
}

describe("terrain window: the narrow-parcel site-plan outage", () => {
  // 1007 Water St Unit, Bastrop TX 78602 — the parcel from the production
  // report failure this fixes. ~27m x 9m.
  const NARROW_PARCEL = bboxOfMeters(27, 9);

  it("VIOLATION FIRST: the raw parcel bbox is refused by the adapter", () => {
    // If this ever stops throwing, the rest of this file is vacuous and the
    // fix below is guarding nothing. Pinned deliberately.
    expect(adapterAccepts(NARROW_PARCEL)).toBe(false);
    expect(() => selectAdaptiveResolutionMeters(NARROW_PARCEL, 1)).toThrow(
      /cannot meet .*px floor .*decline/,
    );
  });

  it("the widened window IS accepted, so the export can proceed", () => {
    const win = resolveTerrainWindowBbox(NARROW_PARCEL, 1);
    expect(win.expanded).toBe(true);
    expect(adapterAccepts(win.bbox)).toBe(true);
  });

  it("expands ONLY the deficient axis, and only to the required extent", () => {
    const win = resolveTerrainWindowBbox(NARROW_PARCEL, 1);
    const before = bboxMetersExtent(NARROW_PARCEL);
    const after = bboxMetersExtent(win.bbox);
    const required = requiredWindowExtentMeters(1);

    // 27m long axis is already above the floor: untouched.
    expect(after.widthM).toBeCloseTo(before.widthM, 6);
    // 9m short axis grows to exactly the required extent, not further.
    expect(after.heightM).toBeCloseTo(required, 6);
  });

  it("keeps the parcel centred in the window", () => {
    const win = resolveTerrainWindowBbox(NARROW_PARCEL, 1);
    expect((win.bbox.southLat + win.bbox.northLat) / 2).toBeCloseTo(
      (NARROW_PARCEL.southLat + NARROW_PARCEL.northLat) / 2,
      9,
    );
    expect((win.bbox.westLng + win.bbox.eastLng) / 2).toBeCloseTo(
      (NARROW_PARCEL.westLng + NARROW_PARCEL.eastLng) / 2,
      9,
    );
  });

  it("declares the expansion rather than widening silently", () => {
    const win = resolveTerrainWindowBbox(NARROW_PARCEL, 1);
    expect(win.reason).toBeTruthy();
    expect(win.reason).toMatch(/north-south from 9\.0m to 16m/);
    // The sheet consequence is stated, not just the cause.
    expect(win.reason).toMatch(/extend past the property line/i);
  });

  it("NOT VACUOUS: a normal parcel is returned byte-identical and unflagged", () => {
    const normal = bboxOfMeters(40, 45);
    const win = resolveTerrainWindowBbox(normal, 1);
    expect(win.expanded).toBe(false);
    expect(win.reason).toBeUndefined();
    expect(win.bbox).toBe(normal); // same object: provably untouched
    expect(adapterAccepts(normal)).toBe(true);
  });

  it("is a no-op across the whole range of parcels that already worked", () => {
    // Every parcel the adapter already accepted must come back unchanged, or
    // this fix would be silently re-shaping working exports.
    for (let side = 16; side <= 400; side += 8) {
      const bbox = bboxOfMeters(side, side);
      if (!adapterAccepts(bbox)) continue;
      expect(resolveTerrainWindowBbox(bbox, 1).expanded).toBe(false);
    }
  });

  it("every parcel the adapter refuses becomes one it accepts", () => {
    // The actual claim: the outage class is closed, not narrowed.
    let refusedBefore = 0;
    for (let w = 2; w <= 40; w += 2) {
      for (let h = 2; h <= 40; h += 2) {
        const parcel = bboxOfMeters(w, h);
        if (adapterAccepts(parcel)) continue;
        refusedBefore += 1;
        const win = resolveTerrainWindowBbox(parcel, 1);
        expect(win.expanded).toBe(true);
        expect(adapterAccepts(win.bbox)).toBe(true);
      }
    }
    // Guards the guard: if the sweep found nothing refused, the assertions
    // above never ran and this test proved nothing.
    expect(refusedBefore).toBeGreaterThan(0);
  });

  it("derives the floor from the adapter, so an adapter change cannot drift silently", () => {
    // Two independently derived inputs: our constant arithmetic, and the
    // adapter's own observed accept/refuse boundary. A sentinel cannot
    // satisfy both.
    const required = requiredWindowExtentMeters(1);
    expect(required).toBe(MIN_PIXELS_PER_AXIS * FINEST_PRACTICAL_RESOLUTION_METERS);

    let observedFloor = -1;
    for (let h = 1; h <= 64; h++) {
      if (adapterAccepts(bboxOfMeters(400, h))) {
        observedFloor = h;
        break;
      }
    }
    expect(observedFloor).toBe(required);
  });

  it("a coarse request still only needs the 1m/px extent (the selector tightens)", () => {
    // A 5m/px request does NOT mean a 16 x 5 = 80m window: the adapter
    // auto-tightens to 1m/px first, so 16m is still the binding floor.
    expect(requiredWindowExtentMeters(5)).toBe(requiredWindowExtentMeters(1));
    const win = resolveTerrainWindowBbox(NARROW_PARCEL, 5);
    expect(adapterAccepts(win.bbox, 5)).toBe(true);
    expect(bboxMetersExtent(win.bbox).heightM).toBeCloseTo(requiredWindowExtentMeters(1), 6);
  });
});

describe("site-plan-unavailable: the reason must survive the throw", () => {
  it("VIOLATION FIRST: the real decline used to fall through to the generic branch", () => {
    // This is the exact string production threw. It contains none of "dem",
    // "elevation" or "3dep", which is why the old two-branch matcher
    // laundered it into "site-plan authoring failed for this parcel".
    const real = new Usgs3depFetchError(
      "raster-too-small",
      "parcel bbox (~27m x 9m) cannot meet 16px floor even at 1m/px; decline",
    );
    expect(/dem|elevation|3dep/i.test(real.message)).toBe(false);

    const out = sitePlanUnavailableFromError(real);
    expect(out.summary).not.toBe("site-plan authoring failed for this parcel");
    expect(out.summary).toMatch(/too small for the available terrain data resolution/);
    // And the precise cause is preserved verbatim, not summarised away.
    expect(out.detail).toBe(real.message);
  });

  it("keeps the existing geometry and elevation readings", () => {
    expect(sitePlanUnavailableFromError(new Error("Parcel geometry unavailable for x")).summary).toMatch(
      /geometry could not be resolved/,
    );
    expect(sitePlanUnavailableFromError(new Error("3DEP upstream 502")).summary).toMatch(
      /terrain elevation data could not be fetched/,
    );
  });

  it("still has a generic branch, and it still carries the detail", () => {
    const out = sitePlanUnavailableFromError(new Error("something else entirely"));
    expect(out.summary).toBe("site-plan authoring failed for this parcel");
    expect(out.detail).toBe("something else entirely");
  });

  it("handles a non-Error throw without losing it", () => {
    expect(sitePlanUnavailableFromError("plain string").detail).toBe("plain string");
  });
});
