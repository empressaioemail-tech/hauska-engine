/**
 * S2-U2 boundary primitive acceptance (U2.1–U2.5).
 */

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";

import bastropDescriptor from "../../property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import {
  computeBoundaryEdgeAtoms,
  getParcelEdgeNeighbors,
  loadParcelAdjacencyIndexFromNeon,
  readBoundaryEdgesForParcel,
  BoundaryPrimitiveMissingError,
  persistBoundaryEdges,
  buildParcelAdjacencyIndex,
  ADJACENCY_CELL_SIZE_M,
  ADJACENCY_PROBE_DISTANCE_M,
} from "../index.js";
import {
  EXPECTED_ADJACENCY_28286,
  EXPECTED_ADJACENCY_33512,
  EXPECTED_ADJACENCY_34785,
  GOLD_PARCEL_ADJACENCY_FIXTURES,
} from "../fixtures/expectedAdjacency.js";

const TXGIO = Boolean(process.env.TXGIO_DATABASE_URL?.trim());
const LIVE = TXGIO && process.env.BOUNDARY_LIVE_TEST === "1";
const COUNTY_FIPS = "48021";

describe.skipIf(!LIVE)("boundary primitive live (U2.1–U2.2)", () => {
  it(
    "U2.2 adjacency matches PRE-2 spot-check on gold parcels",
    async () => {
    const sql = postgres(process.env.TXGIO_DATABASE_URL!, {
      ssl: "require",
      max: 2,
      prepare: false,
    });
    try {
      const index = await loadParcelAdjacencyIndexFromNeon(sql, COUNTY_FIPS);

      for (const [parcelNodeId, expected] of Object.entries(
        GOLD_PARCEL_ADJACENCY_FIXTURES,
      )) {
        const neighbors = getParcelEdgeNeighbors(index, parcelNodeId);
        expect(neighbors, parcelNodeId).not.toBeNull();
        for (const [edgeStr, want] of Object.entries(expected)) {
          const edgeIndex = Number(edgeStr);
          expect(neighbors![edgeIndex]).toBe(want);
        }
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 120_000);

  it(
    "U2.1 live atoms carry role + adjacency + setback + interior + temporal",
    async () => {
    const sql = postgres(process.env.TXGIO_DATABASE_URL!, {
      ssl: "require",
      max: 2,
      prepare: false,
    });
    const substrateUrl =
      process.env.DATABASE_URL?.trim() ||
      process.env.SUBSTRATE_DATABASE_URL?.trim();
    if (!substrateUrl) return;

    const substrateSql = postgres(substrateUrl, {
      ssl: "require",
      max: 2,
      prepare: false,
    });

    try {
      const index = await loadParcelAdjacencyIndexFromNeon(sql, COUNTY_FIPS);

      const roadRows = await substrateSql`
        SELECT body
        FROM atoms
        WHERE entity_type = 'road-node'
          AND body->>'countyFips' = ${COUNTY_FIPS}
          AND coalesce(body->>'status', 'active') = 'active'
        LIMIT 500
      `;
      const { roadAtomBodyToWarmSource } = await import("../compute.js");
      const roads = roadRows
        .map((r) => roadAtomBodyToWarmSource(r.body as never))
        .filter(Boolean);

      const extractedAt = new Date().toISOString();
      for (const propId of ["28286", "34785", "33512"] as const) {
        const parcelNodeId = `${COUNTY_FIPS}:${propId}`;
        const entry = index.entries.get(parcelNodeId);
        expect(entry).toBeDefined();

        const atoms = computeBoundaryEdgeAtoms({
          parcelNodeId,
          countyFips: COUNTY_FIPS,
          propId,
          district: "P-5",
          parcelRing: entry!.ring,
          descriptor: bastropDescriptor,
          adjacencyIndex: index,
          roads,
          effectiveDate: extractedAt.slice(0, 10),
          extractedAt,
          sourceAdapter: bastropDescriptor.sourceAdapter,
          sourceUrl: bastropDescriptor.sourceUrl,
        });

        expect(atoms.length).toBeGreaterThan(0);
        for (const atom of atoms) {
          expect(atom.entityType).toBe("property-boundary-edge");
          expect(atom.boundaryEdgeId).toMatch(
            new RegExp(`^${COUNTY_FIPS}:${propId}:boundary:\\d+$`),
          );
          expect(atom.role).toBeTruthy();
          expect(atom.adjacencyKind).toBeTruthy();
          expect(atom.interior.ringCcw).toBe(true);
          expect(atom.interior.centroidInside).toBe(true);
          expect(atom.interior.inwardNormal).toBeTruthy();
          expect(atom.status).toBe("active");
          expect(atom.effectiveDate).toBeTruthy();
          expect(atom.supersedesEntityId).toBeNull();
          expect(atom.setback).toBeTruthy();
        }
      }
    } finally {
      await sql.end({ timeout: 5 });
      await substrateSql.end({ timeout: 5 });
    }
  }, 120_000);
});

describe("boundary primitive honesty + method (U2.3–U2.5)", () => {
  it("U2.3 unmapped edges do not invent setback feet", () => {
    const ring = [
      [-97.32, 30.11],
      [-97.31975, 30.11],
      [-97.31975, 30.1103],
      [-97.32, 30.1103],
      [-97.32, 30.11],
    ] as const;

    const entry = {
      countyFips: COUNTY_FIPS,
      propId: "TEST",
      parcelNodeId: `${COUNTY_FIPS}:TEST`,
      ring: [...ring],
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
      propId: "TEST",
      district: "P-5",
      parcelRing: entry.ring,
      descriptor: bastropDescriptor,
      adjacencyIndex: index,
      roads: [],
      effectiveDate: extractedAt.slice(0, 10),
      extractedAt,
      sourceAdapter: "test",
      sourceUrl: "test://",
    });

    // R7 (district-default-for-role): an unmapped-adjacency edge with a KNOWN
    // role must NO LONGER decline with "unmapped-adjacency" (which NaN'd the
    // whole envelope). It resolves to the district-table setback for its role;
    // it may only decline with "no-setback-row" if the district genuinely has
    // no table row. The adjacencyKind provenance is still recorded on the atom.
    for (const atom of atoms) {
      if (atom.adjacencyKind === "unmapped") {
        // The old "unmapped-adjacency" decline is retired.
        expect(
          "kind" in atom.setback && atom.setback.kind === "unmapped-adjacency",
        ).toBe(false);
        // Either a resolved setback (feet) or an honest no-setback-row decline.
        const resolved = "feet" in atom.setback;
        const honestDecline =
          "kind" in atom.setback && atom.setback.kind === "no-setback-row";
        expect(resolved || honestDecline).toBe(true);
      }
    }
  });

  it("U2.4 persist path uses one-load cell-grid + PIP constants", () => {
    expect(ADJACENCY_CELL_SIZE_M).toBe(1000);
    expect(ADJACENCY_PROBE_DISTANCE_M).toBe(3);
    expect(typeof buildParcelAdjacencyIndex).toBe("function");
    expect(typeof loadParcelAdjacencyIndexFromNeon).toBe("function");
  });

  it("U2.5 read path fail-closed when primitive missing", async () => {
    const storage = new InMemoryStorage();
    await expect(
      readBoundaryEdgesForParcel(storage, `${COUNTY_FIPS}:missing`),
    ).rejects.toBeInstanceOf(BoundaryPrimitiveMissingError);
  });

  it("PRE-2 fixture tables are self-consistent", () => {
    expect(EXPECTED_ADJACENCY_28286[1]).toBe("32341");
    expect(EXPECTED_ADJACENCY_34785[2]).toBeNull();
    expect(EXPECTED_ADJACENCY_33512[0]).toBeNull();
    expect(EXPECTED_ADJACENCY_33512[5]).toBeNull();
  });

  it("situs-street front match: frontBasis recorded on the atom body (34177 defect shape)", () => {
    // Corner lot: Pine ~5.6 m south (closest), Pecan ~7.7 m west (situs street).
    const ring = [
      [-97.32, 30.11],
      [-97.3194, 30.11],
      [-97.3194, 30.1104],
      [-97.32, 30.1104],
      [-97.32, 30.11],
    ];
    const entry = {
      countyFips: COUNTY_FIPS,
      propId: "SITUS",
      parcelNodeId: `${COUNTY_FIPS}:SITUS`,
      situsAddress: "901 PECAN ST",
      ring,
      westLng: -97.32,
      southLat: 30.11,
      eastLng: -97.3194,
      northLat: 30.1104,
    };
    const roads = [
      {
        osmWayId: 1001,
        osmHighwayTag: "residential",
        name: "Pecan Street",
        classification: "residential" as const,
        polyline: [
          [-97.32008, 30.1098],
          [-97.32008, 30.1106],
        ] as [number, number][],
      },
      {
        osmWayId: 1002,
        osmHighwayTag: "residential",
        name: "Pine Street",
        classification: "residential" as const,
        polyline: [
          [-97.3202, 30.10995],
          [-97.3192, 30.10995],
        ] as [number, number][],
      },
    ];
    const index = buildParcelAdjacencyIndex(COUNTY_FIPS, [entry]);
    const extractedAt = new Date().toISOString();
    const base = {
      parcelNodeId: entry.parcelNodeId,
      countyFips: COUNTY_FIPS,
      propId: "SITUS",
      district: "P-5",
      parcelRing: ring,
      descriptor: bastropDescriptor,
      adjacencyIndex: index,
      roads,
      effectiveDate: extractedAt.slice(0, 10),
      extractedAt,
      sourceAdapter: "test",
      sourceUrl: "test://",
    };

    const withSitus = computeBoundaryEdgeAtoms({
      ...base,
      situsAddress: entry.situsAddress,
    });
    const frontSitus = withSitus.find((a) => a.role === "front");
    expect(frontSitus).toBeDefined();
    expect(frontSitus!.edgeIndex).toBe(3); // west (Pecan) edge
    expect(frontSitus!.frontBasis).toBe("situs-street-match");
    expect(frontSitus!.facingRoad?.roadNodeId).toContain("1001");

    const withoutSitus = computeBoundaryEdgeAtoms({ ...base, situsAddress: null });
    const frontHeuristic = withoutSitus.find((a) => a.role === "front");
    expect(frontHeuristic).toBeDefined();
    expect(frontHeuristic!.edgeIndex).toBe(0); // south (Pine) edge — closest road
    expect(frontHeuristic!.frontBasis).toBe("adjacency-heuristic");
    expect(frontHeuristic!.facingRoad?.roadNodeId).toContain("1002");
  });

  it("persist round-trip via in-memory storage", async () => {
    const storage = new InMemoryStorage();
    const ring = [
      [-97.32, 30.11],
      [-97.31975, 30.11],
      [-97.31975, 30.1103],
      [-97.32, 30.1103],
      [-97.32, 30.11],
    ];
    const entry = {
      countyFips: COUNTY_FIPS,
      propId: "ROUND",
      parcelNodeId: `${COUNTY_FIPS}:ROUND`,
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
      propId: "ROUND",
      district: "P-5",
      parcelRing: ring,
      descriptor: bastropDescriptor,
      adjacencyIndex: index,
      roads: [],
      effectiveDate: extractedAt.slice(0, 10),
      extractedAt,
      sourceAdapter: "test",
      sourceUrl: "test://",
    });

    await persistBoundaryEdges(storage, atoms, { force: true });
    const readBack = await readBoundaryEdgesForParcel(storage, entry.parcelNodeId);
    expect(readBack.length).toBe(atoms.length);
  });
});
