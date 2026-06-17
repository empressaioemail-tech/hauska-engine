/**
 * Shared adapter-eligibility helpers — the single source of truth for
 * "given an engagement's resolved jurisdiction, which adapters would
 * the runner actually invoke?"
 *
 * Both `artifacts/api-server/src/routes/generateLayers.ts` (the POST
 * route that returns the 422 `no_applicable_adapters` envelope) and
 * `artifacts/design-tools/src/pages/EngagementDetail.tsx` (the Site
 * Context tab that disables the Generate Layers button + renders the
 * empty-pilot banner proactively) call into here, so an additional
 * pilot jurisdiction added to the registry / resolver flips the FE
 * pre-flight gate and the BE 422 in lockstep — they cannot disagree.
 *
 * The filter wraps each adapter's `appliesTo(ctx)` in try/catch
 * because a thrown adapter (e.g. a future variant that consults a
 * remote feature flag) must not destabilize the gate. A throw is
 * conservatively treated as "does not apply" so the only way to opt
 * an adapter into a jurisdiction is an explicit positive return.
 *
 * The message helper centralizes the human-readable copy the route's
 * 422 body and the FE banner share so a copy tweak doesn't have to
 * be made in two places.
 */

import { ALL_ADAPTERS } from "./registry";
import type { Adapter, AdapterContext, AdapterJurisdiction } from "./types";

/**
 * Filter `adapters` (default: every adapter the runner ships with)
 * down to the ones whose `appliesTo(ctx)` returns true. A thrown
 * `appliesTo` is treated as a non-match so the gate stays a pure
 * function of the resolved jurisdiction even if an adapter author
 * forgets to handle a missing field.
 */
export function filterApplicableAdapters(
  ctx: AdapterContext,
  adapters: ReadonlyArray<Adapter> = ALL_ADAPTERS,
): Adapter[] {
  return adapters.filter((a) => {
    try {
      return a.appliesTo(ctx);
    } catch {
      return false;
    }
  });
}

/**
 * Convenience wrapper for callers that only need a yes/no answer
 * (the FE pre-flight gate uses this to decide whether to disable the
 * Generate Layers button and proactively render the empty-pilot
 * banner).
 */
export function hasApplicableAdapters(
  ctx: AdapterContext,
  adapters: ReadonlyArray<Adapter> = ALL_ADAPTERS,
): boolean {
  return filterApplicableAdapters(ctx, adapters).length > 0;
}

/**
 * The human-readable copy the route's 422 envelope and the FE empty-
 * pilot banner both surface. PL-04 reshaped the branches: federal
 * adapters now apply to any geocoded engagement, so the no-applicable
 * case is essentially "no geocode yet."
 *
 * Branches:
 *   - `hasGeocode` false → no adapter can run; the architect's next
 *     step is to add an address so the geocoder fills in lat/lng.
 *   - `hasGeocode` true, `stateKey` null → defensive fallback. With a
 *     finite lat/lng the federal adapters' `appliesTo` returns true,
 *     so reaching this branch usually means a non-US coordinate or a
 *     future federal adapter that gates more strictly. We surface a
 *     neutral message so the route 422 reads naturally in that case.
 *   - `hasGeocode` true, `stateKey` resolved, `localKey` null →
 *     partial-coverage case: federal layers load but no state/local
 *     adapter is wired for the resolved state yet. The architect's
 *     next step is "upload a QGIS overlay or wait for adapter
 *     support."
 */
export function noApplicableAdaptersMessage(args: {
  jurisdiction: AdapterJurisdiction;
  hasGeocode: boolean;
}): string {
  const { jurisdiction: j, hasGeocode } = args;
  if (!hasGeocode) {
    return "Add an address to enable site context layers.";
  }
  if (!j.stateKey) {
    return "No applicable adapters for this engagement's site context.";
  }
  return `Federal layers loaded. No local adapter for ${stateLabel(j.stateKey)} yet — upload a QGIS overlay if you have one.`;
}

/** Display label for a resolved pilot state key. */
function stateLabel(stateKey: NonNullable<AdapterJurisdiction["stateKey"]>): string {
  switch (stateKey) {
    case "utah":
      return "Utah";
    case "idaho":
      return "Idaho";
    case "texas":
      return "Texas";
  }
}
