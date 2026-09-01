/**
 * Property node-detail wire shapes (CC-A U1 / WDLL 1, 2, 6).
 *
 * Ports Control Tower NodeDetail (edges_out / edges_in / atom_counts_by_family)
 * onto parcel / road / property-boundary-edge nodes. StoragePort
 * listBoundaryEdgesByParcelNodeId is the sole edge source — no second store.
 */

import {
  BOUNDARY_EDGE_ID_PATTERN,
  buildAtomDid,
  isBoundaryEdgeAtomInstance,
  type BoundaryEdgeAtomInstance,
  type StoredAtomInstance,
} from "@hauska-engine/atoms";
import { classifyBoundaryEdgeSetback } from "@hauska-engine/adapters";
import type { StoragePort } from "@hauska-engine/storage";

export const PARCEL_NODE_ID_RE = /^\d{5}:[A-Za-z0-9._-]+$/;
export const ROAD_NODE_ID_RE = /^\d{5}:road:\d+$/;

export type PropertyGraphNodeType =
  | "parcel"
  | "road"
  | "property-boundary-edge";

export interface PropertyGraphEdge {
  id: string;
  from_node: string;
  type: string;
  to_node: string;
  /** Operator-visible label (role / adjacency / setback hint). */
  label?: string | null;
  provenance?: unknown;
}

export interface PropertyNodeIdentifier {
  identifier_type: string;
  identifier_value: string;
  node_id: string;
}

export interface PropertyNodeSummary {
  node_id: string;
  node_type: PropertyGraphNodeType;
  resolution_status: string;
  status: string;
  name?: string | null;
  /** Type-specific card fields (role/adjacency/setback for boundary-edge). */
  summary?: Record<string, unknown> | null;
}

export interface PropertyNodeDetail {
  available: boolean;
  reason?: string | null;
  requested_node_id: string;
  canonical_node_id: string;
  node: PropertyNodeSummary | null;
  identifiers: PropertyNodeIdentifier[];
  edges_out: PropertyGraphEdge[];
  edges_in: PropertyGraphEdge[];
  atom_counts_by_family: Record<string, number>;
  /** Full boundary-edge atom when inspecting that node type (U1 walk fields). */
  boundary_edge?: BoundaryEdgeAtomInstance | null;
}

export function classifyPropertyNodeId(
  nodeId: string,
): PropertyGraphNodeType | null {
  const id = nodeId.trim();
  if (ROAD_NODE_ID_RE.test(id)) return "road";
  if (BOUNDARY_EDGE_ID_PATTERN.test(id)) return "property-boundary-edge";
  if (PARCEL_NODE_ID_RE.test(id) && !id.includes(":road:") && !id.includes(":boundary:")) {
    return "parcel";
  }
  return null;
}

export function parseBoundaryEdgeId(
  boundaryEdgeId: string,
): { countyFips: string; propId: string; parcelNodeId: string; edgeIndex: number } | null {
  const m = /^(\d{5}):([A-Za-z0-9._-]+):boundary:(\d+)$/.exec(boundaryEdgeId.trim());
  if (!m) return null;
  return {
    countyFips: m[1]!,
    propId: m[2]!,
    parcelNodeId: `${m[1]}:${m[2]}`,
    edgeIndex: Number(m[3]),
  };
}

function serveBoundarySetback(
  setback: BoundaryEdgeAtomInstance["setback"],
): BoundaryEdgeAtomInstance["setback"] | { kind: "no-setback-row"; reason: string } {
  const verdict = classifyBoundaryEdgeSetback(setback);
  if (verdict.disposition === "refused" || verdict.disposition === "unknown") {
    return { kind: "no-setback-row", reason: verdict.basis };
  }
  return setback;
}

function markBoundaryEdgeForServe(
  edge: BoundaryEdgeAtomInstance,
): BoundaryEdgeAtomInstance {
  return { ...edge, setback: serveBoundarySetback(edge.setback) };
}

function setbackLabel(setback: BoundaryEdgeAtomInstance["setback"]): string {
  const served = serveBoundarySetback(setback);
  if ("feet" in served) return `${served.feet}ft`;
  return served.kind;
}

function boundarySummary(edge: BoundaryEdgeAtomInstance): Record<string, unknown> {
  return {
    edgeIndex: edge.edgeIndex,
    role: edge.role,
    adjacencyKind: edge.adjacencyKind,
    setback: serveBoundarySetback(edge.setback),
    parcelNeighborPropId: edge.parcelNeighborPropId,
    facingRoad: edge.facingRoad,
    interior: {
      ringCcw: edge.interior.ringCcw,
      centroidInside: edge.interior.centroidInside,
    },
  };
}

function edgesFromBoundaryAtom(edge: BoundaryEdgeAtomInstance): {
  edges_out: PropertyGraphEdge[];
  edges_in: PropertyGraphEdge[];
} {
  const edges_out: PropertyGraphEdge[] = [];
  const edges_in: PropertyGraphEdge[] = [
    {
      id: `${edge.parcelNodeId}->${edge.boundaryEdgeId}`,
      from_node: edge.parcelNodeId,
      type: "has-boundary-edge",
      to_node: edge.boundaryEdgeId,
      label: `e${edge.edgeIndex} ${edge.role} ${edge.adjacencyKind}`,
    },
  ];

  if (edge.facingRoad?.roadNodeId) {
    edges_out.push({
      id: `${edge.boundaryEdgeId}->${edge.facingRoad.roadNodeId}`,
      from_node: edge.boundaryEdgeId,
      type: "faces-road",
      to_node: edge.facingRoad.roadNodeId,
      label: `${edge.facingRoad.classification} · ${edge.facingRoad.provenance}`,
      provenance: edge.facingRoad,
    });
  }

  if (edge.parcelNeighborPropId) {
    const neighborId = `${edge.countyFips}:${edge.parcelNeighborPropId}`;
    edges_out.push({
      id: `${edge.boundaryEdgeId}->${neighborId}`,
      from_node: edge.boundaryEdgeId,
      type: "adjacent-parcel",
      to_node: neighborId,
      label: `neighbor ${edge.parcelNeighborPropId}`,
    });
  }

  return { edges_out, edges_in };
}

function countFamilies(
  rows: ReadonlyArray<{ entityType?: string }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const fam = row.entityType ?? "unknown";
    counts[fam] = (counts[fam] ?? 0) + 1;
  }
  return counts;
}

export async function listBoundaryEdgesWire(
  storage: StoragePort,
  parcelNodeId: string,
): Promise<{
  available: boolean;
  reason?: string;
  parcelNodeId: string;
  edges: ReadonlyArray<BoundaryEdgeAtomInstance>;
  count: number;
}> {
  const edges = await storage.listBoundaryEdgesByParcelNodeId(parcelNodeId);
  if (edges.length === 0) {
    return {
      available: true,
      reason: "No boundary-edge atoms persisted for this parcel (honest empty).",
      parcelNodeId,
      edges: [],
      count: 0,
    };
  }
  return {
    available: true,
    parcelNodeId,
    edges: edges.map(markBoundaryEdgeForServe),
    count: edges.length,
  };
}

export async function buildParcelNodeDetail(
  storage: StoragePort,
  parcelNodeId: string,
): Promise<PropertyNodeDetail> {
  const propertyRows = await storage.listPropertyAtomsByParcelNodeId(parcelNodeId);
  const boundaryEdges = await storage.listBoundaryEdgesByParcelNodeId(parcelNodeId);

  const edges_out: PropertyGraphEdge[] = boundaryEdges.map((edge) => ({
    id: `${parcelNodeId}->${edge.boundaryEdgeId}`,
    from_node: parcelNodeId,
    type: "has-boundary-edge",
    to_node: edge.boundaryEdgeId,
    label: `e${edge.edgeIndex} · ${edge.role} · ${edge.adjacencyKind} · ${setbackLabel(edge.setback)}`,
    provenance: {
      role: edge.role,
      adjacencyKind: edge.adjacencyKind,
      setback: serveBoundarySetback(edge.setback),
      facingRoad: edge.facingRoad,
      parcelNeighborPropId: edge.parcelNeighborPropId,
    },
  }));

  const atom_counts_by_family = {
    ...countFamilies(propertyRows),
    ...(boundaryEdges.length > 0
      ? { "property-boundary-edge": boundaryEdges.length }
      : {}),
  };

  const hasAny = propertyRows.length > 0 || boundaryEdges.length > 0;
  const [fips, propId] = parcelNodeId.split(":");

  return {
    available: hasAny,
    reason: hasAny
      ? null
      : "No property or boundary-edge atoms for this parcel node.",
    requested_node_id: parcelNodeId,
    canonical_node_id: parcelNodeId,
    node: {
      node_id: parcelNodeId,
      node_type: "parcel",
      resolution_status: hasAny ? "resolved" : "empty",
      status: hasAny ? "active" : "absent",
      name: propId ? `parcel ${propId}` : parcelNodeId,
      summary: {
        countyFips: fips,
        propId,
        boundaryEdgeCount: boundaryEdges.length,
      },
    },
    identifiers: [
      { identifier_type: "parcelNodeId", identifier_value: parcelNodeId, node_id: parcelNodeId },
      ...(fips
        ? [{ identifier_type: "countyFips", identifier_value: fips, node_id: parcelNodeId }]
        : []),
      ...(propId
        ? [{ identifier_type: "propId", identifier_value: propId, node_id: parcelNodeId }]
        : []),
    ],
    edges_out,
    edges_in: [],
    atom_counts_by_family,
  };
}

export async function buildBoundaryEdgeNodeDetail(
  storage: StoragePort,
  boundaryEdgeId: string,
): Promise<PropertyNodeDetail> {
  const parsed = parseBoundaryEdgeId(boundaryEdgeId);
  if (!parsed) {
    return {
      available: false,
      reason: "invalid boundaryEdgeId",
      requested_node_id: boundaryEdgeId,
      canonical_node_id: boundaryEdgeId,
      node: null,
      identifiers: [],
      edges_out: [],
      edges_in: [],
      atom_counts_by_family: {},
      boundary_edge: null,
    };
  }

  const edges = await storage.listBoundaryEdgesByParcelNodeId(parsed.parcelNodeId);
  const edge =
    edges.find((e) => e.boundaryEdgeId === boundaryEdgeId) ??
    edges.find((e) => e.edgeIndex === parsed.edgeIndex) ??
    null;

  if (!edge || !isBoundaryEdgeAtomInstance(edge)) {
    // Fallback: DID lookup when list filter misses a retired/active race.
    const did = buildAtomDid("property-boundary-edge", boundaryEdgeId).raw;
    const byDid = await storage.getAtomByDid(did);
    if (!byDid || !isBoundaryEdgeAtomInstance(byDid)) {
      return {
        available: false,
        reason: `Boundary-edge ${boundaryEdgeId} not found.`,
        requested_node_id: boundaryEdgeId,
        canonical_node_id: boundaryEdgeId,
        node: null,
        identifiers: [],
        edges_out: [],
        edges_in: [],
        atom_counts_by_family: {},
        boundary_edge: null,
      };
    }
    return detailFromBoundaryAtom(byDid);
  }

  return detailFromBoundaryAtom(edge);
}

function detailFromBoundaryAtom(edge: BoundaryEdgeAtomInstance): PropertyNodeDetail {
  const { edges_out, edges_in } = edgesFromBoundaryAtom(edge);
  return {
    available: true,
    reason: null,
    requested_node_id: edge.boundaryEdgeId,
    canonical_node_id: edge.boundaryEdgeId,
    node: {
      node_id: edge.boundaryEdgeId,
      node_type: "property-boundary-edge",
      resolution_status: "resolved",
      status: edge.status,
      name: `edge ${edge.edgeIndex} · ${edge.role}`,
      summary: boundarySummary(edge),
    },
    identifiers: [
      {
        identifier_type: "boundaryEdgeId",
        identifier_value: edge.boundaryEdgeId,
        node_id: edge.boundaryEdgeId,
      },
      {
        identifier_type: "parcelNodeId",
        identifier_value: edge.parcelNodeId,
        node_id: edge.boundaryEdgeId,
      },
      {
        identifier_type: "edgeIndex",
        identifier_value: String(edge.edgeIndex),
        node_id: edge.boundaryEdgeId,
      },
    ],
    edges_out,
    edges_in,
    atom_counts_by_family: { "property-boundary-edge": 1 },
    boundary_edge: markBoundaryEdgeForServe(edge),
  };
}

export async function buildRoadNodeDetail(
  storage: StoragePort,
  roadNodeId: string,
): Promise<PropertyNodeDetail> {
  const rows = await storage.listRoadAtomsByRoadNodeId(roadNodeId);
  const road = rows[0] ?? null;
  if (!road) {
    return {
      available: false,
      reason: `Road node ${roadNodeId} not found.`,
      requested_node_id: roadNodeId,
      canonical_node_id: roadNodeId,
      node: null,
      identifiers: [],
      edges_out: [],
      edges_in: [],
      atom_counts_by_family: {},
    };
  }

  const displayName =
    typeof (road as { displayName?: unknown }).displayName === "string"
      ? ((road as { displayName: string }).displayName)
      : null;
  const classification =
    typeof (road as { classification?: unknown }).classification === "string"
      ? ((road as { classification: string }).classification)
      : null;

  return {
    available: true,
    reason: null,
    requested_node_id: roadNodeId,
    canonical_node_id: roadNodeId,
    node: {
      node_id: roadNodeId,
      node_type: "road",
      resolution_status: "resolved",
      status: "active",
      name: displayName ?? roadNodeId,
      summary: {
        classification,
        // Reverse parcel→road edges are not indexed; walk via boundary-edge card.
        edges_in_note:
          "Inbound parcel/boundary edges are walked from the boundary-edge node (faces-road).",
      },
    },
    identifiers: [
      { identifier_type: "roadNodeId", identifier_value: roadNodeId, node_id: roadNodeId },
      ...(displayName
        ? [{ identifier_type: "displayName", identifier_value: displayName, node_id: roadNodeId }]
        : []),
    ],
    edges_out: [],
    edges_in: [],
    atom_counts_by_family: countFamilies(rows as ReadonlyArray<{ entityType?: string }>),
  };
}

/** Dispatch by canonical id pattern. */
export async function buildPropertyNodeDetail(
  storage: StoragePort,
  nodeId: string,
): Promise<PropertyNodeDetail> {
  const kind = classifyPropertyNodeId(nodeId);
  if (kind === "parcel") return buildParcelNodeDetail(storage, nodeId.trim());
  if (kind === "road") return buildRoadNodeDetail(storage, nodeId.trim());
  if (kind === "property-boundary-edge") {
    return buildBoundaryEdgeNodeDetail(storage, nodeId.trim());
  }
  return {
    available: false,
    reason:
      "invalid node id — expected {fips}:{propId}, {fips}:road:{osm_way_id}, or {fips}:{propId}:boundary:{edgeIndex}",
    requested_node_id: nodeId,
    canonical_node_id: nodeId,
    node: null,
    identifiers: [],
    edges_out: [],
    edges_in: [],
    atom_counts_by_family: {},
  };
}

/** Narrow helper for tests / callers that already hold StoredAtomInstance. */
export function isStoredBoundaryEdge(
  atom: StoredAtomInstance | null | undefined,
): atom is BoundaryEdgeAtomInstance {
  return atom != null && isBoundaryEdgeAtomInstance(atom);
}
