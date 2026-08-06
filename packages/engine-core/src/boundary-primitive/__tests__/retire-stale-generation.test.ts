/**
 * FIX 2 (2026-08-06 differential audit D2 / WS1 serve-truth amendment):
 * retire-not-overwrite for boundary-edge atoms at promote, plus the
 * read-side mixed-generation fail-closed guard.
 *
 * Live-bug reproduction: block2/Jones-Higgins parcels carried a fresh
 * depth-warm-verify-promote generation (4 edges, index 0-3) AND a stale
 * descriptor-fixture generation (up to 3 edges, index 4-6) simultaneously
 * "active" after promote never retired the prior generation — export/serve
 * read a blended 7-edge set that happened to match the true ring's vertex
 * count by coincidence, passing the naive `edges.length === ringVerts`
 * check while actually serving two disagreeing generations.
 */
import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";
import type { BoundaryEdgeAtomInstance } from "@hauska-engine/atoms";
import { buildAtomDid, boundaryEdgeIdFromParts } from "@hauska-engine/atoms";

import {
  persistBoundaryEdges,
  retireStaleBoundaryEdgesAfterPromote,
} from "../persist.js";
import {
  readBoundaryEdgesForParcel,
  selectLiveGeneration,
  MixedGenerationBoundaryPrimitiveError,
} from "../read.js";
import { prepareBoundaryEdgesForExport } from "../../site-plan/prepare-boundary-edges-for-export.js";

const COUNTY = "48021";
const PROP_ID = "31371";
const PARCEL_NODE_ID = `${COUNTY}:${PROP_ID}`;

function makeEdge(
  edgeIndex: number,
  overrides: Partial<BoundaryEdgeAtomInstance>,
): BoundaryEdgeAtomInstance {
  const boundaryEdgeId = boundaryEdgeIdFromParts(COUNTY, PROP_ID, edgeIndex);
  const base: BoundaryEdgeAtomInstance = {
    entityType: "property-boundary-edge",
    atomDid: buildAtomDid("property-boundary-edge", boundaryEdgeId).raw,
    boundaryEdgeId,
    entityId: boundaryEdgeId,
    parcelNodeId: PARCEL_NODE_ID,
    countyFips: COUNTY,
    propId: PROP_ID,
    edgeIndex,
    role: "side",
    adjacencyKind: "unmapped",
    parcelNeighborPropId: null,
    facingRoad: null,
    setback: { feet: 5, provenance: "test", atomCitation: "test" },
    interior: {
      ringCcw: true,
      centroidInside: true,
      inwardNormal: { x: 0, y: 1 },
      edgeEndpoints: [
        [0, 0],
        [1, 0],
      ],
    },
    effectiveDate: "2026-08-06",
    status: "active",
    supersedesEntityId: null,
    reasoningChain: { reasoningKind: "observed" },
    accessPolicy: "public-free",
    sourceCitation: "test",
    extractedAt: "2026-08-06T00:00:00.000Z",
    atomTier: "data",
    jurisdictionTenant: "bastrop-tx",
    fetchedAt: "2026-08-06T00:00:00.000Z",
    sourceAdapter: "test",
    sourceUrl: "test://",
    contentHash: `hash-${edgeIndex}`,
    ...overrides,
  };
  return base;
}

describe("retireStaleBoundaryEdgesAfterPromote", () => {
  it("retires every prior-generation edge (by versionStamp), even at non-overlapping edgeIndex", async () => {
    const storage = new InMemoryStorage();

    // Prior generation: 3 descriptor-fixture edges at index 4-6 (stale, WS1
    // scenario: leftover from an older city-wide warm before this parcel's
    // ring was known to have only 4 usable warm edges).
    const staleGen = [4, 5, 6].map((i) =>
      makeEdge(i, {
        sourceAdapter: "descriptor-fixture",
        versionStamp: `${PARCEL_NODE_ID}:property-boundary-edge:2026-08-05T22:41:00.000Z`,
      }),
    );
    await persistBoundaryEdges(storage, staleGen, { force: true });

    // Fresh generation: 4 depth-warm-verify-promote edges at index 0-3.
    const freshVersionStamp = `${PARCEL_NODE_ID}:property-boundary-edge:2026-08-06T19:02:54.000Z`;
    const freshGen = [0, 1, 2, 3].map((i) =>
      makeEdge(i, {
        sourceAdapter: "depth-warm-verify-promote",
        versionStamp: freshVersionStamp,
      }),
    );
    await persistBoundaryEdges(storage, freshGen, { force: true });

    // Before retirement: naive read returns all 7 (the D2 bug — 4 fresh + 3
    // stale happens to equal a 7-vertex ring's true edge count).
    const beforeRetire = await storage.listBoundaryEdgesByParcelNodeId(PARCEL_NODE_ID);
    expect(beforeRetire.length).toBe(7);

    await retireStaleBoundaryEdgesAfterPromote(
      storage,
      PARCEL_NODE_ID,
      freshVersionStamp,
      "2026-08-06T19:03:00.000Z",
    );

    const afterRetire = await storage.listBoundaryEdgesByParcelNodeId(PARCEL_NODE_ID);
    expect(afterRetire.length).toBe(4);
    expect(afterRetire.every((e) => e.versionStamp === freshVersionStamp)).toBe(true);
    expect(afterRetire.map((e) => e.edgeIndex).sort()).toEqual([0, 1, 2, 3]);
  });

  it("readBoundaryEdgesForParcel returns exactly the live generation after retirement", async () => {
    const storage = new InMemoryStorage();
    const staleVersionStamp = `${PARCEL_NODE_ID}:property-boundary-edge:v1`;
    const freshVersionStamp = `${PARCEL_NODE_ID}:property-boundary-edge:v2`;

    await persistBoundaryEdges(
      storage,
      [4, 5, 6].map((i) => makeEdge(i, { versionStamp: staleVersionStamp })),
      { force: true },
    );
    await persistBoundaryEdges(
      storage,
      [0, 1, 2, 3].map((i) => makeEdge(i, { versionStamp: freshVersionStamp })),
      { force: true },
    );
    await retireStaleBoundaryEdgesAfterPromote(
      storage,
      PARCEL_NODE_ID,
      freshVersionStamp,
      "2026-08-06T19:03:00.000Z",
    );

    const live = await readBoundaryEdgesForParcel(storage, PARCEL_NODE_ID);
    expect(live.length).toBe(4);
    expect(live.every((e) => e.versionStamp === freshVersionStamp)).toBe(true);
  });
});

describe("selectLiveGeneration (read-side fail-closed backstop)", () => {
  it("passes through a single-generation edge set unchanged", () => {
    const edges = [0, 1, 2, 3].map((i) => makeEdge(i, { versionStamp: "v1" }));
    expect(selectLiveGeneration(edges)).toEqual(edges);
  });

  it("passes through edges with no versionStamp when they are the only generation", () => {
    const edges = [0, 1, 2, 3].map((i) => makeEdge(i, { versionStamp: undefined }));
    expect(selectLiveGeneration(edges)).toEqual(edges);
  });

  it("throws MixedGenerationBoundaryPrimitiveError when two versionStamps coexist as active", () => {
    const edges = [
      ...[0, 1, 2, 3].map((i) => makeEdge(i, { versionStamp: "v2-fresh" })),
      ...[4, 5, 6].map((i) => makeEdge(i, { versionStamp: "v1-stale" })),
    ];
    expect(() => selectLiveGeneration(edges)).toThrow(MixedGenerationBoundaryPrimitiveError);
  });
});

describe("prepareBoundaryEdgesForExport mixed-generation fail-closed", () => {
  it("declines with mixed-generation-boundary-edges rather than serving a blended set", async () => {
    const mixedEdges = [
      ...[0, 1, 2, 3].map((i) => makeEdge(i, { versionStamp: "v2-fresh" })),
      ...[4, 5, 6].map((i) => makeEdge(i, { versionStamp: "v1-stale" })),
    ];
    const ringWgs84 = [
      [-97.3268, 30.1066],
      [-97.3266, 30.1064],
      [-97.3263, 30.1064],
      [-97.3261, 30.1066],
      [-97.3261, 30.107],
      [-97.3265, 30.1072],
      [-97.3268, 30.107],
      [-97.3268, 30.1066],
    ] as const;

    const result = await prepareBoundaryEdgesForExport({
      parcelNodeId: PARCEL_NODE_ID,
      storedEdges: mixedEdges,
      ringWgs84: ringWgs84 as unknown as [number, number][],
      roads: [],
    });

    expect(result.edges).toBeNull();
    expect(result.reason).toBe("mixed-generation-boundary-edges");
  });

  it("serves normally once retirement leaves a single generation", async () => {
    const singleGenEdges = [0, 1, 2, 3].map((i) =>
      makeEdge(i, { versionStamp: "v2-fresh", role: i === 3 ? "front" : "side" }),
    );
    const ringWgs84 = [
      [-97.32653742899998, 30.10664583500005],
      [-97.32676392099995, 30.106643674000054],
      [-97.32681061299996, 30.106956840000066],
      [-97.32655329199997, 30.106996621000064],
    ] as const;

    const result = await prepareBoundaryEdgesForExport({
      parcelNodeId: PARCEL_NODE_ID,
      storedEdges: singleGenEdges,
      ringWgs84: ringWgs84 as unknown as [number, number][],
      roads: [],
    });

    expect(result.edges).not.toBeNull();
    expect(result.reason).toBeUndefined();
  });
});
