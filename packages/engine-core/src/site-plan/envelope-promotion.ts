/**
 * P-261 / A-180 — "is this buildable-envelope atom VERIFIED?".
 *
 * The operator ruled (2026-09-16, A-180) that a buildable-area figure appears
 * only when a verified envelope atom backs it. Before this module
 * `site-model.ts` gated the printed figure on atom-backing alone (P-159 /
 * Ruling B): any persisted `buildable-envelope` atom with an area set
 * `printedBuildable` to `{kind: "atom"}`, whether or not anything had verified
 * it. A cold-derived envelope written straight to the store could therefore
 * print its area in the largest type on a cover. The MCP payload had the same
 * hole (P-249, legacy-design-tools carries the sibling predicate).
 *
 * The verification marker is `depthWarmPromotion === "depth-warm-promoted-v1"`
 * — NOT a `depthWarmPromoted` field, which does not exist on the atom (A-183's
 * teardown trap; four predicates read this fact in three repos, so this one is
 * deliberately a mirror of hauska-map's `isDepthWarmPromoted`
 * (`hauska-map/apps/property-explorer/api/_lib/atom-chain-to-facets.ts:116-127`),
 * sourceCitation fallback included. Same fixture answers as the sibling
 * predicate in legacy-design-tools (P-249), so the divergence test agrees.
 *
 * The marker CONSTANT is imported rather than re-typed: a second copy of a
 * vocabulary token is exactly the kind of drift the canon forbids, and
 * `promote.ts` writes the one in `depth-warm/types.ts`.
 */
import { DEPTH_WARM_PROMOTION_MARKER } from "../depth-warm/types.js";

/**
 * The token the promote writer stamps into `sourceCitation`
 * (`DEPTH_WARM_SOURCE_CITATION` in `depth-warm/types.ts`). A promoted atom whose
 * marker field was dropped on the way through an older store or a projection
 * still carries this citation, and hauska-map treats that as promoted — so does
 * this predicate, or the PDF and the map would disagree about the same atom.
 */
const DEPTH_WARM_VERIFIED_CITATION_TOKEN = "depth-warm-verified";

/** The atom fields this predicate reads. Structural, so a fixture can be built
 * without the atom contract and a caller can pass a stored instance verbatim. */
export interface DepthWarmPromotionView {
  depthWarmPromotion?: unknown;
  sourceCitation?: unknown;
}

/**
 * True only when the atom carries the depth-warm promotion marker (or the
 * citation a promote leaves behind). Everything else — a cold-derived atom, a
 * warm-verify decline, an atom with no provenance block at all — is NOT
 * verified, and a figure resting on it is refused with a stated reason.
 */
export function isDepthWarmPromotedAtom(
  atom: DepthWarmPromotionView | null | undefined,
): boolean {
  if (!atom || typeof atom !== "object") return false;
  if (atom.depthWarmPromotion === DEPTH_WARM_PROMOTION_MARKER) return true;
  const citation = atom.sourceCitation;
  return (
    typeof citation === "string" && citation.includes(DEPTH_WARM_VERIFIED_CITATION_TOKEN)
  );
}
