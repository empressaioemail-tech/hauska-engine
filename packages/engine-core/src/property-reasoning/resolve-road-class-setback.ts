/**
 * Resolve setback NUMBER from the flat district table (edge ROLE only).
 *
 * RULING 2 / WDLL 7 (2026-07-29): road-class must NOT supply setback VALUES.
 * Roads may still identify the front EDGE (role / frontage / rendering).
 * `roadClassSetbackTable` is retired as a value source; kept on the descriptor
 * type only for legacy fixture archaeology — resolvers ignore it.
 */

import { resolveSetbackTableRow } from "./emit-setback-rule.js";
import type {
  HonestAbsence,
  JurisdictionDescriptor,
  RoadEdgeRole,
  ResolvedSetbackRow,
  SetbackFieldProvenance,
  SetbackTableRowProvenance,
} from "./types.js";
import type { RoadClassification } from "@hauska-engine/atoms";

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
 * Resolve the scalar setback (feet) for a district edge ROLE from flat setbackTable.
 * Road class is intentionally not a parameter — values are district+role only.
 */
export function resolveDistrictEdgeSetback(
  descriptor: JurisdictionDescriptor,
  district: string,
  edgeRole: RoadEdgeRole,
): SetbackFieldProvenance | HonestAbsence {
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

/**
 * @deprecated Prefer `resolveDistrictEdgeSetback`. Road class is ignored for
 * VALUES (WDLL 7 / RULING 2). Kept so existing call sites / Caldwell tests
 * keep compiling; all lookups go through the flat district table.
 */
export function resolveRoadClassSetback(
  descriptor: JurisdictionDescriptor,
  district: string,
  _roadClass: RoadClassification,
  edgeRole: RoadEdgeRole,
): SetbackFieldProvenance | HonestAbsence {
  return resolveDistrictEdgeSetback(descriptor, district, edgeRole);
}
