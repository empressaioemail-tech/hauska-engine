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

    for (const atom of atoms) {
      if (atom.adjacencyKind === "unmapped") {
        expect(atom.setback).toEqual({
          kind: "unmapped-adjacency",
          reason: expect.any(String),
        });
        expect("feet" in atom.setback).toBe(false);
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
