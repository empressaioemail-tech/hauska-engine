/**
 * One shared reading of "why was there no site plan", used by every report
 * author that degrades or fails closed on site-plan composition.
 *
 * Previously this function existed twice, copied verbatim into
 * `feasibility-author.ts` and `dossier-author.ts`, and both copies discarded
 * the underlying error. A real, specific decline ("parcel bbox (~27m x 9m)
 * cannot meet 16px floor even at 1m/px") matched none of the branches and
 * fell through to the generic "site-plan authoring failed for this parcel",
 * which is what reached the operator. The precise cause was available at the
 * throw site and thrown away one frame later.
 *
 * So this returns BOTH readings and callers keep both:
 *
 * - `summary` is the §11-safe sentence for the sheet. Machine detail stays
 *   out of the customer-facing PDF, which is why the terse form exists.
 * - `detail` is the underlying error message, verbatim, for the API response
 *   and the logs. Degradation is declared in the output; the reason for it is
 *   not laundered on the way there.
 */
export interface SitePlanUnavailable {
  /** Sheet-safe sentence. Never carries machine detail. */
  summary: string;
  /** The underlying error message, verbatim. Never shown on the sheet. */
  detail: string;
}

export function sitePlanUnavailableFromError(error: unknown): SitePlanUnavailable {
  const detail = error instanceof Error ? error.message : String(error);

  if (/geometry unavailable|no boundary ring|resolver/i.test(detail)) {
    return { summary: "parcel geometry could not be resolved for this parcel", detail };
  }
  // The raster-floor decline names neither "dem" nor "elevation" nor "3dep",
  // so it has to be matched on its own wording or it falls through to the
  // generic branch. That fall-through is the bug this arm closes.
  if (/px floor|raster|bbox \(~/i.test(detail)) {
    return {
      summary: "this parcel is too small for the available terrain data resolution",
      detail,
    };
  }
  if (/dem|elevation|3dep/i.test(detail)) {
    return { summary: "terrain elevation data could not be fetched for this parcel", detail };
  }
  return { summary: "site-plan authoring failed for this parcel", detail };
}
