/**
 * RULE engine: resolve setback from (road-class, edge-role) + district row.
 * Jurisdiction-agnostic — all values live in the descriptor fixture (27c WDLL 4).
 */

import type { RoadClassification } from "@hauska-engine/atoms";

import { resolveSetbackTableRow } from "./emit-setback-rule.js";
import type {
  HonestAbsence,
  JurisdictionDescriptor,
  RoadClassSetbackRowProvenance,
  RoadEdgeRole,
  ResolvedSetbackRow,
  SetbackFieldProvenance,
  SetbackTableRowProvenance,
} from "./types.js";

function resolveRoadClassRow(
  table: JurisdictionDescriptor["roadClassSetbackTable"],
  district: string,
): RoadClassSetbackRowProvenance | HonestAbsence {
  if (!table || table.rows.length === 0) {
    return {
      kind: "honest-absence",
      parcelNodeId: "",
      reason: "No road-class setback table configured for jurisdiction descriptor.",
      code: "road-class-setback-table-missing",
    };
  }

  const wanted = district.trim().toLowerCase();
  const exact = table.rows.find(
    (r) => r.district_code.toLowerCase() === wanted && r.match_basis === "exact",
  );
  if (exact) return exact;

  const prefix = table.rows.find(
    (r) =>
      r.match_basis === "prefix" &&
      wanted.startsWith(r.district_code.toLowerCase()),
  );
  if (prefix) return prefix;

  const fallback = table.rows.find((r) => r.match_basis === "fallback");
  if (fallback) return fallback;

  return {
    kind: "honest-absence",
    parcelNodeId: "",
    reason: `No road-class setback row matched district "${district}".`,
    code: "road-class-setback-no-match",
  };
}

function flatAxisForRoleFromResolved(
  row: ResolvedSetbackRow,
  edgeRole: RoadEdgeRole,
): SetbackFieldProvenance {
  const conf = row.fieldConfidence;
  switch (edgeRole) {
    case "front":
      return { value: row.setbacks.frontFt, confidence: conf.frontFt.estimate };
    case "rear":
      return { value: row.setbacks.rearFt, confidence: conf.rearFt.estimate };
    case "side":
      return { value: row.setbacks.sideFt, confidence: conf.sideFt.estimate };
    case "side_corner":
      return {
        value: row.setbacks.sideCornerFt,
        confidence: conf.sideCornerFt.estimate,
      };
  }
}

function flatAxisForRoleFromRow(
  row: SetbackTableRowProvenance,
  edgeRole: RoadEdgeRole,
): SetbackFieldProvenance | undefined {
  switch (edgeRole) {
    case "front":
      return row.front_ft;
    case "rear":
      return row.rear_ft;
    case "side":
      return row.side_ft;
    case "side_corner":
      return row.side_corner_ft;
  }
}

/**
 * Resolve the scalar setback (feet) for a classified road edge.
 * Prefers the (road-class, edge-role) cell; falls back to the flat district row.
 */
export function resolveRoadClassSetback(
  descriptor: JurisdictionDescriptor,
  district: string,
  roadClass: RoadClassification,
  edgeRole: RoadEdgeRole,
): SetbackFieldProvenance | HonestAbsence {
  const rcRow = resolveRoadClassRow(descriptor.roadClassSetbackTable, district);
  if ("kind" in rcRow) {
    if (rcRow.code !== "road-class-setback-table-missing") {
      return rcRow;
    }
  } else {
    const hit = rcRow.entries.find(
      (e: (typeof rcRow.entries)[number]) =>
        e.road_class === roadClass && e.edge_role === edgeRole,
    );
    if (hit) return hit.setback_ft;
  }

  const flat = resolveSetbackTableRow(descriptor.setbackTable, district);
  if ("kind" in flat && flat.kind === "honest-absence") {
    return flat;
  }
  const resolved = flat as ResolvedSetbackRow;
  const raw = descriptor.setbackTable?.rows.find(
    (r) => r.district_code.toLowerCase() === district.trim().toLowerCase(),
  );
  const fromRaw = raw ? flatAxisForRoleFromRow(raw, edgeRole) : undefined;
  if (fromRaw) return fromRaw;
  return flatAxisForRoleFromResolved(resolved, edgeRole);
}
