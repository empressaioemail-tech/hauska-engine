// chain-assembly.ts
//
// The RETRIEVAL half of the serving path, reproduced so it can run over a
// bulk-read county instead of one HTTP round trip per parcel.
//
// `AtomRetrievalService.getPropertyAtomChain` (packages/retrieval/src/index.ts)
// resolves ONE parcel by calling `StoragePort.listPropertyAtomsByParcelNodeId`,
// which is one indexed query per parcel. At Neon round-trip latency that is
// hours per county and years for Texas, so the sweep reads a county's atoms in
// pages and assembles the same chain in memory.
//
// The two rules that decide what is SERVED — R13/R27 stale-Bastrop-city setback
// suppression and its R27 dependent-envelope invalidation — are NOT re-derived
// here. They are imported from the same modules the live service imports:
// `isStaleBastropCitySetbackRule` from `@hauska-engine/adapters` and
// `envelopeServeIndependentOfStaleSetback` from `../envelope-serve-independent.js`.
//
// `assembly-divergence.test.ts` runs the REAL `getPropertyAtomChain` against a
// storage port and this bulk assembly over the same rows and asserts they agree
// — the paired-control divergence test DEV_PROCESS 2.4 requires, because this
// file and `getPropertyAtomChain` are two implementations of one rule.

import { isStaleBastropCitySetbackRule } from "@hauska-engine/adapters";
import { pickPreferredSetbackRule } from "@hauska-engine/storage";
import { envelopeServeIndependentOfStaleSetback } from "../envelope-serve-independent.js";
import {
  applySetbackProvenanceServe,
  type EnvelopeServeVerdict,
  type SetbackServeVerdict,
} from "../setback-envelope-serve.js";

/** One `atoms` row as the sweep reads it. `body` is the stored atom JSON. */
export interface RawAtomRow {
  entity_type: string;
  entity_id: string;
  body: Record<string, unknown>;
  updated_at?: string | Date | null;
}

/** Minimal stored-atom view the assembly needs. Structural, not nominal. */
export interface AtomLike {
  entityType: string;
  entityId: string;
  parcelNodeId?: string;
  status?: string;
  sourceAdapter?: string | null;
  sourceCodeAtomRef?: { atomDid?: string } | null;
  [key: string]: unknown;
}

/**
 * The chain shape `GET /property-nodes/:id/atom-chain` puts on the wire, in the
 * subset the PE BFF adapter reads (`PropertyAtomChain` in
 * `vendor/atom-chain-to-facets.ts`). The full wire body also carries
 * `atomsByType` and `attachingRoads`; the adapter reads neither, so the sweep
 * does not assemble them. THIS IS AN EXPLICIT SCOPE BOUNDARY, not an omission:
 * a future adapter change that starts reading them invalidates this sweep.
 */
export interface AssembledChain {
  parcelNodeId: string;
  zoningFact: AtomLike | null;
  setbackRule: AtomLike | null;
  buildableEnvelope: AtomLike | null;
  atoms: Array<{ did: string; type: string; kind: string; payload: AtomLike }>;
  /** Observability: true when R13/R27 suppressed a stale city setback rule. */
  staleSetbackSuppressed: boolean;
  setbackServe: SetbackServeVerdict;
  envelopeServe: EnvelopeServeVerdict;
}

/**
 * Per-parcel de-duplication, mirroring `PgStoragePort.listPropertyAtomsByParcelNodeId`
 * (packages/storage/src/pg-storage.ts): one active atom per entityType, and a
 * row whose `entityId` equals the parcel node id beats a suffixed sibling.
 *
 * The live query filters `COALESCE(body->>'status','active') = 'active'` and
 * defends against entity_id prefix collisions with
 * `inst.parcelNodeId !== parcelNodeId`. Both are reproduced.
 */
export function dedupeParcelAtoms(
  parcelNodeId: string,
  rows: ReadonlyArray<AtomLike>,
): AtomLike[] {
  const byType = new Map<string, AtomLike>();
  for (const inst of rows) {
    if ((inst.status ?? "active") !== "active") continue;
    if (inst.parcelNodeId !== parcelNodeId) continue;
    const prior = byType.get(inst.entityType);
    if (!prior) {
      byType.set(inst.entityType, inst);
      continue;
    }
    if (inst.entityType === "setback-rule") {
      byType.set(
        inst.entityType,
        pickPreferredSetbackRule(prior, inst, parcelNodeId),
      );
      continue;
    }
    if (inst.entityId === parcelNodeId && prior.entityId !== parcelNodeId) {
      byType.set(inst.entityType, inst);
    }
  }
  return [...byType.values()];
}

function didOf(atom: AtomLike): string {
  const raw = atom.atomDid;
  if (typeof raw === "string" && raw.startsWith("did:")) return raw;
  return `did:hauska:${atom.entityType}:${atom.entityId}`;
}

/**
 * Assemble the served chain for one parcel from its already-deduped atoms.
 *
 * Mirrors `AtomRetrievalService.getPropertyAtomChain`
 * (packages/retrieval/src/index.ts) with one deliberate omission: the read-time
 * calibration overlay (`applyPropertyCalibrationAtRead`). The overlay is a
 * per-parcel Postgres read against a SEPARATE cortex-side table and is empty in
 * production for every county outside the Hays calibration seed; the sweep
 * records `calibrationOverlayApplied: false` in its resolver version so the
 * exclusion is visible where the output is read, per DEV_PROCESS 2.1.
 */
export function assembleChain(
  parcelNodeId: string,
  dedupedAtoms: ReadonlyArray<AtomLike>,
): AssembledChain {
  let zoningFact: AtomLike | null = null;
  let setbackRule: AtomLike | null = null;
  let buildableEnvelope: AtomLike | null = null;
  for (const row of dedupedAtoms) {
    if (row.entityType === "zoning-fact") zoningFact = row;
    else if (row.entityType === "setback-rule") setbackRule = row;
    else if (row.entityType === "buildable-envelope") buildableEnvelope = row;
  }

  const zoningAdapter =
    zoningFact && typeof zoningFact.sourceAdapter === "string"
      ? zoningFact.sourceAdapter
      : "";
  const isBastropCityZoning =
    zoningAdapter.includes("bastrop-city") ||
    zoningAdapter.includes("txgio-zoning-stamp:bastrop-city-tx");

  let staleSetbackSuppressed = false;
  if (
    setbackRule &&
    isBastropCityZoning &&
    isStaleBastropCitySetbackRule({
      parcelNodeId,
      sourceAdapter:
        typeof setbackRule.sourceAdapter === "string"
          ? setbackRule.sourceAdapter
          : null,
      sourceCodeAtomDid:
        setbackRule.sourceCodeAtomRef &&
        typeof setbackRule.sourceCodeAtomRef === "object" &&
        typeof setbackRule.sourceCodeAtomRef.atomDid === "string"
          ? setbackRule.sourceCodeAtomRef.atomDid
          : null,
    })
  ) {
    setbackRule = null;
    staleSetbackSuppressed = true;
    if (
      !envelopeServeIndependentOfStaleSetback(
        buildableEnvelope as never | null,
      )
    ) {
      buildableEnvelope = null;
    }
  }

  const atoms = dedupedAtoms
    .filter((payload) => {
      if (!staleSetbackSuppressed) return true;
      if (payload.entityType === "setback-rule") return false;
      if (payload.entityType === "buildable-envelope") {
        return envelopeServeIndependentOfStaleSetback(payload as never);
      }
      return true;
    })
    .map((payload) => ({
      did: didOf(payload),
      type: payload.entityType,
      kind: payload.entityType,
      payload,
    }));

  const serve = applySetbackProvenanceServe({
    setbackRule,
    buildableEnvelope,
  });

  return {
    parcelNodeId,
    zoningFact,
    setbackRule,
    buildableEnvelope,
    atoms,
    staleSetbackSuppressed,
    setbackServe: serve.setbackServe,
    envelopeServe: serve.envelopeServe,
  };
}
