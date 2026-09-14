/**
 * Depth-warm RE-MINT preview (P-186, OPS-23 wave 6, plan row P-154).
 *
 * WHY THIS EXISTS. `depth-warm-city-batch.mjs --parcel=<id> --promote` is the
 * only path that persists a `setback-rule` atom: `promote.ts` ->
 * `emitSetbackRule` -> `writePropertyAtomIfEnabled` -> `PgStorage.writePropertyAtom`,
 * which is an `INSERT ... ON CONFLICT (atom_did) DO UPDATE SET body = EXCLUDED.body`
 * with NO version row and NO history table for property atoms. A re-mint
 * therefore OVERWRITES the live body IN PLACE, and the only pre-write look an
 * operator can get is the payload the dry leg would have written. That payload
 * is what this module renders.
 *
 * WHAT THE OPERATOR HAS TO BE ABLE TO SEE. P-154 wave 6 turned the A-148
 * same-layer conflict into a STRUCTURED payload
 * (`displayMeta.secondSource.conflict`) minted by the adapter's own detector
 * (`getSetbackTableForZoning` -> `resolveBastropEuclideanCandidate`, off the
 * LIVE layer-23 record's own text-versus-unrefreshed-numeric readings). If that
 * detector does not fire for the parcel on the day of the run, the apply leg is
 * a SUCCESSFUL NO-OP: exit 0, a nonzero `verifyPass`/`promoted` count, and a
 * body whose `conflict` is absent. Two distinct outcomes have to be told apart,
 * and the preview names both rather than collapsing them:
 *
 *   - `conflictPresent: false` — the A-148 detector did not fire. The write
 *     improves nothing about the disclosure; the run is a no-op *for the
 *     purpose the re-mint exists for*.
 *   - `secondSourcePresent: false` — the emitted body carries no
 *     `secondSource` AT ALL. Because the write is an in-place upsert, this
 *     DELETES whatever `secondSource` the live row carries today (the
 *     pre-A-148 prose confession the surfaces print). That is a regression, not
 *     a no-op, and the preview flags it separately.
 *
 * PREVIEW IS EMIT-ONLY. `emitDepthWarmPromotion` is pure — it mints atom
 * instances and touches no store — so a preview built from it is exactly the
 * body set the apply leg would upsert, with one honest caveat: `emitSetbackRule`
 * / `emitBuildableEnvelope` stamp `fetchedAt`/`extractedAt` at emit time and
 * `contentHash` is derived from them, so a preview's `contentHash` is NOT the
 * apply leg's. Compare the live `content_hash` before/after; never compare a
 * preview hash to a stored hash.
 *
 * NOT A GATE. This function reports; it never refuses. Whether a payload with
 * no conflict is acceptable is the operator's call (for `48021:34049` it is the
 * whole point of the run), and a preview that refused to show such a payload
 * would be unable to tell the operator that the A-148 predicate did not fire.
 */

import type {
  BuildableEnvelopeAtomInstance,
  PropertyAtomInstance,
  SetbackRuleAtomInstance,
} from "@hauska-engine/atoms";

import type { DepthWarmPromotionEmit } from "./promote.js";

/** One atom body the apply leg would upsert, with the identity columns it lands under. */
export interface RemintPreviewAtom {
  entityType: string;
  entityId: string;
  atomDid: string;
  contentHash: string;
  /** The whole body, verbatim — this is what `INSERT ... ON CONFLICT` writes. */
  body: PropertyAtomInstance;
}

export interface RemintPreviewSetbackRule {
  entityId: string;
  atomDid: string;
  contentHash: string;
  districtCode: string | null;
  /** Does the body carry `displayMeta.secondSource` at all? */
  secondSourcePresent: boolean;
  /** Does it carry the structured P-154 wave 6 payload (`secondSource.conflict`)? */
  conflictPresent: boolean;
  /** `"stale-numeric-columns"` (A-148) or `"second-source"` (R-1 two-instrument), else null. */
  conflictShape: string | null;
  /** The second source's own prose note, verbatim, else null. */
  secondSourceNote: string | null;
}

export interface RemintPreviewEnvelope {
  entityId: string;
  atomDid: string;
  contentHash: string;
  /** Whether the emitted envelope carries the drawn ring (`geojson`). */
  geojsonPresent: boolean;
}

export interface RemintPreview {
  event: "depth-warm.remint-preview";
  parcelNodeId: string;
  /** Every property atom the apply leg would upsert, in emit order. */
  wouldWrite: RemintPreviewAtom[];
  setbackRule: RemintPreviewSetbackRule | null;
  buildableEnvelope: RemintPreviewEnvelope | null;
  /**
   * TRUE means the emitted body carries NO `secondSource`, so this in-place
   * upsert would DELETE the live row's disclosure. A regression, not a no-op.
   */
  deletesExistingDisclosure: boolean;
  /**
   * TRUE means the A-148/R-1 detector did not fire: the write lands but changes
   * nothing about the disclosure. The run is a successful no-op for the remit's
   * purpose — the operator must not read exit 0 as "the risk is now wired".
   */
  noOpForConflict: boolean;
  note: string;
}

function setbackAtomOf(
  atoms: ReadonlyArray<PropertyAtomInstance>,
): SetbackRuleAtomInstance | null {
  const hit = atoms.find((a) => a.entityType === "setback-rule");
  return (hit as SetbackRuleAtomInstance | undefined) ?? null;
}

function envelopeAtomOf(
  atoms: ReadonlyArray<PropertyAtomInstance>,
): BuildableEnvelopeAtomInstance | null {
  const hit = atoms.find((a) => a.entityType === "buildable-envelope");
  return (hit as BuildableEnvelopeAtomInstance | undefined) ?? null;
}

/**
 * Render the payload a `--parcel` dry leg WOULD upsert, without writing.
 *
 * `emitted` is `emitDepthWarmPromotion`'s return value (the same call
 * `promoteDepthWarmToStorage` makes before it writes) — never a snapshot or
 * corpus-derived table, which cannot carry `displayMeta.secondSource` at all.
 */
export function buildRemintPreview(
  parcelNodeId: string,
  emitted: DepthWarmPromotionEmit,
): RemintPreview {
  const wouldWrite: RemintPreviewAtom[] = emitted.propertyAtoms.map((atom) => ({
    entityType: atom.entityType,
    entityId: atom.entityId,
    atomDid: atom.atomDid,
    contentHash: atom.contentHash,
    body: atom,
  }));

  const setback = setbackAtomOf(emitted.propertyAtoms);
  const envelope = envelopeAtomOf(emitted.propertyAtoms);

  const secondSource = setback?.displayMeta?.secondSource ?? null;
  const conflict = secondSource?.conflict ?? null;
  const secondSourcePresent = secondSource != null;
  const conflictPresent = conflict != null;

  const setbackRule: RemintPreviewSetbackRule | null = setback
    ? {
        entityId: setback.entityId,
        atomDid: setback.atomDid,
        contentHash: setback.contentHash,
        districtCode: setback.districtCode ?? null,
        secondSourcePresent,
        conflictPresent,
        conflictShape: conflict ? conflict.shape : null,
        secondSourceNote: secondSource ? secondSource.note : null,
      }
    : null;

  const buildableEnvelope: RemintPreviewEnvelope | null = envelope
    ? {
        entityId: envelope.entityId,
        atomDid: envelope.atomDid,
        contentHash: envelope.contentHash,
        // The drawn ring is not a declared field on the atom type (`promote.ts`
        // reads it back through a structural cast); read it the same way rather
        // than claiming a property the type does not carry.
        geojsonPresent: (envelope as { geojson?: unknown }).geojson != null,
      }
    : null;

  const deletesExistingDisclosure = setback != null && !secondSourcePresent;
  const noOpForConflict = setback != null && !conflictPresent;

  const parts: string[] = [];
  if (!setback) {
    parts.push(
      "no setback-rule atom would be emitted for this parcel — the apply leg writes nothing for it",
    );
  } else if (deletesExistingDisclosure) {
    parts.push(
      "WARNING: the emitted setback-rule body carries NO displayMeta.secondSource; " +
        "the in-place upsert (ON CONFLICT (atom_did) DO UPDATE SET body = EXCLUDED.body) " +
        "would DELETE whatever secondSource the live row carries today",
    );
  } else if (noOpForConflict) {
    parts.push(
      "NO-OP FOR CONFLICT: the emitted setback-rule body carries a secondSource prose note " +
        "but NO structured conflict payload — the A-148/R-1 detector did not fire for this " +
        "parcel in this run, so the run will exit 0 and change nothing about the disclosure",
    );
  } else {
    parts.push(
      `conflict payload present (shape=${conflict?.shape}) — this is the payload the surfaces print`,
    );
  }
  parts.push(
    "preview contentHash is emit-time only (extractedAt/fetchedAt are minted at emit) — " +
      "compare the stored row's content_hash before/after, never a preview hash to a stored hash",
  );

  return {
    event: "depth-warm.remint-preview",
    parcelNodeId,
    wouldWrite,
    setbackRule,
    buildableEnvelope,
    deletesExistingDisclosure,
    noOpForConflict,
    note: parts.join(" | "),
  };
}

/** The preview a run that would write NOTHING emits, with the reason it is empty. */
export function emptyRemintPreview(
  parcelNodeId: string,
  reason: string,
): RemintPreview {
  return {
    event: "depth-warm.remint-preview",
    parcelNodeId,
    wouldWrite: [],
    setbackRule: null,
    buildableEnvelope: null,
    deletesExistingDisclosure: false,
    noOpForConflict: false,
    note: `NOTHING WOULD BE WRITTEN: ${reason}`,
  };
}

export interface RemintPreviewArgs {
  remintPreview: boolean;
  /** `--parcel` value, null when the run is a cohort run. */
  parcel: string | null;
  /** `args.dryRun || !args.promote` — true unless the run will write. */
  dryRun: boolean;
}

/**
 * The dry leg's own refusal, as a pure function so it is executable in a test
 * rather than only assertable as a string in a script.
 *
 * Returns the FATAL message when the flag combination is forbidden, else null.
 * `--remint-preview` is the pre-write look at the BOUNDED arm and nothing else:
 * a cohort has its own cost JSON, and the dry leg must never be run as, or
 * instead of, the apply leg.
 */
export function remintPreviewRefusal(args: RemintPreviewArgs): string | null {
  if (!args.remintPreview) return null;
  if (!args.parcel) {
    return "FATAL: --remint-preview requires --parcel=<nodeId> (the bounded per-parcel arm); it never previews a cohort.";
  }
  if (!args.dryRun) {
    return "FATAL: --remint-preview is a dry-leg flag and must not be combined with --promote; the apply leg is a separate execution.";
  }
  return null;
}
