// tally.ts
//
// Accumulate `ParcelObservation`s into the frozen `CountyServingSweep`.
//
// Streaming by construction: the sweep never holds a county's parcels in
// memory. A county is 62k parcels in Bastrop and Texas is roughly 10M, so an
// accumulator that keeps rows is an accumulator that dies in Harris.
//
// Absence clustering is a fixed geographic grid rather than a clustering
// algorithm, deliberately. The question the operator asked is "is this hole a
// region or is it scattered", which a grid answers with an auditable counting
// rule; a k-means over 10M points answers it with a number nobody can check.

import type {
  ContradictionKind,
  ContradictionTally,
  CountyServingSweep,
  FieldKey,
  FieldTally,
} from "./types.js";
import type { ParcelObservation } from "./project-sheet.js";

const FIELD_KEYS: FieldKey[] = [
  "geometry",
  "situsAddress",
  "apn",
  "landUse",
  "zoning",
  "setbacks",
  "envelope",
  "flood",
  "frontage",
];

const CONTRADICTION_KINDS: ContradictionKind[] = [
  "envelope-not-derived-but-area-shown",
  "flood-zone-disagreement",
  "field-unavailable-but-present-upstream",
  "address-absent-but-on-cad-roll",
  "setbacks-present-card-absent-brief",
];

/** Grid cell edge in degrees. ~0.05 deg is roughly 3.4 miles of latitude. */
export const CLUSTER_CELL_DEG = 0.05;
/** A cell is reported as a cluster only at or above this parcel count. */
export const CLUSTER_MIN_PARCELS = 250;

function emptyTally(): FieldTally {
  return { present: 0, absentCovered: 0, absentUncovered: 0, unresolved: 0 };
}

function emptyFields(): Record<FieldKey, FieldTally> {
  const out = {} as Record<FieldKey, FieldTally>;
  for (const k of FIELD_KEYS) out[k] = emptyTally();
  return out;
}

interface ClusterCell {
  count: number;
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export interface ExtraCounts {
  /** Parcels the served card itself calls a present situs address. */
  situsCardCallsPresent: number;
  /** Parcels this sweep counts as a legible served address. */
  situsLegible: number;
  /** Per-field reason-token histogram, so absences trace to a source. */
  reasons: Record<FieldKey, Record<string, number>>;
  /** Served read-path histogram (atom-chain / atom-chain-warm / atom-pending). */
  readPaths: Record<string, number>;
}

export class CountySweepAccumulator {
  readonly countyFips: string;
  readonly countyName: string;
  readonly resolverVersion: string;

  private parcelsTotal = 0;
  private parcelsUnresolvable = 0;
  private multiZoneFloodParcels = 0;
  private readonly fields = emptyFields();
  private readonly sfFields = emptyFields();
  private sfTotal = 0;
  private readonly contradictionCounts = new Map<ContradictionKind, number>();
  private readonly contradictionExamples = new Map<ContradictionKind, string[]>();
  /** field -> cellKey -> cell. Only absent states are clustered. */
  private readonly clusters = new Map<FieldKey, Map<string, ClusterCell>>();
  readonly extra: ExtraCounts;

  constructor(countyFips: string, countyName: string, resolverVersion: string) {
    this.countyFips = countyFips;
    this.countyName = countyName;
    this.resolverVersion = resolverVersion;
    const reasons = {} as Record<FieldKey, Record<string, number>>;
    for (const k of FIELD_KEYS) reasons[k] = {};
    this.extra = {
      situsCardCallsPresent: 0,
      situsLegible: 0,
      reasons,
      readPaths: {},
    };
  }

  /** A parcel the sweep could not resolve at all. Never enters a field tally. */
  addUnresolvable(): void {
    this.parcelsTotal += 1;
    this.parcelsUnresolvable += 1;
  }

  add(obs: ParcelObservation, readPath: string): void {
    this.parcelsTotal += 1;
    this.extra.readPaths[readPath] = (this.extra.readPaths[readPath] ?? 0) + 1;
    if (obs.servedCardCallsSitusPresent) this.extra.situsCardCallsPresent += 1;
    if (obs.fields.situsAddress.state === "present") this.extra.situsLegible += 1;
    if (obs.floodZoneCount > 1) this.multiZoneFloodParcels += 1;
    if (obs.singleFamily) this.sfTotal += 1;

    for (const key of FIELD_KEYS) {
      const o = obs.fields[key];
      this.fields[key][o.state] += 1;
      if (obs.singleFamily) this.sfFields[key][o.state] += 1;
      const bucket = this.extra.reasons[key];
      bucket[o.reason] = (bucket[o.reason] ?? 0) + 1;
      if (o.state !== "present" && obs.centroid) {
        this.cluster(key, obs.centroid);
      }
    }

    for (const kind of obs.contradictions) {
      this.contradictionCounts.set(
        kind,
        (this.contradictionCounts.get(kind) ?? 0) + 1,
      );
      const ex = this.contradictionExamples.get(kind) ?? [];
      if (ex.length < 20) {
        ex.push(obs.parcelNodeId);
        this.contradictionExamples.set(kind, ex);
      }
    }
  }

  private cluster(field: FieldKey, c: { lat: number; lng: number }): void {
    let byCell = this.clusters.get(field);
    if (!byCell) {
      byCell = new Map();
      this.clusters.set(field, byCell);
    }
    const gx = Math.floor(c.lng / CLUSTER_CELL_DEG);
    const gy = Math.floor(c.lat / CLUSTER_CELL_DEG);
    const key = `${gx}:${gy}`;
    const cell = byCell.get(key);
    if (cell) {
      cell.count += 1;
      cell.minLng = Math.min(cell.minLng, c.lng);
      cell.minLat = Math.min(cell.minLat, c.lat);
      cell.maxLng = Math.max(cell.maxLng, c.lng);
      cell.maxLat = Math.max(cell.maxLat, c.lat);
    } else {
      byCell.set(key, {
        count: 1,
        minLng: c.lng,
        minLat: c.lat,
        maxLng: c.lng,
        maxLat: c.lat,
      });
    }
  }

  finish(sweptAt: string, sourcesByField: CountyServingSweep["sourcesByField"]): CountyServingSweep {
    const contradictions: ContradictionTally[] = CONTRADICTION_KINDS.map((kind) => ({
      kind,
      count: this.contradictionCounts.get(kind) ?? 0,
      exampleParcelNodeIds: this.contradictionExamples.get(kind) ?? [],
    }));

    const absenceClusters: CountyServingSweep["absenceClusters"] = [];
    for (const [field, byCell] of this.clusters) {
      const cells = [...byCell.values()]
        .filter((c) => c.count >= CLUSTER_MIN_PARCELS)
        .sort((a, b) => b.count - a.count)
        .slice(0, 12);
      for (const c of cells) {
        absenceClusters.push({
          field,
          // COUNTING RULE, stated where the number is read: one cell of a
          // fixed 0.05-degree grid holding at least CLUSTER_MIN_PARCELS
          // parcels whose served state for this field is not `present`.
          label: `${field} absence, ${CLUSTER_CELL_DEG}deg cell at ${c.minLat.toFixed(2)},${c.minLng.toFixed(2)}`,
          parcelCount: c.count,
          bbox: [c.minLng, c.minLat, c.maxLng, c.maxLat],
        });
      }
    }
    absenceClusters.sort((a, b) => b.parcelCount - a.parcelCount);

    return {
      countyFips: this.countyFips,
      countyName: this.countyName,
      sweptAt,
      resolverVersion: this.resolverVersion,
      parcelsTotal: this.parcelsTotal,
      parcelsUnresolvable: this.parcelsUnresolvable,
      fields: this.fields,
      singleFamily: { parcelsTotal: this.sfTotal, fields: this.sfFields },
      contradictions,
      multiZoneFloodParcels: this.multiZoneFloodParcels,
      absenceClusters,
      sourcesByField,
    };
  }
}
