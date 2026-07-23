import type {
  SetbackDimensions,
  SetbackRuleAtomInstance,
} from "@hauska-engine/atoms";

import {
  buildReasoningReadAxes,
  propertyEntityId,
  propertyNotApplicableConsequence,
  sha256HexCanonical,
  widthedFromFieldProvenance,
  widthedFromMatchBasis,
} from "./confidence.js";
import type {
  HonestAbsence,
  JurisdictionDescriptor,
  ResolvedSetbackRow,
  SetbackTableRowProvenance,
} from "./types.js";

function rowToResolved(row: SetbackTableRowProvenance): ResolvedSetbackRow | HonestAbsence {
  const basis = row.match_basis;
  if (basis === "fallback") {
    return {
      kind: "honest-absence",
      parcelNodeId: "",
      reason:
        "Setback table row match basis is fallback — honest absence instead of inventing dimensional rules.",
      code: "setback-fallback",
    };
  }

  const front = row.front_ft;
  const rear = row.rear_ft;
  const side = row.side_ft;
  const sideCorner = row.side_corner_ft;
  if (!front || !rear || !side || !sideCorner) {
    return {
      kind: "honest-absence",
      parcelNodeId: "",
      reason: "Setback table row missing required dimensional fields.",
      code: "setback-incomplete-row",
    };
  }

  const setbacks: SetbackDimensions = {
    frontFt: front.value,
    rearFt: rear.value,
    sideFt: side.value,
    sideCornerFt: sideCorner.value,
    maxHeightFt: row.max_height_ft?.value,
    maxLotCoveragePct: row.max_lot_coverage_pct?.value,
    maxImperviousPct: row.max_impervious_pct?.value,
  };

  const fieldConfidence = {
    frontFt: widthedFromFieldProvenance(front, basis),
    rearFt: widthedFromFieldProvenance(rear, basis),
    sideFt: widthedFromFieldProvenance(side, basis),
    sideCornerFt: widthedFromFieldProvenance(sideCorner, basis),
    maxHeightFt: widthedFromFieldProvenance(row.max_height_ft, basis),
    maxLotCoveragePct: widthedFromFieldProvenance(row.max_lot_coverage_pct, basis),
    maxImperviousPct: widthedFromFieldProvenance(row.max_impervious_pct, basis),
  } as Readonly<Record<keyof SetbackDimensions, ReturnType<typeof widthedFromFieldProvenance>>>;

  return {
    districtCode: row.district_code,
    matchBasis: basis,
    prefixMatched: row.prefix_matched,
    setbacks,
    sourceCodeAtomRef: {
      atomDid: row.atom_did,
      entityType: "code-section",
    },
    fieldConfidence,
  };
}

export function resolveSetbackTableRow(
  table: JurisdictionDescriptor["setbackTable"],
  district: string,
): ResolvedSetbackRow | HonestAbsence {
  if (!table || table.rows.length === 0) {
    return {
      kind: "honest-absence",
      parcelNodeId: "",
      reason: "No setback table configured for jurisdiction descriptor.",
      code: "setback-table-missing",
    };
  }

  const wanted = district.trim().toLowerCase();
  const exact = table.rows.find(
    (r) => r.district_code.toLowerCase() === wanted && r.match_basis === "exact",
  );
  if (exact) return rowToResolved(exact);

  const prefix = table.rows.find(
    (r) =>
      r.match_basis === "prefix" &&
      wanted.startsWith(r.district_code.toLowerCase()),
  );
  if (prefix) return rowToResolved(prefix);

  const fallback = table.rows.find((r) => r.match_basis === "fallback");
  if (fallback) return rowToResolved(fallback);

  return {
    kind: "honest-absence",
    parcelNodeId: "",
    reason: `No setback row matched district "${district}".`,
    code: "setback-no-match",
  };
}

export function emitSetbackRule(
  descriptor: JurisdictionDescriptor,
  district: string,
  setbackTableRow: SetbackTableRowProvenance,
  parcelNodeId: string,
  version = 1,
): SetbackRuleAtomInstance | HonestAbsence {
  const resolved = rowToResolved(setbackTableRow);
  if ("kind" in resolved && resolved.kind === "honest-absence") {
    return { ...resolved, parcelNodeId };
  }
  const row = resolved as ResolvedSetbackRow;

  if (row.districtCode.toLowerCase() !== district.trim().toLowerCase()) {
    const byDistrict = resolveSetbackTableRow(descriptor.setbackTable, district);
    if ("kind" in byDistrict && byDistrict.kind === "honest-absence") {
      return { ...byDistrict, parcelNodeId };
    }
    Object.assign(row, byDistrict);
  }

  const asserted = widthedFromMatchBasis(row.matchBasis);
  const extractedAt = new Date().toISOString();
  const entityId = propertyEntityId(parcelNodeId, "setback", version);
  const instance: SetbackRuleAtomInstance = {
    entityType: "setback-rule",
    entityId,
    jurisdictionTenant: descriptor.jurisdictionTenant,
    parcelNodeId,
    fetchedAt: extractedAt,
    extractedAt,
    sourceAdapter: descriptor.sourceAdapter,
    sourceUrl: descriptor.sourceUrl,
    sourceCitation: `Setback rule for ${row.districtCode} cited to ${row.sourceCodeAtomRef.atomDid}`,
    accessPolicy: descriptor.defaultAccessPolicy,
    atomTier: "data",
    status: "active",
    versionStamp: `${parcelNodeId}:setback-rule:${version}:${extractedAt}`,
    districtCode: row.districtCode,
    matchBasis: row.matchBasis,
    prefixMatched: row.prefixMatched,
    setbacks: row.setbacks,
    sourceCodeAtomRef: row.sourceCodeAtomRef,
    fieldConfidence: row.fieldConfidence,
    reasoningChain: { reasoningKind: "observed" },
    readAxes: buildReasoningReadAxes({
      asserted,
      consequence: propertyNotApplicableConsequence(
        "setback-rule-citation-has-no-life-safety-stratum",
        extractedAt,
      ),
    }),
    contentHash: "",
  };
  instance.contentHash = sha256HexCanonical(JSON.stringify(instance));
  return instance;
}
