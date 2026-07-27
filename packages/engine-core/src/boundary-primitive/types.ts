/**
 * Boundary primitive types (27f S2-U2 / PRE-2 adjacency method).
 */

import type { Ring } from "../depth-warm/geometry.js";

export const ADJACENCY_PROBE_DISTANCE_M = 3;
export const ADJACENCY_CELL_SIZE_M = 1000;
export const ADJACENCY_BBOX_PAD_M = 50;
export const ADJACENCY_CELL_DEG = 0.01;

export interface ParcelIndexEntry {
  countyFips: string;
  propId: string;
  parcelNodeId: string;
  ring: Ring;
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

export interface ParcelAdjacencyIndex {
  countyFips: string;
  originLng: number;
  originLat: number;
  mPerDegLng: number;
  mPerDegLat: number;
  entries: ReadonlyMap<string, ParcelIndexEntry>;
  /** Internal PRE-2 grid state (not serialized). */
  _indexed: Array<
    ParcelIndexEntry & {
      edgeProj: { x: number; y: number }[];
      pipPoints: { x: number; y: number }[];
      originLng: number;
      originLat: number;
      mPerDegLng: number;
      mPerDegLat: number;
      ccw: boolean;
    }
  >;
  _grid: Map<string, number[]>;
  _byPropId: Map<string, number>;
}

export const BOUNDARY_PRIMITIVE_SOURCE_ADAPTER =
  "boundary-primitive-cell-grid-pip-v1" as const;

export const BOUNDARY_PRIMITIVE_SOURCE_CITATION =
  "boundary-primitive-v1: one Neon jsonb+bbox load + ~1km cell grid + 3m outward probe + PIP (PRE-2 method)" as const;
