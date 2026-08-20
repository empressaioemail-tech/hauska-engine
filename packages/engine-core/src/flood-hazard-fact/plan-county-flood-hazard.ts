/**
 * `flood-hazard-fact` COUNTY PLANNER.
 *
 * Empty zone index → typed per-parcel absence (`no-flood-coverage`).
 * Point outside every loaded zone → typed absence (`no-flood-coverage`).
 * Never manufacture Zone X / inSFHA=false by omission — a miss in a partial
 * NFHL load is indistinguishable from true Zone X (SF-9 / L5).
 *
 * The parcel-selection and record-assembly halves are exported separately so a
 * PostGIS-backed resolver produces identical plan records to the JS path
 * without re-implementing the dedupe, absence, and SFHA rules.
 */

import {
  classifySamplePointContainment,
  emptyContainmentTally,
  floodDeterminationGate,
  tallyContainment,
  type ContainmentTally,
  type ContainmentVerdict,
  type EmittableContainmentState,
  type FloodDeterminationGateResult,
  type ParcelRingStore,
} from "./containment.js";
import {
  findZoneAtPoint,
  isSfhaFlag,
  type FloodZoneFeature,
  type LngLat,
} from "./geo.js";
import {
  buildFloodZoneGrid,
  findZoneAtPointWithGrid,
  type FloodZoneGrid,
} from "./flood-zone-grid.js";

export interface FloodParcelInput {
  parcelKey: string;
  /** WGS84 centroid [lng, lat]. Null → no-flood-coverage (no geocode). */
  centroid: LngLat | null;
}

export interface PlannedPresentFloodHazard {
  outcome: "present";
  parcelKey: string;
  inSpecialFloodHazardArea: boolean;
  floodZone: string | null;
  zoneSubtype: string | null;
  baseFloodElevation: number | null;
  sourceVintage?: string;
  /**
   * TYPE: `not-contained` is not a member, so a determination made outside
   * its parcel cannot be constructed as a published present record.
   */
  samplePointContainment: EmittableContainmentState;
}

export interface PlannedAbsentFloodHazard {
  outcome: "absent";
  parcelKey: string;
  absenceKind: "no-flood-coverage";
  reason: string;
}

/**
 * A determination declined by the containment gate. Never an absence: an
 * absence says we looked and there is nothing there. This says we do not
 * trust the place we looked, or could not measure it.
 */
export interface RefusedFloodHazard {
  outcome: "refused";
  parcelKey: string;
  reasonCode: FloodDeterminationGateResult["reasonCode"];
  reason: string;
  samplePointContainment: ContainmentVerdict["state"];
}

export type PlannedFloodHazard =
  | PlannedPresentFloodHazard
  | PlannedAbsentFloodHazard;

export interface CountyFloodHazardPlan {
  countyFips: string;
  zonesIndexed: number;
  parcelsRead: number;
  emptyZoneIndex: boolean;
  /** ONLY determinations we are willing to publish. Atoms are built from this. */
  planned: ReadonlyArray<PlannedFloodHazard>;
  /** Containment-gate refusals. NEVER become atoms. */
  refused: ReadonlyArray<RefusedFloodHazard>;
  containment: ContainmentTally;
  counts: {
    present: number;
    presentInSfha: number;
    presentOutside: number;
    absent: number;
    refused: number;
    skippedUnusableKey: number;
  };
}

/** A parcel that survived key normalization and dedupe, in plan order. */
export interface PlannableParcel {
  parcelKey: string;
  centroid: LngLat | null;
  /** Null when there is no finite point — B5 absence, not a containment class. */
  containment: ContainmentVerdict | null;
  gate: FloodDeterminationGateResult | null;
}

export interface PlannableParcelSelection {
  items: PlannableParcel[];
  skippedUnusableKey: number;
  parcelsRead: number;
}

/** The zone attributes a resolved point-in-polygon hit contributes to a record. */
export interface ResolvedFloodZone {
  fldZone: string | null;
  zoneSubty: string | null;
  sfhaTf: string | null;
  staticBfe: number | null;
  sourceVintage?: string | null;
}

/**
 * Normalize + dedupe parcel keys. Both plan backends consume this so the
 * skipped-key and first-key-wins rules cannot drift between them.
 */
export interface SelectPlannableParcelsOpts {
  countyFips: string;
  ringStore: ParcelRingStore;
}

export function selectPlannableParcels(
  parcels: ReadonlyArray<FloodParcelInput>,
  opts: SelectPlannableParcelsOpts,
): PlannableParcelSelection {
  if (!opts?.ringStore || typeof opts.ringStore.getRing !== "function") {
    throw new Error(
      "selectPlannableParcels requires ringStore; the parcel ring must come from the parcel store, not from the atom",
    );
  }

  const items: PlannableParcel[] = [];
  const seen = new Set<string>();
  let skippedUnusableKey = 0;

  for (const parcel of parcels) {
    const key = parcel.parcelKey?.trim() ?? "";
    if (!key || /^0+$/.test(key)) {
      skippedUnusableKey += 1;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);

    const centroid = parcel.centroid;
    const usable =
      Boolean(centroid) &&
      Number.isFinite(centroid![0]) &&
      Number.isFinite(centroid![1]);

    if (!usable) {
      items.push({
        parcelKey: key,
        centroid,
        containment: null,
        gate: null,
      });
      continue;
    }

    const containment = classifySamplePointContainment(
      centroid,
      { countyFips: opts.countyFips, parcelKey: key },
      opts.ringStore,
    );
    const gate = floodDeterminationGate(containment);
    items.push({ parcelKey: key, centroid, containment, gate });
  }

  return { items, skippedUnusableKey, parcelsRead: parcels.length };
}

export function hasUsableCentroid(parcel: PlannableParcel): boolean {
  return Boolean(
    parcel.centroid &&
      Number.isFinite(parcel.centroid[0]) &&
      Number.isFinite(parcel.centroid[1]),
  );
}

/**
 * True when this parcel is allowed to reach FEMA. A refused parcel is never
 * evaluated — the cheapest way to keep from emitting a not-contained
 * determination is not to compute one.
 */
export function isQueryableParcel(parcel: PlannableParcel): boolean {
  return (
    hasUsableCentroid(parcel) &&
    parcel.gate != null &&
    parcel.gate.decision === "emit"
  );
}

/**
 * Turn a selection plus per-parcel resolved zones into the county plan.
 *
 * `resolvedZones` is index-aligned with `selection.items`; a null entry means
 * the point fell outside every LOADED zone polygon — not proven Zone X.
 */
export function assembleCountyFloodHazardPlan(
  selection: PlannableParcelSelection,
  resolvedZones: ReadonlyArray<ResolvedFloodZone | null>,
  opts: { countyFips: string; zonesIndexed: number },
): CountyFloodHazardPlan {
  const emptyZoneIndex = opts.zonesIndexed === 0;
  const planned: PlannedFloodHazard[] = [];
  const refused: RefusedFloodHazard[] = [];
  const containment = emptyContainmentTally();
  let presentInSfha = 0;
  let presentOutside = 0;

  for (let i = 0; i < selection.items.length; i++) {
    const parcel = selection.items[i]!;
    const key = parcel.parcelKey;

    if (parcel.containment && parcel.gate) {
      tallyContainment(containment, parcel.containment, parcel.gate);
      if (parcel.gate.decision === "refuse") {
        refused.push({
          outcome: "refused",
          parcelKey: key,
          reasonCode: parcel.gate.reasonCode,
          reason: `${opts.countyFips}:${key} — ${parcel.gate.basis}`,
          samplePointContainment: parcel.containment.state,
        });
        continue;
      }
      if (parcel.containment.state === "not-contained") {
        throw new Error(
          `unreachable: ${opts.countyFips}:${key} passed the flood determination gate while not-contained`,
        );
      }
    }

    if (emptyZoneIndex) {
      planned.push({
        outcome: "absent",
        parcelKey: key,
        absenceKind: "no-flood-coverage",
        reason: `empty NFHL zone index for county ${opts.countyFips} — no S_FLD_HAZ_AR features available to evaluate`,
      });
      continue;
    }

    if (!hasUsableCentroid(parcel)) {
      planned.push({
        outcome: "absent",
        parcelKey: key,
        absenceKind: "no-flood-coverage",
        reason: `no usable geocode/centroid for ${opts.countyFips}:${key}`,
      });
      continue;
    }

    const hit = resolvedZones[i] ?? null;
    if (!hit) {
      // SF-9: null hit is "outside loaded polygons", not Zone X. Zone X must
      // arrive as an explicit FLD_ZONE hit when NFHL carries it.
      planned.push({
        outcome: "absent",
        parcelKey: key,
        absenceKind: "no-flood-coverage",
        reason: `point outside every loaded NFHL zone for ${opts.countyFips}:${key} — not proven Zone X (fail-closed; partial load would otherwise manufacture inSFHA=false)`,
      });
      continue;
    }

    const inSfha = isSfhaFlag(hit.sfhaTf);
    planned.push({
      outcome: "present",
      parcelKey: key,
      inSpecialFloodHazardArea: inSfha,
      floodZone: hit.fldZone,
      zoneSubtype: hit.zoneSubty,
      baseFloodElevation: hit.staticBfe,
      samplePointContainment: "contained",
      ...(hit.sourceVintage ? { sourceVintage: hit.sourceVintage } : {}),
    });
    if (inSfha) presentInSfha += 1;
    else presentOutside += 1;
  }

  return {
    countyFips: opts.countyFips,
    zonesIndexed: opts.zonesIndexed,
    parcelsRead: selection.parcelsRead,
    emptyZoneIndex,
    planned,
    refused,
    containment,
    counts: {
      present: planned.filter((p) => p.outcome === "present").length,
      presentInSfha,
      presentOutside,
      absent: planned.filter((p) => p.outcome === "absent").length,
      refused: refused.length,
      skippedUnusableKey: selection.skippedUnusableKey,
    },
  };
}

export function planCountyFloodHazard(
  parcels: ReadonlyArray<FloodParcelInput>,
  zones: ReadonlyArray<FloodZoneFeature>,
  opts: {
    countyFips: string;
    grid?: FloodZoneGrid | null;
    ringStore: ParcelRingStore;
  },
): CountyFloodHazardPlan {
  if (!opts?.ringStore || typeof opts.ringStore.getRing !== "function") {
    throw new Error(
      "planCountyFloodHazard requires ringStore; refusing to plan flood determinations without a parcel-store ring",
    );
  }

  const emptyZoneIndex = zones.length === 0;
  const grid =
    opts.grid !== undefined
      ? opts.grid
      : emptyZoneIndex
        ? null
        : buildFloodZoneGrid(zones);
  const zoneAtPoint = (lng: number, lat: number) =>
    grid
      ? findZoneAtPointWithGrid(lng, lat, grid, zones)
      : findZoneAtPoint(lng, lat, zones);

  const selection = selectPlannableParcels(parcels, {
    countyFips: opts.countyFips,
    ringStore: opts.ringStore,
  });
  const resolved: Array<ResolvedFloodZone | null> = new Array(
    selection.items.length,
  ).fill(null);

  if (!emptyZoneIndex) {
    for (let i = 0; i < selection.items.length; i++) {
      const parcel = selection.items[i]!;
      if (!isQueryableParcel(parcel)) continue;
      resolved[i] = zoneAtPoint(parcel.centroid![0], parcel.centroid![1]);
    }
  }

  return assembleCountyFloodHazardPlan(selection, resolved, {
    countyFips: opts.countyFips,
    zonesIndexed: zones.length,
  });
}
