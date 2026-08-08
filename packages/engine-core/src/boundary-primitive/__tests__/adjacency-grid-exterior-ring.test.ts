/**
 * MultiPolygon / interior-ring fail-closed coverage for
 * `exteriorRingFromGeoJson` (adjacency-grid.ts). This function is an
 * independently-written duplicate of
 * `parcel-terrain/parcel-geometry-resolver.ts`'s reducer and got the same
 * silent-truncation bug; both get the same fail-closed treatment. See
 * `_decisions/2026-08-08_multipolygon_fail_closed_and_the_real_fix.md`.
 *
 * `load-parcel-index.ts` treats a `null` return here as "drop this parcel
 * from the adjacency index" (`if (!ring) continue`) — the same handling
 * already used for unsupported geometry types, so declining multi-part
 * geometry via `null` is consistent with existing caller behavior, not a
 * new failure mode.
 */
import { describe, expect, it } from "vitest";

import { exteriorRingFromGeoJson } from "../adjacency-grid.js";

describe("exteriorRingFromGeoJson (adjacency-grid)", () => {
  it("Polygon single ring (unchanged behavior): returns the ring", () => {
    const ring = exteriorRingFromGeoJson({
      type: "Polygon",
      coordinates: [[[-97.3, 30.1], [-97.29, 30.1], [-97.29, 30.11], [-97.3, 30.1]]],
    });
    expect(ring).toEqual([[-97.3, 30.1], [-97.29, 30.1], [-97.29, 30.11], [-97.3, 30.1]]);
  });

  it("Polygon with holes: declines (null) rather than truncating to the exterior ring", () => {
    const ring = exteriorRingFromGeoJson({
      type: "Polygon",
      coordinates: [
        [[-97.3, 30.1], [-97.29, 30.1], [-97.29, 30.11], [-97.3, 30.11], [-97.3, 30.1]],
        [[-97.298, 30.102], [-97.296, 30.102], [-97.296, 30.104], [-97.298, 30.104], [-97.298, 30.102]],
      ],
    });
    expect(ring).toBeNull();
  });

  it("MultiPolygon multi-part: declines (null) rather than serving only the first part", () => {
    const ring = exteriorRingFromGeoJson({
      type: "MultiPolygon",
      coordinates: [
        [[[-97.3, 30.1], [-97.29, 30.1], [-97.29, 30.11], [-97.3, 30.1]]],
        [[[-97.28, 30.1], [-97.27, 30.1], [-97.27, 30.11], [-97.28, 30.1]]],
      ],
    });
    expect(ring).toBeNull();
  });

  it("MultiPolygon single-part, no holes: reduces to the ring (ruled safely reducible, not a truncation)", () => {
    const ring = exteriorRingFromGeoJson({
      type: "MultiPolygon",
      coordinates: [
        [[[-97.3, 30.1], [-97.29, 30.1], [-97.29, 30.11], [-97.3, 30.1]]],
      ],
    });
    expect(ring).toEqual([[-97.3, 30.1], [-97.29, 30.1], [-97.29, 30.11], [-97.3, 30.1]]);
  });

  it("MultiPolygon single-part WITH holes: declines (single part alone does not make it reducible)", () => {
    const ring = exteriorRingFromGeoJson({
      type: "MultiPolygon",
      coordinates: [
        [
          [[-97.3, 30.1], [-97.29, 30.1], [-97.29, 30.11], [-97.3, 30.11], [-97.3, 30.1]],
          [[-97.298, 30.102], [-97.296, 30.102], [-97.296, 30.104], [-97.298, 30.104], [-97.298, 30.102]],
        ],
      ],
    });
    expect(ring).toBeNull();
  });

  it("non-polygon geometry types (existing behavior): returns null", () => {
    expect(exteriorRingFromGeoJson({ type: "Point", coordinates: [-97.3, 30.1] })).toBeNull();
    expect(exteriorRingFromGeoJson({ type: "LineString", coordinates: [[-97.3, 30.1], [-97.29, 30.1]] })).toBeNull();
    expect(exteriorRingFromGeoJson(null)).toBeNull();
    expect(exteriorRingFromGeoJson(undefined)).toBeNull();
    expect(exteriorRingFromGeoJson("not-an-object")).toBeNull();
  });
});
