import {
  buildAtomDid,
  type SetbackDimensions,
  type SetbackRuleAtomInstance,
} from "@hauska-engine/atoms";
import type { AtomInputRef } from "@empressaio/atom-contract/property";
import type { WidthedConfidence } from "@empressaio/atom-contract/read-contract";

import {
  buildPropertyReadContract,
  contentHashExcludingTimestamps,
  propertyEntityId,
  propertyNotApplicableConsequence,
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
  const front = row.front_ft;
  const rear = row.rear_ft;
  const side = row.side_ft;
  const sideCorner = row.side_corner_ft;
  // 0 is a valid sentinel (often paired with not_specified) — only miss when absent.
  if (
    front === undefined ||
    rear === undefined ||
    side === undefined ||
    sideCorner === undefined
  ) {
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

  const sourceCodeAtomRef: AtomInputRef = {
    atomDid: row.atom_did,
    role: "rule",
    entityType: "code-section",
  };

  const fieldConfidence = {
    frontFt: widthedFromFieldProvenance(front, basis),
    rearFt: widthedFromFieldProvenance(rear, basis),
    sideFt: widthedFromFieldProvenance(side, basis),
    sideCornerFt: widthedFromFieldProvenance(sideCorner, basis),
    maxHeightFt: widthedFromFieldProvenance(row.max_height_ft, basis),
    maxLotCoveragePct: widthedFromFieldProvenance(row.max_lot_coverage_pct, basis),
    maxImperviousPct: widthedFromFieldProvenance(row.max_impervious_pct, basis),
  } as Readonly<Record<keyof SetbackDimensions, WidthedConfidence>>;

  return {
    districtCode: row.district_code,
    matchBasis: basis,
    prefixMatched: row.prefix_matched,
    setbacks,
    sourceCodeAtomRef,
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
  const atomDid = buildAtomDid("setback-rule", entityId).raw;

  const instance: SetbackRuleAtomInstance = {
    entityType: "setback-rule",
    atomDid,
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
    front: row.setbacks.frontFt,
    side: row.setbacks.sideFt,
    /** Interior side yard (AMENDMENT 2 R2); legacy `side` mirrors this. */
    sideInteriorFt: row.setbacks.sideFt,
    rear: row.setbacks.rearFt,
    sideCornerFt: row.setbacks.sideCornerFt,
    maxHeightFt: row.setbacks.maxHeightFt,
    maxLotCoveragePct: row.setbacks.maxLotCoveragePct,
    maxImperviousPct: row.setbacks.maxImperviousPct,
    ...(setbackTableRow.display_meta?.min_lot_size
      ? { minLotSize: setbackTableRow.display_meta.min_lot_size }
      : {}),
    ...(setbackTableRow.display_meta
      ? {
          displayMeta: {
            ...(setbackTableRow.display_meta.min_lot_size
              ? { minLotSize: setbackTableRow.display_meta.min_lot_size }
              : {}),
            ...(setbackTableRow.display_meta.side_fire_code_deferral
              ? { sideFireCodeDeferral: true }
              : {}),
            ...(setbackTableRow.display_meta.side_city_language
              ? { sideCityLanguage: setbackTableRow.display_meta.side_city_language }
              : {}),
            ...(setbackTableRow.display_meta.resolved_district_code !== undefined
              ? { resolvedDistrictCode: setbackTableRow.display_meta.resolved_district_code }
              : {}),
            ...(setbackTableRow.display_meta.split_zone_minor_zones?.length
              ? {
                  splitZoneMinorZones:
                    setbackTableRow.display_meta.split_zone_minor_zones.map((z) => ({
                      districtCode: z.district_code,
                      ...(z.shape_area != null ? { shapeArea: z.shape_area } : {}),
                    })),
                }
              : {}),
            ...(setbackTableRow.display_meta.second_source
              ? {
                  secondSource: {
                    source: setbackTableRow.display_meta.second_source.source,
                    note: setbackTableRow.display_meta.second_source.note,
                    ...(setbackTableRow.display_meta.second_source.citation_url
                      ? {
                          citationUrl:
                            setbackTableRow.display_meta.second_source.citation_url,
                        }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    sourceCodeAtomRef: row.sourceCodeAtomRef,
    fieldProvenance: {
      front: {
        atomDid: row.sourceCodeAtomRef.atomDid,
        confidence: row.fieldConfidence.frontFt,
        ...(setbackTableRow.front_ft?.not_specified === true
          ? { notSpecified: true }
          : {}),
      },
      side: {
        atomDid: row.sourceCodeAtomRef.atomDid,
        confidence: row.fieldConfidence.sideFt,
        ...(setbackTableRow.side_ft?.not_specified === true
          ? { notSpecified: true }
          : {}),
      },
      rear: {
        atomDid: row.sourceCodeAtomRef.atomDid,
        confidence: row.fieldConfidence.rearFt,
        ...(setbackTableRow.rear_ft?.not_specified === true
          ? { notSpecified: true }
          : {}),
      },
    },
    ...(row.matchBasis === "fallback"
      ? {
          absence: {
            kind: "setback-fallback" as const,
            reason:
              "Setback table row match basis is fallback — honest absence grading on conservative default.",
          },
        }
      : {}),
    reasoningChain: { reasoningKind: "observed" },
    readContract: buildPropertyReadContract({
      asserted,
      consequence: propertyNotApplicableConsequence(
        "setback-rule-citation-has-no-life-safety-stratum",
        extractedAt,
      ),
      assembledAt: extractedAt,
    }),
    contentHash: "",
  };
  // A6: exclude provenance timestamps from the hash — content hash must be
  // rewarm-deterministic, not wall-clock-dependent.
  instance.contentHash = contentHashExcludingTimestamps(instance);
  return instance;
}
