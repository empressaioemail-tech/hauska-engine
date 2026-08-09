/**
 * Turn a {@link CountyParcelNodePlan} into contract-valid `parcel-node` atoms,
 * and verify what was persisted against the exact stored bytes.
 *
 * This module owns the two halves of Geometry Law rule 3 (write-then-verify)
 * that are testable without a database:
 *
 *   - every atom is produced ONLY through the `@hauska-engine/atoms` writer
 *     seam, which runs `PARCEL_NODE_SCHEMA.parse` before returning, so an
 *     invalid shape cannot reach the store; and
 *   - {@link verifyStoredParcelNodeAtom} re-validates a row READ BACK from the
 *     store against the same contract schema and against the plan that
 *     produced it. Gating one representation and serving another is the master
 *     defect class this program spent a week killing; the read-back check is
 *     what makes that impossible here.
 */

import {
  PARCEL_NODE_SCHEMA,
  buildCountyCoverageAbsenceAtom,
  buildParcelNodeAbsenceAtom,
  buildResolvedParcelNodeAtom,
  countyCoverageParcelNodeId,
  type ParcelNodeAtomInstance,
  type ParcelNodeWriteProvenance,
} from "@hauska-engine/atoms";

import type {
  CountyParcelNodePlan,
  PlannedParcelNode,
} from "./plan-county-parcel-nodes.js";

/**
 * Provenance for a county run, minus the per-atom `contentHash` this module
 * derives. `observedAt` is fixed for the whole run so a re-run over unchanged
 * source produces byte-identical bodies (idempotence, below).
 */
export type CountyRunProvenance = Omit<
  ParcelNodeWriteProvenance,
  "contentHash" | "observedAt"
> & { observedAt: string };

/**
 * Deterministic content hash over the IDENTITY-AND-CLAIM of the atom, not over
 * its provenance timestamps.
 *
 * Idempotence requirement: re-running the writer over an unchanged county must
 * not produce a new row, and `writePropertyAtomsBatch` upserts on `atom_did`,
 * so row identity is already stable. The hash must be stable too, or a re-run
 * would rewrite every row with a fresh `content_hash` and a downstream
 * change-detector would see the whole county churn on every pass. Hashing the
 * claim (not `extractedAt`/`fetchedAt`) is the same convention
 * `contentHashExcludingProvenance` applies on the property-reasoning path.
 */
export function parcelNodeContentHash(parts: {
  parcelNodeId: string;
  keyKind: string;
  geometrySourceTier: string;
  geometryLoaded: boolean;
  sourceVintage?: string;
  absenceKind?: string;
  absenceReason?: string;
  verifiedAbsenceScope?: ReadonlyArray<string>;
  additionalFeatureIndexes?: ReadonlyArray<number>;
}): string {
  const canonical = JSON.stringify([
    parts.parcelNodeId,
    parts.keyKind,
    parts.geometrySourceTier,
    parts.geometryLoaded,
    parts.sourceVintage ?? null,
    parts.absenceKind ?? null,
    parts.absenceReason ?? null,
    parts.verifiedAbsenceScope ? [...parts.verifiedAbsenceScope] : null,
    parts.additionalFeatureIndexes ? [...parts.additionalFeatureIndexes] : null,
  ]);
  // FNV-1a 64-bit; no node:crypto import so this module stays usable from the
  // same places the rest of the property-reasoning helpers are.
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= BigInt(canonical.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

/**
 * Build the atom for one planned entry.
 *
 * Throws (via the seam's `PARCEL_NODE_SCHEMA.parse`) rather than returning a
 * degraded atom — a shape the contract rejects must never reach a batch.
 */
export function buildAtomForPlanned(
  entry: PlannedParcelNode,
  countyFips: string,
  geometrySourceTier: "txgio-stratmap" | "county-arcgis-override",
  provenance: CountyRunProvenance,
): ParcelNodeAtomInstance {
  const parcelNodeId = `${countyFips}:${entry.parcelKey}`;

  if (entry.outcome === "resolved") {
    return buildResolvedParcelNodeAtom(
      {
        countyFips,
        parcelKey: entry.parcelKey,
        keyKind: entry.keyKind,
        geometrySourceTier,
      },
      {
        ...provenance,
        sourceVintage: entry.sourceVintage,
        contentHash: parcelNodeContentHash({
          parcelNodeId,
          keyKind: entry.keyKind,
          geometrySourceTier,
          geometryLoaded: true,
          sourceVintage: entry.sourceVintage,
          additionalFeatureIndexes: entry.additionalFeatureIndexes,
        }),
      },
    );
  }

  return buildParcelNodeAbsenceAtom(
    {
      countyFips,
      parcelKey: entry.parcelKey,
      keyKind: entry.keyKind,
      geometrySourceTier,
      absenceKind: entry.absenceKind,
      reason: entry.reason,
    },
    {
      ...provenance,
      sourceVintage: entry.sourceVintage,
      contentHash: parcelNodeContentHash({
        parcelNodeId,
        keyKind: entry.keyKind,
        geometrySourceTier,
        geometryLoaded: false,
        sourceVintage: entry.sourceVintage,
        absenceKind: entry.absenceKind,
        absenceReason: entry.reason,
      }),
    },
  );
}

/** Build every atom a plan predicts, in plan order. */
export function buildAtomsForPlan(
  plan: CountyParcelNodePlan,
  geometrySourceTier: "txgio-stratmap" | "county-arcgis-override",
  provenance: CountyRunProvenance,
): ReadonlyArray<ParcelNodeAtomInstance> {
  return plan.planned.map((entry) =>
    buildAtomForPlanned(entry, plan.countyFips, geometrySourceTier, provenance),
  );
}

/**
 * Build the county-level `_county_coverage` anchor for a county with NO
 * published ring source.
 *
 * This is what lets Rail 1 read satisfied-absent for such a county instead of
 * sitting at not-yet forever. It is NOT for a county that simply has not been
 * ingested yet — that county is genuinely not-yet, and claiming verified
 * absence for it would be a lie with provenance attached. The caller must have
 * actually probed the sources it lists.
 */
export function buildCountyCoverageAtom(
  countyFips: string,
  provenanceScope: ReadonlyArray<string>,
  provenance: CountyRunProvenance,
): ParcelNodeAtomInstance {
  return buildCountyCoverageAbsenceAtom(
    { countyFips, provenanceScope },
    {
      ...provenance,
      contentHash: parcelNodeContentHash({
        parcelNodeId: countyCoverageParcelNodeId(countyFips),
        keyKind: "prop_id",
        geometrySourceTier: "absent",
        geometryLoaded: false,
        verifiedAbsenceScope: provenanceScope,
      }),
    },
  );
}

export type StoredAtomVerdict =
  | { ok: true }
  | { ok: false; parcelNodeId: string; problem: string };

/**
 * Geometry Law rule 3 — validate a row as READ BACK from the store.
 *
 * `stored` must be the body actually retrieved from `atoms`, never the
 * in-memory object that was written. Checks, in order:
 *   1. the stored bytes still satisfy `PARCEL_NODE_SCHEMA`;
 *   2. the stored atom is the one the plan predicted (same id, same outcome);
 *   3. a resolved atom's pointer names the same county+key it claims, so the
 *      pointer actually resolves in `txgio_parcel`.
 */
export function verifyStoredParcelNodeAtom(
  stored: unknown,
  expected: { parcelNodeId: string; outcome: "resolved" | "absent" },
): StoredAtomVerdict {
  const parsed = PARCEL_NODE_SCHEMA.safeParse(stored);
  if (!parsed.success) {
    return {
      ok: false,
      parcelNodeId: expected.parcelNodeId,
      problem: `stored bytes fail PARCEL_NODE_SCHEMA: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }
  const atom = parsed.data;
  if (atom.parcelNodeId !== expected.parcelNodeId) {
    return {
      ok: false,
      parcelNodeId: expected.parcelNodeId,
      problem: `stored parcelNodeId ${atom.parcelNodeId} != expected ${expected.parcelNodeId}`,
    };
  }
  const storedOutcome = atom.geometryLoaded ? "resolved" : "absent";
  if (storedOutcome !== expected.outcome) {
    return {
      ok: false,
      parcelNodeId: expected.parcelNodeId,
      problem: `stored outcome ${storedOutcome} != planned ${expected.outcome}`,
    };
  }
  if (expected.outcome === "resolved") {
    const ref = atom.geometryStoreRef;
    if (!ref) {
      return {
        ok: false,
        parcelNodeId: expected.parcelNodeId,
        problem: "resolved atom stored without geometryStoreRef",
      };
    }
    if (`${ref.countyFips}:${ref.propId}` !== atom.parcelNodeId) {
      return {
        ok: false,
        parcelNodeId: expected.parcelNodeId,
        problem:
          `geometryStoreRef points at ${ref.countyFips}:${ref.propId} but the atom is ` +
          `${atom.parcelNodeId} — the pointer would resolve a different parcel`,
      };
    }
  } else if (atom.geometryStoreRef) {
    return {
      ok: false,
      parcelNodeId: expected.parcelNodeId,
      problem: "absence atom stored with a geometryStoreRef",
    };
  }
  return { ok: true };
}
