/**
 * Codified setback table → property atoms for stamped zoning parcels.
 *
 * Travis / Central TX serve-rate expectation (SS-W5 audit, 2026-08-23):
 * zoned parcels with a GIS stamp + a row in the adapter setback table should
 * emit (or serve) setback-rule + a provisional envelope even when depth-warm
 * geometry verify fails — only ~3% of Travis zoned parcels are expected to
 * carry depth-warm-promoted geometry; the remainder should still surface table
 * setbacks, not warm-verify-decline + setback-rule-pending.
 */

import {
  getSetbackTableForZoning,
  requiresPerParcelSetbackRecord,
} from "@hauska-engine/adapters";
import type { PropertyAtomInstance } from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import type { WidthedConfidence } from "@empressaio/atom-contract/read-contract";

import { descriptorForCounty } from "./bake-from-tier1-snapshot.js";
import { emitBuildableEnvelope } from "./emit-buildable-envelope.js";
import { emitSetbackRule, resolveSetbackTableRow } from "./emit-setback-rule.js";
import { normalizeCityKey, setbackTableDescriptorFromAdapter } from "./setback-table-from-adapter.js";
import { writePropertyAtomIfEnabled } from "./write-property-atom.js";

export type CodifiedSetbackScalars = {
  front_ft: number;
  side_ft: number;
  rear_ft: number;
  side_interior_ft?: number;
  side_corner_ft?: number;
};

function findRowForResolved(
  rows: ReadonlyArray<{ district_code: string; match_basis: string }>,
  districtCode: string,
  matchBasis: string,
) {
  const wanted = districtCode.trim().toLowerCase();
  return (
    rows.find(
      (r) =>
        r.district_code.toLowerCase() === wanted && r.match_basis === matchBasis,
    ) ?? rows.find((r) => r.district_code.toLowerCase() === wanted)
  );
}

/**
 * Resolve codified table scalars for a stamped jurisdiction + district.
 * Returns null when no table, per-parcel-only jurisdiction, or no row match.
 */
export function resolveCodifiedSetbacksForStamp(
  jurisdictionKey: string | null | undefined,
  district: string | null | undefined,
): CodifiedSetbackScalars | null {
  const cityKey = normalizeCityKey(jurisdictionKey);
  const districtCode =
    typeof district === "string" && district.trim() ? district.trim() : null;
  if (!cityKey || !districtCode) return null;
  if (requiresPerParcelSetbackRecord(cityKey)) return null;

  const adapterTable = getSetbackTableForZoning(cityKey, districtCode);
  if (!adapterTable) return null;

  const setbackTable = setbackTableDescriptorFromAdapter(adapterTable);
  if (!setbackTable) return null;

  const resolved = resolveSetbackTableRow(setbackTable, districtCode);
  if ("kind" in resolved) return null;

  const row = findRowForResolved(
    setbackTable.rows,
    resolved.districtCode,
    resolved.matchBasis,
  );
  if (!row) return null;

  const s = resolved.setbacks;
  return {
    front_ft: s.frontFt,
    side_ft: s.sideFt,
    rear_ft: s.rearFt,
    ...(typeof s.sideCornerFt === "number" ? { side_corner_ft: s.sideCornerFt } : {}),
  };
}

export type EmitTableBackedSetbackInput = {
  parcelNodeId: string;
  countyFips: string;
  district: string;
  cityKey: string;
  zoningFactAtomDid: string;
  /** Asserted confidence from the persisted zoning-fact (required for envelope). */
  zoningAssertedConfidence?: WidthedConfidence | null;
  extractedAt?: string;
};

export type EmitTableBackedSetbackResult = {
  atoms: PropertyAtomInstance[];
  setbackPresent: boolean;
  envelopePresent: boolean;
};

/**
 * Mint setback-rule + provisional-front-edge envelope from the codified table.
 * Mirrors the tail of emitFromTier1Snapshot without re-emitting zoning-fact.
 */
export function emitTableBackedSetbackAtoms(
  input: EmitTableBackedSetbackInput,
): EmitTableBackedSetbackResult | null {
  const cityKey = normalizeCityKey(input.cityKey);
  const district = input.district.trim();
  if (!cityKey || !district) return null;
  if (requiresPerParcelSetbackRecord(cityKey)) return null;

  const adapterTable = getSetbackTableForZoning(cityKey, district);
  const setbackTable = setbackTableDescriptorFromAdapter(adapterTable);
  if (!setbackTable) return null;

  const descriptor = descriptorForCounty(
    input.parcelNodeId,
    cityKey,
    input.countyFips,
    setbackTable,
  );
  const resolved = resolveSetbackTableRow(setbackTable, district);
  if ("kind" in resolved) return null;

  const row = findRowForResolved(
    setbackTable.rows,
    resolved.districtCode,
    resolved.matchBasis,
  );
  if (!row) return null;

  const extractedAt = input.extractedAt ?? new Date().toISOString();
  const setback = emitSetbackRule(descriptor, district, row, input.parcelNodeId);
  if (setback && "kind" in setback && setback.kind === "honest-absence") {
    return null;
  }

  const setbackAtom = setback as PropertyAtomInstance;
  const zAsserted = input.zoningAssertedConfidence ?? null;
  const sAsserted = setbackAtom.readContract?.axes.assertedConfidence;
  const atoms: PropertyAtomInstance[] = [setbackAtom];
  let envelopePresent = false;
  if (zAsserted && sAsserted) {
    const silentAxes =
      row.front_ft?.not_specified === true ||
      row.side_ft?.not_specified === true ||
      row.rear_ft?.not_specified === true;

    const outcome = silentAxes
      ? {
          kind: "provisional-front-edge" as const,
          reason:
            "One or more scalar setbacks are not_specified (build-to-line governs); refuse to derive consume-lot from silent axes",
        }
      : {
          kind: "provisional-front-edge" as const,
          reason:
            "Codified setback table row cited; parcel-ring buildable area not yet derived from geometry (depth-warm declined or pending)",
        };

    const envelope = emitBuildableEnvelope({
      descriptor,
      parcelNodeId: input.parcelNodeId,
      zoningFactAtomDid: input.zoningFactAtomDid,
      setbackRuleAtomDid: setbackAtom.atomDid,
      geometryRefId: `${input.parcelNodeId}/geometry`,
      frontEdgeRefId: `${input.parcelNodeId}/front-edge`,
      outcome,
      inputAssertedConfidences: [zAsserted, sAsserted],
      sourceCitation:
        "Table-backed derived envelope from zoning-FACT + setback-RULE refs — geometry withheld when depth-warm verify declined",
      extractedAt,
    });

    if (envelope && !("kind" in envelope)) {
      atoms.push(envelope as PropertyAtomInstance);
      envelopePresent = true;
    }
  }
  return { atoms, setbackPresent: true, envelopePresent };
}

/**
 * Write table-backed setback (+ provisional envelope) when the parcel has no
 * active setback-rule yet. Does not overwrite an existing setback row.
 */
export async function promoteTableBackedSetbackIfAbsent(
  storage: StoragePort,
  input: EmitTableBackedSetbackInput,
): Promise<{ wrote: boolean; atomDids: string[] }> {
  const existing = await storage.listPropertyAtomsByParcelNodeId(input.parcelNodeId);
  const hasSetback = existing.some(
    (a) =>
      a.entityType === "setback-rule" &&
      (a.status ?? "active") === "active" &&
      a.parcelNodeId === input.parcelNodeId,
  );
  if (hasSetback) return { wrote: false, atomDids: [] };

  const zoningRow = existing.find(
    (a) =>
      a.entityType === "zoning-fact" &&
      (a.status ?? "active") === "active" &&
      a.parcelNodeId === input.parcelNodeId,
  );
  const zoningAsserted =
    input.zoningAssertedConfidence ??
    (zoningRow?.readContract?.axes?.assertedConfidence as
      | WidthedConfidence
      | undefined) ??
    null;

  const emitted = emitTableBackedSetbackAtoms({
    ...input,
    zoningAssertedConfidence: zoningAsserted,
  });
  if (!emitted) return { wrote: false, atomDids: [] };

  const atomDids: string[] = [];
  for (const atom of emitted.atoms) {
    const result = await writePropertyAtomIfEnabled(storage, atom);
    if (result?.atomDid) atomDids.push(result.atomDid);
  }
  return { wrote: atomDids.length > 0, atomDids };
}
