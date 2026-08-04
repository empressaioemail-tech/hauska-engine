/**
 * Warden check 1 — neighborConsistency (files-never-fixes: READ ONLY).
 *
 * Whole-cohort sweep: for every parcel in the row's cohort, compares its
 * zoning-fact district (or absence) against its edge-neighbors' districts
 * (or absence), reusing the read-only boundary-primitive adjacency machinery
 * (getParcelEdgeNeighbors / loadParcelAdjacencyIndexFromNeon) and the
 * read-only jurisdiction registry (loadJurisdictionRegistryRowsForFips) for
 * the current district roster. FLAG ONLY on:
 *
 *   (a) roster drift — a parcel's stamped district is not a key in the
 *       row's current districtValueByPrefix roster (a code once valid, now
 *       repealed/renamed — "MIXED-VINTAGE-NEIGHBOR" per the OPS-9 S5 design).
 *   (b) patchy absence — an absent parcel whose edge-neighbors are >= N%
 *       districted, inside a euclidean-zoned row's cohort (default N=75).
 *       A euclidean-zoned district should not leave an island of
 *       undistricted parcels surrounded by districted neighbors.
 *
 * Mere different-valid-district adjacency (e.g. an SF-1 parcel next to a GC
 * parcel) is NEVER flagged — that is an ordinary zoning boundary, not a
 * defect. Evidence always carries both parcels' ids + districts so a human
 * reviewer can see the boundary without re-querying.
 *
 * Whole-county/unzoned rows (zoningRegime: "unzoned") are skipped entirely —
 * honest-absence is the doctrine PASS state for an unzoned row's parcels
 * (never a defect to chase; see 90_runbooks / doc_repo
 * zoning-coverage-is-wired-city-not-data), so patchy-absence has no meaning
 * there.
 *
 * DEDUP (first ground-truth sweep, 2026-08-04): a real sweep produced 81
 * flags across 50 unique parcels — a parcel can legitimately be revisited
 * more than once by the cohort/neighbor walk above (e.g. a duplicate cohort
 * entry from ArcGIS pagination, or a parcel reachable via more than one
 * neighbor edge path), and the naive per-visit push produced one finding per
 * repeat rather than one finding per parcel. classifyNeighborConsistency now
 * collects all per-visit candidate findings first, then dedups to exactly
 * one finding per (parcelNodeId, checkId, defectClass) per sweep, unioning
 * every visit's neighbor list into the surviving finding's
 * evidence.neighbors so no neighbor-pair observation is silently dropped.
 */
import {
  getParcelEdgeNeighbors,
  type ParcelAdjacencyIndex,
} from "../boundary-primitive/index.js";
import {
  loadJurisdictionRegistryRowsForFips,
  type JurisdictionRegistryRow,
} from "../registry/jurisdiction-registry.js";
import type { WardenFindingEvent } from "./types.js";

/** district: the parcel's stamped district code (first whitespace token), or null for an honest-absence zoning-fact. */
export interface ParcelZoningState {
  readonly parcelNodeId: string;
  readonly propId: string;
  readonly district: string | null;
}

export interface NeighborConsistencyOptions {
  /** Patchy-absence threshold — an absent parcel whose neighbors are >= this fraction districted is flagged. Default 0.75. */
  readonly patchyAbsenceThresholdFraction?: number;
}

const DEFAULT_PATCHY_ABSENCE_THRESHOLD = 0.75;

function districtRoster(row: JurisdictionRegistryRow): ReadonlySet<string> {
  const byPrefix = row.railPerParcel?.districtValueByPrefix ?? {};
  return new Set(Object.keys(byPrefix));
}

/** One candidate finding per cohort visit, pre-dedup. A parcel visited more than once (duplicate cohort entry, multiple neighbor-reachable paths) produces one candidate per visit. */
interface CandidateFinding {
  readonly parcelNodeId: string;
  readonly defectClass: WardenFindingEvent["defectClass"];
  readonly evidenceBase: Record<string, unknown>;
  readonly neighbors: ReadonlyArray<{ parcelNodeId: string; district: string | null }>;
}

/** A single (parcelNodeId, defectClass) group accumulated across every visit that produced a candidate for it. */
interface DedupEntry {
  readonly parcelNodeId: string;
  readonly defectClass: WardenFindingEvent["defectClass"];
  readonly evidenceBase: Record<string, unknown>;
  readonly neighborsByNodeId: Map<string, { parcelNodeId: string; district: string | null }>;
}

/**
 * Collapses candidate findings to one per (parcelNodeId, defectClass) —
 * checkId is constant ("neighborConsistency") for every candidate this
 * classifier produces, so it is not part of the dedup key here. Every
 * visit's neighbor list is unioned (by neighbor parcelNodeId) into the
 * surviving finding's evidence.neighbors. The base evidence (parcel/roster/
 * fraction fields) is taken from the FIRST visit that produced this key —
 * those fields are stable across repeat visits of the same parcel (the
 * parcel's own district and the row's roster don't change mid-sweep).
 */
function dedupCandidates(candidates: readonly CandidateFinding[]): DedupEntry[] {
  const byKey = new Map<string, DedupEntry>();
  const order: string[] = [];
  for (const c of candidates) {
    // JSON-encode the key parts so no character either field could ever
    // carry can collide two distinct (parcelNodeId, defectClass) pairs.
    const key = JSON.stringify([c.parcelNodeId, c.defectClass]);
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        parcelNodeId: c.parcelNodeId,
        defectClass: c.defectClass,
        evidenceBase: c.evidenceBase,
        neighborsByNodeId: new Map(),
      };
      byKey.set(key, entry);
      order.push(key);
    }
    for (const n of c.neighbors) entry.neighborsByNodeId.set(n.parcelNodeId, n);
  }
  return order.map((key) => byKey.get(key)!);
}

/**
 * Pure classifier over an already-loaded adjacency index + zoning-state map —
 * the unit-testable core (no DB/network). Callers (the sweep script or a
 * future orchestrator) are responsible for loading `index` via
 * loadParcelAdjacencyIndexFromNeon and `zoningByParcel` from the atoms store;
 * this function performs no I/O itself.
 */
export function classifyNeighborConsistency(params: {
  readonly sweepId: string;
  readonly fips: string;
  readonly rowId: string;
  readonly row: JurisdictionRegistryRow;
  readonly index: ParcelAdjacencyIndex;
  /** parcelNodeId -> zoning state, for every parcel in the cohort AND every neighbor referenced. */
  readonly zoningByParcel: ReadonlyMap<string, ParcelZoningState>;
  readonly cohortParcelNodeIds: readonly string[];
  readonly now: () => Date;
  readonly options?: NeighborConsistencyOptions;
}): WardenFindingEvent[] {
  const { sweepId, fips, rowId, row, index, zoningByParcel, cohortParcelNodeIds, now, options } = params;

  // Unzoned rows: honest-absence is the expected pass state — never flagged.
  if (row.zoningRegime === "unzoned") return [];

  const roster = districtRoster(row);
  const threshold = options?.patchyAbsenceThresholdFraction ?? DEFAULT_PATCHY_ABSENCE_THRESHOLD;
  const artifactRef = `warden-sweep:${sweepId}:neighborConsistency`;

  const candidates: CandidateFinding[] = [];

  for (const parcelNodeId of cohortParcelNodeIds) {
    const self = zoningByParcel.get(parcelNodeId);
    if (!self) continue; // no zoning-fact read for this parcel — nothing to classify against.

    const neighborPropIds = getParcelEdgeNeighbors(index, parcelNodeId);
    if (!neighborPropIds) continue; // parcel not present in the adjacency index.

    const neighborStates: ParcelZoningState[] = [];
    for (const propId of neighborPropIds) {
      if (!propId) continue;
      const neighborNodeId = `${fips}:${propId}`;
      const neighborState = zoningByParcel.get(neighborNodeId);
      if (neighborState) neighborStates.push(neighborState);
    }
    const neighborsForEvidence = neighborStates.map((n) => ({ parcelNodeId: n.parcelNodeId, district: n.district }));

    // (a) Roster drift: a stamped (non-null) district not in the row's current roster.
    if (self.district != null && roster.size > 0 && !roster.has(self.district)) {
      candidates.push({
        parcelNodeId,
        defectClass: "MIXED-VINTAGE-NEIGHBOR",
        evidenceBase: {
          parcel: { parcelNodeId, district: self.district },
          currentRoster: [...roster],
        },
        neighbors: neighborsForEvidence,
      });
      continue;
    }

    // (b) Patchy absence: this parcel is absent, and >= threshold of its
    // resolved edge-neighbors carry a stamped district.
    if (self.district == null && neighborStates.length > 0) {
      const districtedCount = neighborStates.filter((n) => n.district != null).length;
      const fraction = districtedCount / neighborStates.length;
      if (fraction >= threshold) {
        candidates.push({
          parcelNodeId,
          defectClass: "MIXED-VINTAGE-NEIGHBOR",
          evidenceBase: {
            parcel: { parcelNodeId, district: null },
            districtedFraction: fraction,
            thresholdFraction: threshold,
          },
          neighbors: neighborsForEvidence,
        });
      }
    }

    // Different-valid-district adjacency (both self and neighbors carry
    // roster-valid, merely different, districts) is intentionally never
    // flagged here — that is an ordinary zoning boundary.
  }

  return dedupCandidates(candidates).map((entry) => ({
    ts: now().toISOString(),
    sweepId,
    rowId,
    fips,
    parcelNodeId: entry.parcelNodeId,
    checkId: "neighborConsistency",
    defectClass: entry.defectClass,
    evidence: {
      ...entry.evidenceBase,
      neighbors: [...entry.neighborsByNodeId.values()],
    },
    severity: "flag",
    artifactRef,
  }));
}

/**
 * Loads the current registry roster for a fips (read-only convenience
 * wrapper) — exported so the sweep script can resolve a row by rowId without
 * re-deriving the loadJurisdictionRegistryRowsForFips filter.
 */
export function resolveRegistryRowForSweep(
  fips: string,
  rowId: string,
): JurisdictionRegistryRow | null {
  return loadJurisdictionRegistryRowsForFips(fips).find((r) => r.rowId === rowId) ?? null;
}
