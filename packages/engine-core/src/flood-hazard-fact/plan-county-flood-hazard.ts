/**
 * `flood-hazard-fact` COUNTY PLANNER.
 *
 * Empty zone index → typed per-parcel absence (`no-flood-coverage`).
 * Point outside every loaded zone → typed absence (`no-flood-coverage`).
 * Never manufacture Zone X / inSFHA=false by omission — a miss in a partial
 * NFHL load is indistinguishable from true Zone X (SF-9 / L5).
 *
 * SAMPLE-POINT CONTAINMENT (SS-W17, P-45). Every parcel's FEMA query point is
 * checked against the parcel's own ring BEFORE any determination is kept, and a
 * point that is not in the parcel it answers for REFUSES rather than scoring
 * lower. Refusals do not live in `planned` — they live in a separate `refused`
 * array, so `buildAtomsForFloodHazardPlan` is structurally incapable of turning
 * one into an atom. See `containment.ts` for the check and the policy.
 *
 * `FloodParcelInput.geometry` is REQUIRED, deliberately. The previous shape let
 * a caller supply a bare centroid and say nothing about where it came from,
 * which is how a bounding-box centre reached FEMA looking exactly like a real
 * parcel centroid. Making the field required turns "this caller never thought
 * about the ring" into a compile error rather than a silent third state.
 *
 * The parcel-selection and record-assembly halves are exported separately so a
 * PostGIS-backed resolver produces identical plan records to the JS path
 * without re-implementing the dedupe, absence, containment and SFHA rules.
 */

import {
  classifySamplePointContainment,
  deriveFloodSamplePoint,
  emptyContainmentTally,
  floodDeterminationGate,
  tallyContainment,
  type ContainmentTally,
  type ContainmentVerdict,
  type EmittableContainmentState,
  type FloodDeterminationGateResult,
  type SamplePointDerivation,
} from "./containment.js";
import {
  findZoneAtPoint,
  geometryCentroid,
  isSfhaFlag,
  type BBox,
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
  /**
   * The parcel's own geometry, as stored. REQUIRED — pass `null` explicitly
   * when the source has none, so the absence is stated rather than implied.
   */
  geometry: unknown;
  /** Stored parcel bbox, used only when there is no usable ring. */
  bbox?: Partial<BBox> | null;
  /**
   * An explicitly asserted query point, used ONLY when `geometry` yields none.
   * Carries derivation `declared`, which the gate treats as untied to the
   * parcel — the same class as a bounding-box centre.
   */
  centroid?: LngLat | null;
}

export interface PlannedPresentFloodHazard {
  outcome: "present";
  parcelKey: string;
  inSpecialFloodHazardArea: boolean;
  floodZone: string | null;
  zoneSubtype: string | null;
  baseFloodElevation: number | null;
  sourceVintage?: string;
  samplePoint: LngLat;
  samplePointDerivation: SamplePointDerivation;
  /**
   * TYPE, not check: `not-contained` is not a member of this union, so a
   * determination made outside its parcel cannot be constructed as a published
   * record. There is no runtime guard to forget and no call site to miss.
   */
  samplePointContainment: EmittableContainmentState;
}

export interface PlannedAbsentFloodHazard {
  outcome: "absent";
  parcelKey: string;
  absenceKind: "no-flood-coverage";
  reason: string;
  samplePoint: LngLat | null;
  samplePointDerivation: SamplePointDerivation;
  /** Same type-level exclusion as the present record. */
  samplePointContainment: EmittableContainmentState;
}

/**
 * A determination the writer DECLINED to make. Never an absence: an absence
 * says we looked and there is nothing there, and this says we do not trust the
 * place we looked. Collapsing the two is the defect this lane exists to stop.
 */
export interface RefusedFloodHazard {
  outcome: "refused";
  parcelKey: string;
  reasonCode: FloodDeterminationGateResult["reasonCode"];
  reason: string;
  samplePoint: LngLat | null;
  samplePointDerivation: SamplePointDerivation;
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
  /** Determinations declined by the containment gate. NEVER become atoms. */
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
  geometry: unknown;
  samplePointDerivation: SamplePointDerivation;
  containment: ContainmentVerdict;
  gate: FloodDeterminationGateResult;
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
 * Normalize + dedupe parcel keys, derive the query point, and run containment.
 *
 * Both plan backends consume this, so the skipped-key rule, the first-key-wins
 * rule, the sample-point derivation and the containment gate cannot drift
 * between them.
 */
export function selectPlannableParcels(
  parcels: ReadonlyArray<FloodParcelInput>,
): PlannableParcelSelection {
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

    const derived = deriveFloodSamplePoint(
      parcel.geometry,
      parcel.bbox ?? null,
      geometryCentroid,
    );

    let centroid = derived.point;
    let derivation: SamplePointDerivation = derived.derivation;
    if (
      centroid == null &&
      parcel.centroid != null &&
      Number.isFinite(parcel.centroid[0]) &&
      Number.isFinite(parcel.centroid[1])
    ) {
      centroid = parcel.centroid;
      derivation = "declared";
    }

    const containment = classifySamplePointContainment(
      centroid,
      parcel.geometry,
    );
    const gate = floodDeterminationGate(containment, derivation);

    items.push({
      parcelKey: key,
      centroid,
      geometry: parcel.geometry,
      samplePointDerivation: derivation,
      containment,
      gate,
    });
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
 * True when this parcel is allowed to reach FEMA at all.
 *
 * Both backends call this before issuing a query, so a refused parcel is never
 * even evaluated. Per enforcement.mdc: never emit a value computed without a
 * required input — and the cheapest way to keep from emitting it is not to
 * compute it.
 */
export function isQueryableParcel(parcel: PlannableParcel): boolean {
  return parcel.gate.decision === "emit" && hasUsableCentroid(parcel);
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
    const refusalStamp = {
      samplePoint: parcel.centroid,
      samplePointDerivation: parcel.samplePointDerivation,
      samplePointContainment: parcel.containment.state,
    };

    tallyContainment(
      containment,
      parcel.containment,
      parcel.samplePointDerivation,
      parcel.gate,
    );

    // The containment gate runs FIRST, before the empty-zone-index rule and
    // before the no-centroid rule. A parcel whose query point we do not trust
    // must not be recorded as "we looked and found nothing", because that is a
    // claim about the parcel and this is a refusal to make one.
    if (parcel.gate.decision === "refuse") {
      refused.push({
        outcome: "refused",
        parcelKey: key,
        reasonCode: parcel.gate.reasonCode,
        reason: `${opts.countyFips}:${key} — ${parcel.gate.basis}`,
        ...refusalStamp,
      });
      continue;
    }

    // Past the gate the containment state is provably emittable. The narrowing
    // is asserted from the gate's own decision rather than re-derived, so the
    // type and the policy cannot disagree.
    if (parcel.containment.state === "not-contained") {
      throw new Error(
        `unreachable: ${opts.countyFips}:${key} passed the flood determination gate while not-contained`,
      );
    }
    const stamp = {
      samplePoint: parcel.centroid,
      samplePointDerivation: parcel.samplePointDerivation,
      samplePointContainment: parcel.containment.state,
    };

    if (emptyZoneIndex) {
      planned.push({
        outcome: "absent",
        parcelKey: key,
        absenceKind: "no-flood-coverage",
        reason: `empty NFHL zone index for county ${opts.countyFips} — no S_FLD_HAZ_AR features available to evaluate`,
        ...stamp,
      });
      continue;
    }

    if (!hasUsableCentroid(parcel)) {
      planned.push({
        outcome: "absent",
        parcelKey: key,
        absenceKind: "no-flood-coverage",
        reason: `no usable geocode/centroid for ${opts.countyFips}:${key}`,
        ...stamp,
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
        ...stamp,
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
      ...(hit.sourceVintage ? { sourceVintage: hit.sourceVintage } : {}),
      ...stamp,
      samplePoint: parcel.centroid!,
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
  opts: { countyFips: string; grid?: FloodZoneGrid | null },
): CountyFloodHazardPlan {
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

  const selection = selectPlannableParcels(parcels);
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
