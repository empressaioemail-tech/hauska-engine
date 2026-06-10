/**
 * Pilot jurisdictions surfaced to architects in the Site Context tab.
 *
 * The empty-pilot banner (Task #177) explains *that* a project is out of
 * pilot, but until Task #188 it never named the jurisdictions that *are*
 * supported. Architects scoping a Boulder CO project had to dig through
 * docs to discover the dead-end was systemic and not specific to their
 * project. This module exports the pilot list so the banner can render
 * the actual supported set inline.
 *
 * The list is *derived* from {@link ALL_ADAPTERS} so it cannot drift from
 * the server's `appliesTo` gate. The server filters `ALL_ADAPTERS` on
 * `appliesTo(ctx)`; this module collects the same set of `localKey`s
 * (and `stateKey`s) from each adapter's `jurisdictionGate`. Adding a
 * new local adapter to the registry automatically extends the visible
 * pilot list — see the unit test in `__tests__/pilotJurisdictions.test.ts`
 * which fails closed if a localKey appears in the registry without a
 * matching label here.
 *
 * The friendly labels (e.g. `"Moab, UT (Grand County)"`) are the only
 * piece that has to be edited by hand when a new pilot jurisdiction
 * lands. The unit test enforces that every `localKey` in the registry
 * has a label, so a half-wired adapter cannot ship without surfacing
 * the gap to the test author.
 */

import type { AdapterLocalKey, AdapterStateKey, AdapterTier } from "./types";
import { ALL_ADAPTERS } from "./registry";

/**
 * One row in the pilot-jurisdictions list as the FE renders it.
 *
 * `shortLabel` is the city/state the architect would recognize from
 * the brief ("Moab, UT"). `label` keeps the county qualifier in
 * parentheses so an architect who knows the county name (but not the
 * city) can still match it.
 */
export interface PilotJurisdiction {
  /** Local key from the adapter registry (e.g. `"grand-county-ut"`). */
  localKey: AdapterLocalKey;
  /** State this local key sits inside (e.g. `"utah"`). */
  stateKey: AdapterStateKey;
  /** Human-readable label, e.g. `"Moab, UT (Grand County)"`. */
  label: string;
  /** Short label, e.g. `"Moab, UT"`. */
  shortLabel: string;
}

/**
 * Hand-maintained labels keyed by `AdapterLocalKey`. The mapping is
 * exhaustive on the union (a new key in `types.ts` triggers a TS
 * error here until it is filled in), and the unit test additionally
 * asserts every key actually present in {@link ALL_ADAPTERS} has a
 * label so a registry-only addition cannot silently leave the banner
 * out of date.
 */
const LOCAL_KEY_LABELS: Record<
  AdapterLocalKey,
  { label: string; shortLabel: string; stateKey: AdapterStateKey }
> = {
  "bastrop-tx": {
    label: "Bastrop, TX",
    shortLabel: "Bastrop, TX",
    stateKey: "texas",
  },
  "grand-county-ut": {
    label: "Moab, UT (Grand County)",
    shortLabel: "Moab, UT",
    stateKey: "utah",
  },
  "lemhi-county-id": {
    label: "Salmon, ID (Lemhi County)",
    shortLabel: "Salmon, ID",
    stateKey: "idaho",
  },
};

/**
 * Stable display order — alphabetical by short label so the banner
 * reads predictably regardless of the order adapters were registered
 * in.
 */
function sortByShortLabel(a: PilotJurisdiction, b: PilotJurisdiction): number {
  return a.shortLabel.localeCompare(b.shortLabel);
}

/**
 * The union of `localKey`s present anywhere in {@link ALL_ADAPTERS}'s
 * `jurisdictionGate.local`. This is the canonical "what local
 * jurisdictions does the Generate Layers run actually support" list —
 * the same set the server's `appliesTo` gate filters to.
 */
export const PILOT_LOCAL_KEYS: ReadonlyArray<AdapterLocalKey> = Array.from(
  new Set(
    ALL_ADAPTERS.map((a) => a.jurisdictionGate.local).filter(
      (k): k is AdapterLocalKey => Boolean(k),
    ),
  ),
);

/**
 * Same derivation for state-tier coverage. Federal adapters gate on
 * `stateKey !== null`, so the set of pilot states is the union of every
 * state-bearing adapter's `jurisdictionGate.state` plus the state implied
 * by every local adapter's `jurisdictionGate.local`.
 */
export const PILOT_STATE_KEYS: ReadonlyArray<AdapterStateKey> = Array.from(
  new Set<AdapterStateKey>([
    ...ALL_ADAPTERS.map((a) => a.jurisdictionGate.state).filter(
      (k): k is AdapterStateKey => Boolean(k),
    ),
    ...PILOT_LOCAL_KEYS.map((k) => LOCAL_KEY_LABELS[k].stateKey),
  ]),
);

/**
 * The pilot-jurisdictions list the FE renders in the empty-pilot
 * banner. Each entry carries the localKey (so tests can pin to the
 * registry) plus the friendly label.
 */
export const PILOT_JURISDICTIONS: ReadonlyArray<PilotJurisdiction> =
  PILOT_LOCAL_KEYS.map((localKey) => {
    const meta = LOCAL_KEY_LABELS[localKey];
    return {
      localKey,
      stateKey: meta.stateKey,
      label: meta.label,
      shortLabel: meta.shortLabel,
    };
  })
    .slice()
    .sort(sortByShortLabel);

/**
 * One adapter row inside a pilot jurisdiction's coverage list (Task
 * #253). The Site Context tab's supported-jurisdictions disclosure
 * renders these so an architect can see *what* Generate Layers will
 * fetch for each pilot jurisdiction (e.g. "Bastrop, TX → state
 * parcels + county zoning + floodplain") *before* clicking Generate
 * Layers.
 *
 * `tier` is restricted to `"state" | "local"` because the per-
 * jurisdiction view only enumerates the adapters whose
 * `jurisdictionGate` selects this jurisdiction's local key (or the
 * state implied by it). Federal-tier adapters ungate (they apply to
 * every parcel) so they live in {@link FEDERAL_PILOT_LAYER_KINDS}
 * which the disclosure renders as a single "always on" line above
 * the per-jurisdiction breakdown.
 */
export interface PilotJurisdictionLayer {
  /** Stable `<jurisdiction-key>:<source-name>` slug from the registry. */
  adapterKey: string;
  /** "state" | "local" — federal adapters live in {@link FEDERAL_PILOT_LAYER_KINDS}. */
  tier: Extract<AdapterTier, "state" | "local">;
  /** `briefing_sources.layer_kind` slug — what Generate Layers will fetch. */
  layerKind: string;
  /** Human-readable provider label (e.g. "Bastrop County, TX GIS"). */
  provider: string;
}

/**
 * Per-pilot-jurisdiction coverage row. Extends {@link PilotJurisdiction}
 * with the ordered list of state-tier and local-tier adapters whose
 * `jurisdictionGate` selects this jurisdiction. An architect scoping a
 * Bastrop project can see "state parcels + county zoning + floodplain"
 * inline without clicking Generate Layers and reading the per-adapter
 * outcome panel.
 */
export interface PilotJurisdictionCoverage extends PilotJurisdiction {
  /**
   * Adapters that fire for this jurisdiction, in registry order
   * (state-tier first, then local-tier — mirrors `ALL_ADAPTERS`).
   */
  layers: ReadonlyArray<PilotJurisdictionLayer>;
}

/**
 * Federal-tier layer kinds. These adapters ungate (`jurisdictionGate:
 * {}`) so they fire for every pilot jurisdiction; surfacing them once
 * at the top of the disclosure (rather than repeating them under every
 * jurisdiction) keeps the per-jurisdiction view focused on what
 * actually varies.
 */
export const FEDERAL_PILOT_LAYER_KINDS: ReadonlyArray<string> = Array.from(
  new Set(
    ALL_ADAPTERS.filter(
      (a) =>
        a.tier === "federal" &&
        !a.jurisdictionGate.state &&
        !a.jurisdictionGate.local,
    ).map((a) => a.layerKind),
  ),
);

/**
 * Per-jurisdiction adapter coverage (Task #253). For each pilot local
 * key in {@link PILOT_LOCAL_KEYS}, this collects:
 *
 *   1. every state-tier adapter whose `jurisdictionGate.state`
 *      matches the local key's parent state (so a Moab UT project
 *      gets the Utah UGRC adapters, an Idaho Salmon project gets the
 *      INSIDE Idaho adapters, etc.);
 *   2. every local-tier adapter whose `jurisdictionGate.local`
 *      matches the local key directly.
 *
 * The grouping is derived from {@link ALL_ADAPTERS}, so adding a new
 * adapter to the registry automatically extends the visible coverage
 * without any change here. The unit test in
 * `__tests__/pilotJurisdictions.test.ts` enforces that the rendered
 * layer-kind set for each jurisdiction matches the adapters whose
 * `jurisdictionGate` selects that key.
 *
 * Federal adapters are deliberately *not* repeated under every
 * jurisdiction — they ungate and are surfaced once via
 * {@link FEDERAL_PILOT_LAYER_KINDS}.
 */
export const PILOT_JURISDICTION_COVERAGE: ReadonlyArray<PilotJurisdictionCoverage> =
  PILOT_JURISDICTIONS.map((j) => {
    const layers: PilotJurisdictionLayer[] = ALL_ADAPTERS.filter((a) => {
      if (a.tier === "state") return a.jurisdictionGate.state === j.stateKey;
      if (a.tier === "local") return a.jurisdictionGate.local === j.localKey;
      return false;
    }).map((a) => ({
      adapterKey: a.adapterKey,
      tier: a.tier as Extract<AdapterTier, "state" | "local">,
      layerKind: a.layerKind,
      provider: a.provider,
    }));
    return {
      ...j,
      layers,
    };
  });
