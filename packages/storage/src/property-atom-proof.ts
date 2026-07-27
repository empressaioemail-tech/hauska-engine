/**
 * Gate C property-atom proof fixtures for Central-TX parcel nodes.
 *
 * FIXTURE-ONLY (S-13 / H4) — never a production serving path. District code
 * `RS` is the Hays gold proof stamp, not a live Bastrop Place Type. Do not
 * treat these bodies as GIS-sourced atoms in archaeology.
 *
 * Written via StoragePort (PROPERTY_ATOM_PATH=1). Canonical DIDs match MCP
 * `propertyChainAtomDid(parcelNodeId, entityType)`.
 */

import { createWidthedConfidence } from "@empressaio/atom-contract/read-contract";
import {
  BUILDABLE_ENVELOPE_DERIVATION_METHOD,
  buildAtomDid,
  type BuildableEnvelopeAtomInstance,
  type SetbackRuleAtomInstance,
  type ZoningFactAtomInstance,
} from "@hauska-engine/atoms";

import { STORAGE_PORT_PROOF_ATOM_DID } from "./storage-port-proof.js";

export const HAYS_GOLD_PARCEL = "48209:156346";
export const BEXAR_ABSENCE_PARCEL = "48029:410119";
export const CALDWELL_ROADS_PARCEL = "48055:11386";

export const HAYS_ZONING_DID = buildAtomDid("zoning-fact", HAYS_GOLD_PARCEL).raw;
export const HAYS_SETBACK_DID = buildAtomDid("setback-rule", HAYS_GOLD_PARCEL).raw;
export const HAYS_ENVELOPE_DID = buildAtomDid(
  "buildable-envelope",
  HAYS_GOLD_PARCEL,
).raw;
export const BEXAR_ZONING_DID = buildAtomDid(
  "zoning-fact",
  BEXAR_ABSENCE_PARCEL,
).raw;
export const CALDWELL_ZONING_DID = buildAtomDid(
  "zoning-fact",
  CALDWELL_ROADS_PARCEL,
).raw;

const EXTRACTED_AT = "2026-07-23T20:00:00.000Z";

function asserted(estimate: number, width = 0.12) {
  return createWidthedConfidence({
    estimate,
    n: 0,
    intervalWidth: width,
    provenance: "asserted",
  });
}

function readContract(assertedConfidence: ReturnType<typeof asserted>, basis: string) {
  return {
    axes: {
      assertedConfidence,
      // Placeholder only — calibrated axis resolves at READ via overlay (I-E).
      calibratedConfidence: asserted(assertedConfidence.estimate, assertedConfidence.intervalWidth),
      consequence: {
        kind: "not-applicable" as const,
        reason: basis,
        assertedAt: EXTRACTED_AT,
      },
    },
    assembledAt: EXTRACTED_AT,
  };
}

export function buildHaysZoningFactProof(): ZoningFactAtomInstance {
  return {
    entityType: "zoning-fact",
    atomDid: HAYS_ZONING_DID,
    entityId: HAYS_GOLD_PARCEL,
    jurisdictionTenant: "hays_tx_proof",
    parcelNodeId: HAYS_GOLD_PARCEL,
    fetchedAt: EXTRACTED_AT,
    extractedAt: EXTRACTED_AT,
    sourceAdapter: "property-atom-proof",
    sourceUrl: "https://hauska.dev/internal/property-atom-proof/hays-gold",
    sourceCitation:
      "FIXTURE-ONLY Gate C Hays gold zoning stamp (RS) — PROPERTY_ATOM_PATH proof; not live GIS",
    contentHash: "gate-c-hays-zoning-v1",
    accessPolicy: "public-free",
    atomTier: "data",
    status: "active",
    versionStamp: `${HAYS_GOLD_PARCEL}:zoning-fact:1:${EXTRACTED_AT}`,
    district: "RS",
    matchBasis: "exact",
    reasoningChain: { reasoningKind: "observed" },
    readContract: readContract(asserted(0.9), "zoning-fact-observation-has-no-life-safety-stratum"),
  };
}

export function buildHaysSetbackRuleProof(): SetbackRuleAtomInstance {
  return {
    entityType: "setback-rule",
    atomDid: HAYS_SETBACK_DID,
    entityId: HAYS_GOLD_PARCEL,
    jurisdictionTenant: "hays_tx_proof",
    parcelNodeId: HAYS_GOLD_PARCEL,
    fetchedAt: EXTRACTED_AT,
    extractedAt: EXTRACTED_AT,
    sourceAdapter: "property-atom-proof",
    sourceUrl: "https://hauska.dev/internal/property-atom-proof/hays-gold",
    sourceCitation: `FIXTURE-ONLY setback rule for RS cited to ${STORAGE_PORT_PROOF_ATOM_DID}`,
    contentHash: "gate-c-hays-setback-v1",
    accessPolicy: "public-free",
    atomTier: "data",
    status: "active",
    versionStamp: `${HAYS_GOLD_PARCEL}:setback-rule:1:${EXTRACTED_AT}`,
    districtCode: "RS",
    matchBasis: "exact",
    front: 25,
    side: 5,
    rear: 10,
    sideCornerFt: 10,
    sourceCodeAtomRef: {
      atomDid: STORAGE_PORT_PROOF_ATOM_DID,
      role: "rule",
      entityType: "code-section",
      citationLabel: "Phase 1a storage-port proof code-section",
    },
    fieldProvenance: {
      front: {
        atomDid: STORAGE_PORT_PROOF_ATOM_DID,
        confidence: asserted(0.88, 0.15),
      },
      side: {
        atomDid: STORAGE_PORT_PROOF_ATOM_DID,
        confidence: asserted(0.88, 0.15),
      },
      rear: {
        atomDid: STORAGE_PORT_PROOF_ATOM_DID,
        confidence: asserted(0.88, 0.15),
      },
    },
    reasoningChain: { reasoningKind: "observed" },
    readContract: readContract(asserted(0.88, 0.15), "setback-rule-citation-has-no-life-safety-stratum"),
  };
}

export function buildHaysEnvelopeProof(): BuildableEnvelopeAtomInstance {
  const assertedConfidence = asserted(0.88, 0.15);
  return {
    entityType: "buildable-envelope",
    atomDid: HAYS_ENVELOPE_DID,
    entityId: HAYS_GOLD_PARCEL,
    jurisdictionTenant: "hays_tx_proof",
    parcelNodeId: HAYS_GOLD_PARCEL,
    fetchedAt: EXTRACTED_AT,
    extractedAt: EXTRACTED_AT,
    sourceAdapter: "property-atom-proof",
    sourceUrl: "https://hauska.dev/internal/property-atom-proof/hays-gold",
    sourceCitation:
      "FIXTURE-ONLY Gate C derived buildable-envelope-inset-v1 — assertedConfidence only",
    contentHash: "gate-c-hays-envelope-v1",
    accessPolicy: "public-free",
    atomTier: "data",
    status: "active",
    versionStamp: `${HAYS_GOLD_PARCEL}:buildable-envelope:1:${EXTRACTED_AT}`,
    outcome: { kind: "buildable", areaSqFt: 5100 },
    reasoningChain: {
      reasoningKind: "derived",
      derivationMethod: BUILDABLE_ENVELOPE_DERIVATION_METHOD,
      inputAtomRefs: [
        {
          atomDid: HAYS_ZONING_DID,
          role: "fact",
          entityType: "zoning-fact",
        },
        {
          atomDid: HAYS_SETBACK_DID,
          role: "rule",
          entityType: "setback-rule",
        },
        {
          atomDid: `${HAYS_GOLD_PARCEL}/geometry`,
          role: "reference-field",
          citationLabel: "parcel-geometry-ring",
        },
        {
          atomDid: `${HAYS_GOLD_PARCEL}/front-edge`,
          role: "reference-field",
          citationLabel: "front-edge-anchor",
        },
      ],
    },
    readContract: {
      axes: {
        assertedConfidence,
        // Placeholder asserted — NOT a frozen calibrated multiply; overlay null at READ.
        calibratedConfidence: asserted(assertedConfidence.estimate, assertedConfidence.intervalWidth),
        consequence: {
          kind: "not-applicable",
          reason: "envelope-geometry-derivation-has-no-life-safety-stratum",
          assertedAt: EXTRACTED_AT,
        },
      },
      assembledAt: EXTRACTED_AT,
    },
  };
}

/** Bexar honest-absence zoning — absence.kind no-zoning-stamp, district null, NOT I-2. */
export function buildBexarAbsenceZoningProof(): ZoningFactAtomInstance {
  return {
    entityType: "zoning-fact",
    atomDid: BEXAR_ZONING_DID,
    entityId: BEXAR_ABSENCE_PARCEL,
    jurisdictionTenant: "bexar_tx_proof",
    parcelNodeId: BEXAR_ABSENCE_PARCEL,
    fetchedAt: EXTRACTED_AT,
    extractedAt: EXTRACTED_AT,
    sourceAdapter: "property-atom-proof",
    sourceUrl: "https://hauska.dev/internal/property-atom-proof/bexar-absence",
    sourceCitation: "Gate C Bexar null-zoning honest-absence — no fallback district invent",
    contentHash: "gate-c-bexar-zoning-absence-v1",
    accessPolicy: "public-free",
    atomTier: "data",
    status: "active",
    versionStamp: `${BEXAR_ABSENCE_PARCEL}:zoning-fact:1:${EXTRACTED_AT}`,
    absence: {
      kind: "no-zoning-stamp",
      reason:
        "no-zoning-polygon-covers-parcel — honest absence, decline inventing any fallback district",
    },
    matchBasis: "exact",
    reasoningChain: { reasoningKind: "observed" },
    readContract: readContract(asserted(0.95, 0.1), "zoning-fact-honest-absence-has-no-life-safety-stratum"),
  };
}

/** Optional Caldwell roads parcel — zoning stamp only. */
export function buildCaldwellZoningProof(): ZoningFactAtomInstance {
  return {
    entityType: "zoning-fact",
    atomDid: CALDWELL_ZONING_DID,
    entityId: CALDWELL_ROADS_PARCEL,
    jurisdictionTenant: "caldwell_tx_proof",
    parcelNodeId: CALDWELL_ROADS_PARCEL,
    fetchedAt: EXTRACTED_AT,
    extractedAt: EXTRACTED_AT,
    sourceAdapter: "property-atom-proof",
    sourceUrl: "https://hauska.dev/internal/property-atom-proof/caldwell-roads",
    sourceCitation: "Gate C Caldwell roads parcel zoning stamp (optional)",
    contentHash: "gate-c-caldwell-zoning-v1",
    accessPolicy: "public-free",
    atomTier: "data",
    status: "active",
    versionStamp: `${CALDWELL_ROADS_PARCEL}:zoning-fact:1:${EXTRACTED_AT}`,
    district: "AG",
    matchBasis: "exact",
    reasoningChain: { reasoningKind: "observed" },
    readContract: readContract(asserted(0.8, 0.2), "zoning-fact-observation-has-no-life-safety-stratum"),
  };
}
