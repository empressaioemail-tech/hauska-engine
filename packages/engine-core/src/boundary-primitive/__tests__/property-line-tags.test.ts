/**
 * PROPERTY-LINE-TAGS — GIS bearing/distance on boundary edges (WDLL 1–3, 5).
 */

import { describe, expect, it } from "vitest";

import {
  azimuthDegreesFromGisBearing,
  bearingAngularDeltaDegrees,
  computePropertyLineTagsFromLocalEnuEndpoints,
  formatGisBearing,
  formatPropertyLineTag,
  PROPERTY_LINE_TAGS_ATOM_HONESTY,
  PROPERTY_LINE_TAGS_HONESTY,
  PROPERTY_LINE_TAGS_PROVENANCE_KIND,
  propertyLineTagsHonestyIsGisApproximate,
} from "../../geometry/gis-property-line-tags.js";
import { PARCEL_28286_LIVE_TXGIO } from "../../depth-warm/fixtures/parcelRings.js";
import bastropDescriptor from "../../property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import { buildParcelAdjacencyIndex, computeBoundaryEdgeAtoms } from "../index.js";
import { computeParcelInteriorFacts } from "../interior.js";

const COUNTY_FIPS = "48021";

describe("gis-property-line-tags shared helper", () => {
  it("formats cardinal directions from local-ENU deltas ( +Y north, +X east )", () => {
    expect(formatGisBearing(0, 10)).toBe("N 0°00' E");
    expect(formatGisBearing(10, 0)).toBe("N 90°00' E");
    expect(formatGisBearing(0, -10)).toBe("S 0°00' W");
    expect(formatGisBearing(-10, 0)).toBe("N 90°00' W");
  });

  it("atom tags carry GIS-approx honesty and never claim survey-grade alone", () => {
    const tags = computePropertyLineTagsFromLocalEnuEndpoints([0, 0], [0, 30.48]);
    expect(tags.bearing).toBe("N 0°00' E");
    expect(tags.distanceFeet).toBeCloseTo(100, 5);
    expect(tags.provenance.kind).toBe(PROPERTY_LINE_TAGS_PROVENANCE_KIND);
    expect(tags.provenance.honesty).toBe(PROPERTY_LINE_TAGS_ATOM_HONESTY);
    expect(propertyLineTagsHonestyIsGisApproximate(tags.provenance.honesty)).toBe(true);
    expect(tags.provenance.honesty.toLowerCase()).toContain("not a survey");
    expect(tags.provenance.honesty.toLowerCase()).not.toContain("survey-grade");
    expect(tags.provenance.honesty.toLowerCase()).not.toMatch(/^survey\b/);
  });

  it("PDF honesty and atom honesty both pass the GIS-approx guard", () => {
    expect(propertyLineTagsHonestyIsGisApproximate(PROPERTY_LINE_TAGS_HONESTY)).toBe(true);
    expect(propertyLineTagsHonestyIsGisApproximate(PROPERTY_LINE_TAGS_ATOM_HONESTY)).toBe(true);
  });

  it("RED: survey-grade claim without GIS-approx negation fails the honesty guard", () => {
    expect(propertyLineTagsHonestyIsGisApproximate("survey-grade bearing from plat")).toBe(
      false,
    );
    expect(propertyLineTagsHonestyIsGisApproximate("boundary survey")).toBe(false);
    expect(propertyLineTagsHonestyIsGisApproximate("certified survey")).toBe(false);
    // GIS-approx alone without survey negation also fails
    expect(propertyLineTagsHonestyIsGisApproximate("GIS-approximate")).toBe(false);
  });

  it("formatPropertyLineTag matches compute bearing + feet text", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 30.48 };
    const text = formatPropertyLineTag({ a, b, lengthFeet: 100 });
    const tags = computePropertyLineTagsFromLocalEnuEndpoints([0, 0], [0, 30.48]);
    expect(text).toBe(`${tags.bearing}  ${tags.distanceFeet.toFixed(1)}'`);
  });
});

describe("boundary emit propertyLineTags (28286 near-rect)", () => {
  function atomsFor28286() {
    const ring = PARCEL_28286_LIVE_TXGIO;
    const entry = {
      countyFips: COUNTY_FIPS,
      propId: "28286",
      parcelNodeId: `${COUNTY_FIPS}:28286`,
      ring: [...ring],
      westLng: -97.32751,
      southLat: 30.10268,
      eastLng: -97.32731,
      northLat: 30.10307,
    };
    const index = buildParcelAdjacencyIndex(COUNTY_FIPS, [entry]);
    const extractedAt = "2026-07-27T00:00:00.000Z";
    return computeBoundaryEdgeAtoms({
      parcelNodeId: entry.parcelNodeId,
      countyFips: COUNTY_FIPS,
      propId: "28286",
      district: "P-3",
      parcelRing: entry.ring,
      descriptor: bastropDescriptor as never,
      adjacencyIndex: index,
      roads: [],
      effectiveDate: "2026-07-27",
      extractedAt,
      sourceAdapter: "test",
      sourceUrl: "test://",
    });
  }

  it("emits propertyLineTags on every edge with honesty + GIS provenance", () => {
    const atoms = atomsFor28286();
    expect(atoms.length).toBe(4);
    for (const atom of atoms) {
      expect(atom.propertyLineTags).toBeDefined();
      const tags = atom.propertyLineTags!;
      expect(tags.provenance.kind).toBe("gis-approximate");
      expect(tags.provenance.honesty).toBe(PROPERTY_LINE_TAGS_ATOM_HONESTY);
      expect(propertyLineTagsHonestyIsGisApproximate(tags.provenance.honesty)).toBe(true);
      expect(tags.bearing).toMatch(/^[NS] \d+°\d{2}' [EW]$/);
      expect(tags.distanceFeet).toBeGreaterThan(50);
      expect(tags.distanceFeet).toBeLessThan(150);
    }
  });

  it("distances match ring edge lengths from interior.edgeEndpoints (±tol)", () => {
    const atoms = atomsFor28286();
    const facts = computeParcelInteriorFacts(PARCEL_28286_LIVE_TXGIO)!;
    for (const atom of atoms) {
      const [a, b] = atom.interior.edgeEndpoints;
      const expectedFt = Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.3048;
      expect(atom.propertyLineTags!.distanceFeet).toBeCloseTo(expectedFt, 8);
      const edge = facts.edges.find((e) => e.edgeIndex === atom.edgeIndex)!;
      expect(atom.interior.edgeEndpoints).toEqual(edge.edgeEndpoints);
    }
  });

  it("opposite sides are ~reciprocal (bearings differ by ~180°) and lengths match", () => {
    const atoms = atomsFor28286();
    const byIndex = new Map(atoms.map((a) => [a.edgeIndex, a]));
    // Near-rect: edges 0↔2 and 1↔3 are opposite when ring is 4-sided.
    for (const [i, j] of [
      [0, 2],
      [1, 3],
    ] as const) {
      const a = byIndex.get(i)!;
      const b = byIndex.get(j)!;
      const azA = azimuthDegreesFromGisBearing(a.propertyLineTags!.bearing);
      const azB = azimuthDegreesFromGisBearing(b.propertyLineTags!.bearing);
      expect(azA).not.toBeNull();
      expect(azB).not.toBeNull();
      // Reciprocal / antiparallel: angular delta ≈ 180°.
      expect(bearingAngularDeltaDegrees(azA!, azB!)).toBeCloseTo(180, 0);
      expect(a.propertyLineTags!.distanceFeet).toBeCloseTo(
        b.propertyLineTags!.distanceFeet,
        1,
      );
    }
    // Short pair ~60', long pair ~137' (scratch gold).
    const lengths = atoms.map((a) => a.propertyLineTags!.distanceFeet).sort((x, y) => x - y);
    expect(lengths[0]).toBeCloseTo(60, 0);
    expect(lengths[1]).toBeCloseTo(60, 0);
    expect(lengths[2]).toBeCloseTo(137, 0);
    expect(lengths[3]).toBeCloseTo(137, 0);
  });
});
