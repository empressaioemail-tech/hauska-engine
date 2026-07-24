/**
 * Shared Tier-1 snapshot → property atom emit (gold bake + county breadth).
 * Confidence composed via contract emitters — never labeling×district multiply.
 * Honest absence: no-zoning-stamp when district missing (null-zoning rule at scale).
 *
 * Setback-RULE emit (WDLL 3.4 / 3.5): look up the adapter setback table by the
 * parcel's resolved zoning.jurisdictionKey (PIP cityKey). Dims come from the
 * cited table row, not from Tier-1 envelope.setbacks (anti-zombie: Tier-1 keeps
 * atom_path_pending and does not embed product setbacks).
 *
 * Envelope DERIVED (WDLL 3.6): composes from zoning-FACT + setback-RULE refs.
 * When snapshot lacks a geometry area outcome, emit provisional-front-edge
 * (honest) rather than inventing buildable sqft.
 */

import { getSetbackTable } from "@hauska-engine/adapters";
import type { PropertyAtomInstance } from "@hauska-engine/atoms";

import { emitBuildableEnvelope } from "./emit-buildable-envelope.js";
import { emitSetbackRule, resolveSetbackTableRow } from "./emit-setback-rule.js";
import { emitZoningFact } from "./emit-zoning-fact.js";
import {
  normalizeCityKey,
  setbackTableDescriptorFromAdapter,
} from "./setback-table-from-adapter.js";
import type {
  JurisdictionDescriptor,
  SetbackTableRowProvenance,
} from "./types.js";

export type Tier1SnapshotPayload = {
  bakedAt?: string;
  baseFacts?: { situsCity?: string | null };
  zoning?: {
    district?: string | null;
    /** PIP-stamped cityKey (hyphen or underscore form). */
    jurisdictionKey?: string | null;
  };
  envelope?: {
    status?: string | null;
    buildableAreaSqFt?: number | null;
    setbacks?: {
      front_ft?: number;
      side_ft?: number;
      rear_ft?: number;
    } | null;
    jurisdictionKey?: string | null;
  } | null;
};

export type EmitFromSnapshotResult = {
  atoms: PropertyAtomInstance[];
  notes: string[];
  zoningPresent: boolean;
  zoningAbsence: boolean;
  setbackPresent: boolean;
  envelopePresent: boolean;
};

export function descriptorForCounty(
  parcelNodeId: string,
  cityHint: string | null | undefined,
  countyFips: string,
  setbackTable?: JurisdictionDescriptor["setbackTable"],
): JurisdictionDescriptor {
  const city = (cityHint || "unknown").toLowerCase().replace(/\s+/g, "_");
  return {
    key: `breadth_${countyFips}`,
    displayName: `Breadth bake ${countyFips}`,
    jurisdictionTenant: `breadth_${countyFips}_${city}`,
    parcelFips: countyFips,
    defaultAccessPolicy: "public-free",
    sourceAdapter: "cortex-tier1-snapshot-breadth-bake",
    sourceUrl: "https://hauska.dev/internal/breadth-atom-bake/cortex-snapshot",
    setbackTable,
  };
}

function findRowForResolved(
  rows: ReadonlyArray<SetbackTableRowProvenance>,
  districtCode: string,
  matchBasis: string,
): SetbackTableRowProvenance | undefined {
  const wanted = districtCode.trim().toLowerCase();
  return (
    rows.find(
      (r) =>
        r.district_code.toLowerCase() === wanted && r.match_basis === matchBasis,
    ) ?? rows.find((r) => r.district_code.toLowerCase() === wanted)
  );
}

export function emitFromTier1Snapshot(
  parcelNodeId: string,
  snap: Tier1SnapshotPayload,
  countyFips: string,
): EmitFromSnapshotResult {
  const extractedAt = snap.bakedAt || new Date().toISOString();
  const city = snap.baseFacts?.situsCity ?? null;
  const cityKey =
    normalizeCityKey(snap.zoning?.jurisdictionKey) ??
    normalizeCityKey(snap.envelope?.jurisdictionKey);
  const adapterTable = cityKey ? getSetbackTable(cityKey) : null;
  const setbackTable = setbackTableDescriptorFromAdapter(adapterTable);
  const descriptor = descriptorForCounty(
    parcelNodeId,
    cityKey ?? city,
    countyFips,
    setbackTable,
  );
  const zoningDistrict =
    typeof snap.zoning?.district === "string" && snap.zoning.district.trim()
      ? snap.zoning.district.trim()
      : null;
  const env = snap.envelope && typeof snap.envelope === "object" ? snap.envelope : null;
  const out: EmitFromSnapshotResult = {
    atoms: [],
    notes: [],
    zoningPresent: false,
    zoningAbsence: false,
    setbackPresent: false,
    envelopePresent: false,
  };

  if (!zoningDistrict) {
    const z = emitZoningFact(descriptor, {
      parcelNodeId,
      districtCode: null,
      matchBasis: "exact",
      sourceCitation: `Breadth bake honest-absence from cortex tier1 snapshot (${parcelNodeId})`,
      extractedAt,
    });
    out.atoms.push(z);
    out.notes.push("zoning-absence");
    out.zoningAbsence = true;
    return out;
  }

  const z = emitZoningFact(descriptor, {
    parcelNodeId,
    districtCode: zoningDistrict,
    matchBasis: "exact",
    sourceCitation: `Breadth bake zoning from cortex tier1 snapshot (${parcelNodeId})`,
    extractedAt,
  });
  out.atoms.push(z);
  out.notes.push("zoning");
  out.zoningPresent = true;

  if (!cityKey) {
    out.notes.push("setback-omitted-no-jurisdiction-key");
    return out;
  }
  if (!setbackTable) {
    out.notes.push(`setback-table-missing:${cityKey}`);
    return out;
  }

  const resolved = resolveSetbackTableRow(setbackTable, zoningDistrict);
  if ("kind" in resolved) {
    out.notes.push(`setback-absence:${resolved.code}`);
    return out;
  }

  const row = findRowForResolved(
    setbackTable.rows,
    resolved.districtCode,
    resolved.matchBasis,
  );
  if (!row) {
    out.notes.push("setback-absence:setback-row-lookup-miss");
    return out;
  }

  const setback = emitSetbackRule(
    descriptor,
    zoningDistrict,
    row,
    parcelNodeId,
  );
  if (setback && "kind" in setback && setback.kind === "honest-absence") {
    out.notes.push(`setback-absence:${(setback as { code?: string }).code}`);
    return out;
  }
  out.atoms.push(setback as PropertyAtomInstance);
  out.notes.push("setback");
  out.setbackPresent = true;

  const setbackAtom = setback as PropertyAtomInstance;
  const zAsserted = z.readContract?.axes.assertedConfidence;
  const sAsserted = setbackAtom.readContract?.axes.assertedConfidence;
  if (!zAsserted || !sAsserted) {
    out.notes.push("envelope-omitted-missing-asserted-confidence");
    return out;
  }

  let outcome:
    | { kind: "no-buildable-area"; reason: string }
    | { kind: "buildable"; areaSqFt: number }
    | { kind: "provisional-front-edge"; reason: string };
  if (env?.status === "no-buildable-area") {
    outcome = {
      kind: "no-buildable-area",
      reason: "Tier-1 snapshot status no-buildable-area",
    };
  } else if (
    env?.status === "ok" &&
    typeof env.buildableAreaSqFt === "number"
  ) {
    outcome = { kind: "buildable", areaSqFt: env.buildableAreaSqFt };
  } else {
    // Anti-zombie Tier-1 leaves atom_path_pending with no area — still emit
    // DERIVED envelope composed from fact+rule refs (WDLL 3.6).
    outcome = {
      kind: "provisional-front-edge",
      reason:
        "Setback rule cited; parcel-ring buildable area not yet derived from geometry (Tier-1 atom_path_pending)",
    };
  }

  const envelope = emitBuildableEnvelope({
    descriptor,
    parcelNodeId,
    zoningFactAtomDid: z.atomDid,
    setbackRuleAtomDid: setbackAtom.atomDid,
    geometryRefId: `${parcelNodeId}/geometry`,
    frontEdgeRefId: `${parcelNodeId}/front-edge`,
    outcome,
    inputAssertedConfidences: [zAsserted, sAsserted],
    sourceCitation:
      "Breadth bake derived envelope from zoning-FACT + setback-RULE refs — assertedConfidence composed via contract (not labeling×district)",
    extractedAt,
  });
  if (envelope && "kind" in envelope && envelope.kind === "honest-absence") {
    out.notes.push(`envelope-absence:${(envelope as { code?: string }).code}`);
    return out;
  }
  out.atoms.push(envelope as PropertyAtomInstance);
  out.notes.push("envelope");
  out.envelopePresent = true;
  return out;
}
