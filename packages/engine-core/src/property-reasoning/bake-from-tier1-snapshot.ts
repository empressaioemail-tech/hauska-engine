/**
 * Shared Tier-1 snapshot → property atom emit (gold bake + county breadth).
 * Confidence composed via contract emitters — never labeling×district multiply.
 * Honest absence: no-zoning-stamp when district missing (null-zoning rule at scale).
 */

import { STORAGE_PORT_PROOF_ATOM_DID } from "@hauska-engine/storage";
import type { PropertyAtomInstance } from "@hauska-engine/atoms";

import { emitBuildableEnvelope } from "./emit-buildable-envelope.js";
import { emitSetbackRule } from "./emit-setback-rule.js";
import { emitZoningFact } from "./emit-zoning-fact.js";
import type { JurisdictionDescriptor } from "./types.js";

export type Tier1SnapshotPayload = {
  bakedAt?: string;
  baseFacts?: { situsCity?: string | null };
  zoning?: { district?: string | null };
  envelope?: {
    status?: string | null;
    buildableAreaSqFt?: number | null;
    setbacks?: {
      front_ft?: number;
      side_ft?: number;
      rear_ft?: number;
    } | null;
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
  };
}

export function emitFromTier1Snapshot(
  parcelNodeId: string,
  snap: Tier1SnapshotPayload,
  countyFips: string,
): EmitFromSnapshotResult {
  const extractedAt = snap.bakedAt || new Date().toISOString();
  const city = snap.baseFacts?.situsCity ?? null;
  const descriptor = descriptorForCounty(parcelNodeId, city, countyFips);
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

  const setbacks = env?.setbacks;
  const hasSetbacks =
    setbacks &&
    typeof setbacks.front_ft === "number" &&
    typeof setbacks.side_ft === "number" &&
    typeof setbacks.rear_ft === "number";

  if (!hasSetbacks || !setbacks) {
    out.notes.push("setback-omitted-no-snapshot-dims");
    return out;
  }

  const frontFt = setbacks.front_ft as number;
  const sideFt = setbacks.side_ft as number;
  const rearFt = setbacks.rear_ft as number;

  const row = {
    atom_did: STORAGE_PORT_PROOF_ATOM_DID,
    match_basis: "exact" as const,
    district_code: zoningDistrict,
    front_ft: {
      value: frontFt,
      confidence: 0.85,
      verification_state: "transcribed" as const,
    },
    side_ft: {
      value: sideFt,
      confidence: 0.85,
      verification_state: "transcribed" as const,
    },
    rear_ft: {
      value: rearFt,
      confidence: 0.85,
      verification_state: "transcribed" as const,
    },
    side_corner_ft: {
      value: sideFt,
      confidence: 0.7,
      verification_state: "transcribed" as const,
    },
  };

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

  const status = env?.status;
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
    | null = null;
  if (status === "no-buildable-area") {
    outcome = {
      kind: "no-buildable-area",
      reason: "Tier-1 snapshot status no-buildable-area",
    };
  } else if (status === "ok") {
    outcome = {
      kind: "buildable",
      areaSqFt:
        typeof env?.buildableAreaSqFt === "number" ? env.buildableAreaSqFt : 0,
    };
  } else {
    out.notes.push(`envelope-omitted-status:${status || "null"}`);
    return out;
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
      "Breadth bake derived envelope from cortex snapshot geometry outcome — assertedConfidence composed via contract (not labeling×district)",
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
