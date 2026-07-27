/**
 * CC-A U1 / WDLL 6 — boundary-edges HTTP + node-detail walkability.
 */

import { describe, expect, it } from "vitest";

import type { BoundaryEdgeAtomInstance } from "@hauska-engine/atoms";
import { buildAtomDid } from "@hauska-engine/atoms";
import { InMemoryStorage } from "@hauska-engine/storage";
import {
  buildHaysEnvelopeProof,
  buildHaysSetbackRuleProof,
  buildHaysZoningFactProof,
} from "@hauska-engine/storage";

import { buildApp } from "../server.js";

function boundaryEdge(spec: {
  parcelNodeId: string;
  edgeIndex: number;
  role: BoundaryEdgeAtomInstance["role"];
  adjacencyKind: BoundaryEdgeAtomInstance["adjacencyKind"];
  neighborPropId?: string | null;
  roadNodeId?: string | null;
  setbackFeet?: number;
}): BoundaryEdgeAtomInstance {
  const [countyFips, propId] = spec.parcelNodeId.split(":") as [string, string];
  const boundaryEdgeId = `${spec.parcelNodeId}:boundary:${spec.edgeIndex}`;
  return {
    entityType: "property-boundary-edge",
    atomDid: buildAtomDid("property-boundary-edge", boundaryEdgeId).raw,
    boundaryEdgeId,
    entityId: boundaryEdgeId,
    parcelNodeId: spec.parcelNodeId,
    countyFips,
    propId,
    edgeIndex: spec.edgeIndex,
    role: spec.role,
    adjacencyKind: spec.adjacencyKind,
    parcelNeighborPropId: spec.neighborPropId ?? null,
    facingRoad: spec.roadNodeId
      ? {
          roadNodeId: spec.roadNodeId,
          classification: "residential",
          provenance: "test",
          osmHighwayTag: "residential",
        }
      : null,
    setback:
      spec.setbackFeet != null
        ? {
            feet: spec.setbackFeet,
            provenance: "road-class-setback-table",
          }
        : {
            kind: "unmapped-adjacency",
            reason: "unmapped",
          },
    interior: {
      ringCcw: true,
      centroidInside: true,
      inwardNormal: { x: 0, y: 1 },
      edgeEndpoints: [
        [0, 0],
        [1, 0],
      ],
    },
    effectiveDate: "2026-07-27",
    status: "active",
    supersedesEntityId: null,
    reasoningChain: { reasoningKind: "observed" },
    accessPolicy: "platform-internal",
    sourceCitation: "cc-a-u1 fixture",
    extractedAt: "2026-07-27T00:00:00.000Z",
    atomTier: "data",
    jurisdictionTenant: "bastrop_tx",
    fetchedAt: "2026-07-27T00:00:00.000Z",
    sourceAdapter: "test",
    sourceUrl: "test://",
    contentHash: "fixture",
  };
}

describe("CC-A U1 node organism HTTP (WDLL 1/2/6)", () => {
  it("GET /property-nodes/:id/boundary-edges serves StoragePort edges (was 404)", async () => {
    const storage = new InMemoryStorage();
    await storage.writeBoundaryEdgeAtom(
      boundaryEdge({
        parcelNodeId: "48021:28286",
        edgeIndex: 1,
        role: "side",
        adjacencyKind: "neighbor-parcel",
        neighborPropId: "32341",
      }),
    );
    await storage.writeBoundaryEdgeAtom(
      boundaryEdge({
        parcelNodeId: "48021:28286",
        edgeIndex: 2,
        role: "front",
        adjacencyKind: "ROW",
        neighborPropId: "35671",
        roadNodeId: "48021:road:999",
        setbackFeet: 15,
      }),
    );

    const app = buildApp({ storage, apiKey: "" });
    const res = await app.request("/property-nodes/48021:28286/boundary-edges");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      parcelNodeId: string;
      count: number;
      edges: Array<{ boundaryEdgeId: string; edgeIndex: number }>;
    };
    expect(body.parcelNodeId).toBe("48021:28286");
    expect(body.count).toBe(2);
    expect(body.edges.map((e) => e.edgeIndex)).toEqual([1, 2]);
  });

  it("GET /nodes/:parcel walks parcel → boundary → road + neighbor (PRE-2 gold)", async () => {
    const storage = new InMemoryStorage();
    await storage.writePropertyAtom(buildHaysZoningFactProof());
    // Re-key Hays proofs aren't needed — seed 28286 zoning lightly via empty parcel detail + edges.
    await storage.writeBoundaryEdgeAtom(
      boundaryEdge({
        parcelNodeId: "48021:28286",
        edgeIndex: 1,
        role: "side",
        adjacencyKind: "neighbor-parcel",
        neighborPropId: "32341",
      }),
    );
    await storage.writeBoundaryEdgeAtom(
      boundaryEdge({
        parcelNodeId: "48021:28286",
        edgeIndex: 2,
        role: "front",
        adjacencyKind: "ROW",
        neighborPropId: "35671",
        roadNodeId: "48021:road:999",
        setbackFeet: 15,
      }),
    );

    const app = buildApp({ storage, apiKey: "" });

    const parcel = await app.request("/nodes/48021:28286");
    expect(parcel.status).toBe(200);
    const parcelBody = (await parcel.json()) as {
      node: { node_type: string };
      edges_out: Array<{ to_node: string; type: string; label?: string }>;
      atom_counts_by_family: Record<string, number>;
    };
    expect(parcelBody.node.node_type).toBe("parcel");
    expect(parcelBody.edges_out).toHaveLength(2);
    expect(parcelBody.atom_counts_by_family["property-boundary-edge"]).toBe(2);

    const frontEdgeId = "48021:28286:boundary:2";
    const edgeRes = await app.request(`/nodes/${encodeURIComponent(frontEdgeId)}`);
    expect(edgeRes.status).toBe(200);
    const edgeBody = (await edgeRes.json()) as {
      node: { summary: { role: string; adjacencyKind: string } };
      boundary_edge: { role: string };
      edges_out: Array<{ to_node: string; type: string }>;
      edges_in: Array<{ from_node: string }>;
    };
    expect(edgeBody.node.summary.role).toBe("front");
    expect(edgeBody.node.summary.adjacencyKind).toBe("ROW");
    expect(edgeBody.boundary_edge.role).toBe("front");
    expect(edgeBody.edges_in[0]?.from_node).toBe("48021:28286");
    expect(edgeBody.edges_out.map((e) => e.to_node).sort()).toEqual([
      "48021:35671",
      "48021:road:999",
    ]);

    const byPath = await app.request(
      `/boundary-edges/${encodeURIComponent(frontEdgeId)}`,
    );
    expect(byPath.status).toBe(200);
  });

  it("honest-empty boundary-edges when none persisted", async () => {
    const app = buildApp({ storage: new InMemoryStorage(), apiKey: "" });
    const res = await app.request("/property-nodes/48021:33512/boundary-edges");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; reason?: string };
    expect(body.count).toBe(0);
    expect(body.reason).toMatch(/honest empty/i);
  });

  it("atom-chain still returns 200 without inventing edge refs", async () => {
    const storage = new InMemoryStorage();
    await storage.writePropertyAtom(buildHaysZoningFactProof());
    await storage.writePropertyAtom(buildHaysSetbackRuleProof());
    await storage.writePropertyAtom(buildHaysEnvelopeProof());
    const app = buildApp({ storage, apiKey: "" });
    const res = await app.request("/property-nodes/48209:156346/atom-chain");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.zoningFact).toBeTruthy();
    // Edge graph is on /nodes + /boundary-edges, not atom-chain.
    expect(body.boundaryEdges).toBeUndefined();
  });
});
