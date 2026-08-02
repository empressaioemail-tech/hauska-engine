/**
 * A5 — R7 close-at-primitive-bake tests (Phase A foundation).
 *
 * R7: an edge with a KNOWN district and KNOWN role (front/side/rear/side_corner)
 * resolves to that district's setback for that role even when adjacency is
 * unmapped. Only genuinely role-unknowable edges (labelEdgesFromRoads declined
 * entirely — no roads, no situs match, front-orientation unresolved) still
 * decline with `unmapped-adjacency`.
 */

import { describe, expect, it } from "vitest";

import bastropDescriptor from "../../property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import { computeBoundaryEdgeAtoms } from "../compute.js";
import { buildParcelAdjacencyIndex } from "../adjacency-grid.js";

const COUNTY_FIPS = "48021";

describe("R7 — known role + unmapped adjacency resolves to district default (A5)", () => {
  it("known role (front, via situs-street-match) + no neighbor/ROW adjacency -> district default setback, not decline", () => {
    // Single isolated parcel: no neighbor parcels registered in the adjacency
    // index at all, so every edge is adjacencyKind "unmapped". A real road is
    // supplied and matched to the parcel by situs address, so labelEdgesFromRoads
    // succeeds and every edge gets a genuinely-resolved role (front/side/rear).
    const ring = [
      [-97.32, 30.11],
      [-97.31975, 30.11],
      [-97.31975, 30.1103],
      [-97.32, 30.1103],
      [-97.32, 30.11],
    ];
    const entry = {
      countyFips: COUNTY_FIPS,
      propId: "R7KNOWN",
      parcelNodeId: `${COUNTY_FIPS}:R7KNOWN`,
      situsAddress: "901 PECAN ST",
      ring,
      westLng: -97.32,
      southLat: 30.11,
      eastLng: -97.31975,
      northLat: 30.1103,
    };
    const roads = [
      {
        osmWayId: 2001,
        osmHighwayTag: "residential",
        name: "Pecan Street",
        classification: "residential" as const,
        polyline: [
          [-97.32008, 30.1098],
          [-97.32008, 30.1106],
        ] as [number, number][],
      },
    ];
    const index = buildParcelAdjacencyIndex(COUNTY_FIPS, [entry]);
    const extractedAt = new Date().toISOString();

    const atoms = computeBoundaryEdgeAtoms({
      parcelNodeId: entry.parcelNodeId,
      countyFips: COUNTY_FIPS,
      propId: "R7KNOWN",
      district: "SF-1",
      parcelRing: ring,
      descriptor: bastropDescriptor,
      adjacencyIndex: index,
      roads,
      situsAddress: entry.situsAddress,
      effectiveDate: extractedAt.slice(0, 10),
      extractedAt,
      sourceAdapter: "test",
      sourceUrl: "test://",
    });

    expect(atoms.length).toBeGreaterThan(0);
    // Front edge matches the supplied road (adjacencyKind "ROW") — already
    // mapped, unaffected by R7, included here to confirm labeling succeeded.
    const front = atoms.find((a) => a.role === "front");
    expect(front).toBeDefined();
    expect(front!.frontBasis).toBe("situs-street-match");
    expect(front!.adjacencyKind).toBe("ROW");
    expect("feet" in front!.setback).toBe(true);

    // Rear/side edges: isolated parcel (no neighbor parcels registered), no
    // road touches these edges, so adjacencyKind is genuinely "unmapped" —
    // but labelEdgesFromRoads succeeded for the WHOLE ring, so their role
    // (rear/side) is genuinely known. R7: these must resolve to the district
    // default for that role, NOT decline with unmapped-adjacency.
    const nonFront = atoms.filter((a) => a.role !== "front");
    expect(nonFront.length).toBeGreaterThan(0);
    for (const atom of nonFront) {
      expect(atom.adjacencyKind).toBe("unmapped");
      expect("feet" in atom.setback).toBe(true);
      expect("kind" in atom.setback).toBe(false);
      if ("feet" in atom.setback) {
        expect(atom.setback.feet).toBeGreaterThan(0);
        expect(atom.setback.provenance).toBe("district-setback-table");
      }
    }
  });

  it("genuinely-unknown role (no roads at all, labeling declines) -> still declines unmapped-adjacency, unchanged", () => {
    const ring = [
      [-97.32, 30.11],
      [-97.31975, 30.11],
      [-97.31975, 30.1103],
      [-97.32, 30.1103],
      [-97.32, 30.11],
    ];
    const entry = {
      countyFips: COUNTY_FIPS,
      propId: "R7UNKNOWN",
      parcelNodeId: `${COUNTY_FIPS}:R7UNKNOWN`,
      ring,
      westLng: -97.32,
      southLat: 30.11,
      eastLng: -97.31975,
      northLat: 30.1103,
    };
    const index = buildParcelAdjacencyIndex(COUNTY_FIPS, [entry]);
    const extractedAt = new Date().toISOString();

    const atoms = computeBoundaryEdgeAtoms({
      parcelNodeId: entry.parcelNodeId,
      countyFips: COUNTY_FIPS,
      propId: "R7UNKNOWN",
      district: "SF-1",
      parcelRing: ring,
      descriptor: bastropDescriptor,
      adjacencyIndex: index,
      roads: [], // no roads at all -> labelEdgesFromRoads declines ("no-roads-available")
      effectiveDate: extractedAt.slice(0, 10),
      extractedAt,
      sourceAdapter: "test",
      sourceUrl: "test://",
    });

    expect(atoms.length).toBeGreaterThan(0);
    for (const atom of atoms) {
      expect(atom.adjacencyKind).toBe("unmapped");
      expect(atom.setback).toEqual({
        kind: "unmapped-adjacency",
        reason: expect.any(String),
      });
      expect("feet" in atom.setback).toBe(false);
    }
  });
});
