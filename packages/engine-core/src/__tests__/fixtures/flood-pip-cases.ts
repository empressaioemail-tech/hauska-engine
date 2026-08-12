/**
 * Adversarial point-in-polygon fixtures shared by the JS-semantics suite and
 * the PostGIS-gated suite, so both backends are graded against ONE table of
 * expected verdicts rather than two hand-maintained copies.
 *
 * `js` is the incumbent verdict from `pointInGeoJson` (the predicate every
 * flood atom written to date was planned with). `postgis` is the verdict from
 * ST_Contains. They differ only where a point is incident to a boundary.
 */

import type { FloodZoneFeature } from "../../flood-hazard-fact/geo.js";
import type { FloodParcelInput } from "../../flood-hazard-fact/plan-county-flood-hazard.js";

export const PIP_FIXTURE_TABLE = "f1_flood_zone_pip_fixture";
export const PIP_FIXTURE_BBOX = {
  westLng: -1,
  southLat: -1,
  eastLng: 11,
  northLat: 11,
};
export const PIP_FIXTURE_COUNTY = "48999";

export interface ZoneFixture {
  id: string;
  fldZone: string;
  sfhaTf: string;
  geometry: { type: string; coordinates: unknown };
}

function square(west: number, south: number, east: number, north: number) {
  return {
    type: "Polygon",
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  };
}

/**
 * zone_row_id values are chosen so SFHA-then-id ordering is unambiguous: in
 * the overlapping SFHA pair `z40-overlap-outer` sorts before
 * `z41-overlap-inner`, which is also the JS array order once sorted by id.
 */
export const PIP_ZONE_FIXTURES: ZoneFixture[] = [
  { id: "z10-boundary", fldZone: "AE", sfhaTf: "T", geometry: square(0, 0, 2, 2) },
  {
    id: "z20-donut",
    fldZone: "AE",
    sfhaTf: "T",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [3, 0],
          [7, 0],
          [7, 4],
          [3, 4],
          [3, 0],
        ],
        [
          [4.5, 1.5],
          [5.5, 1.5],
          [5.5, 2.5],
          [4.5, 2.5],
          [4.5, 1.5],
        ],
      ],
    },
  },
  {
    id: "z30-lshape",
    fldZone: "AO",
    sfhaTf: "T",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [0, 5],
          [4, 5],
          [4, 7],
          [2, 7],
          [2, 9],
          [0, 9],
          [0, 5],
        ],
      ],
    },
  },
  {
    id: "z40-overlap-outer",
    fldZone: "AE",
    sfhaTf: "T",
    geometry: square(6, 6, 10, 10),
  },
  {
    id: "z41-overlap-inner",
    fldZone: "AH",
    sfhaTf: "T",
    geometry: square(7, 7, 9, 9),
  },
  { id: "z50-nonsfha", fldZone: "X", sfhaTf: "F", geometry: square(6, 0, 10, 4) },
  {
    id: "z51-sfha-inside",
    fldZone: "AE",
    sfhaTf: "T",
    geometry: square(7, 1, 9, 3),
  },
  {
    id: "z60-multipolygon",
    fldZone: "A",
    sfhaTf: "T",
    geometry: {
      type: "MultiPolygon",
      coordinates: [
        square(3, 6, 4, 7).coordinates,
        square(4.5, 8, 5.5, 9).coordinates,
      ],
    },
  },
];

function bboxOf(geometry: { type: string; coordinates: unknown }) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === "number" && typeof node[1] === "number") {
      west = Math.min(west, node[0]);
      east = Math.max(east, node[0]);
      south = Math.min(south, node[1]);
      north = Math.max(north, node[1]);
      return;
    }
    for (const child of node) walk(child);
  };
  walk(geometry.coordinates);
  return { west, south, east, north };
}

/** JS zone array, ordered by zone_row_id so the tie-break matches the SQL. */
export const PIP_JS_ZONES: FloodZoneFeature[] = PIP_ZONE_FIXTURES.map((z) => {
  const b = bboxOf(z.geometry);
  return {
    zoneRowId: z.id,
    fldZone: z.fldZone,
    zoneSubty: null,
    sfhaTf: z.sfhaTf,
    staticBfe: null,
    geometry: z.geometry,
    westLng: b.west,
    southLat: b.south,
    eastLng: b.east,
    northLat: b.north,
    sourceVintage: "fixture",
  };
}).sort((a, b) => (a.zoneRowId < b.zoneRowId ? -1 : 1));

export interface PipCase {
  name: string;
  key: string;
  point: [number, number];
  /** Verdict from the incumbent JS predicate. "ABSENT" is never expected here. */
  js: string | null;
  /** Verdict from pure PostGIS ST_Contains. */
  postgis: string | null;
}

export const PIP_CASES: PipCase[] = [
  { name: "interior of a simple square", key: "P01", point: [1, 1], js: "AE", postgis: "AE" },
  {
    name: "exactly on a zone boundary edge",
    key: "P02",
    point: [1, 0],
    js: "AE",
    postgis: null,
  },
  {
    name: "exactly on a zone corner vertex",
    key: "P03",
    point: [2, 2],
    js: null,
    postgis: null,
  },
  { name: "inside a polygon hole", key: "P04", point: [5, 2], js: null, postgis: null },
  {
    name: "inside the ring of a polygon with a hole",
    key: "P05",
    point: [3.5, 0.5],
    js: "AE",
    postgis: "AE",
  },
  {
    name: "inside bbox but outside the L-shaped polygon",
    key: "P06",
    point: [3.5, 8.5],
    js: null,
    postgis: null,
  },
  {
    name: "inside the L-shaped polygon",
    key: "P07",
    point: [1, 6],
    js: "AO",
    postgis: "AO",
  },
  {
    name: "two overlapping SFHA zones — lowest zone_row_id wins",
    key: "P08",
    point: [8, 8],
    js: "AE",
    postgis: "AE",
  },
  {
    name: "SFHA preferred over an enclosing non-SFHA zone",
    key: "P09",
    point: [8, 2],
    js: "AE",
    postgis: "AE",
  },
  {
    name: "second part of a MultiPolygon",
    key: "P10",
    point: [5, 8.5],
    js: "A",
    postgis: "A",
  },
  {
    name: "outside every mapped zone",
    key: "P11",
    point: [10.5, 5],
    js: null,
    postgis: null,
  },
];

/** Cases where ST_Contains is expected to disagree with the JS ray cast. */
export const PIP_EXPECTED_DIVERGENCES = PIP_CASES.filter(
  (c) => c.js !== c.postgis,
).map((c) => c.name);

export const PIP_PARCELS: FloodParcelInput[] = PIP_CASES.map((c) => ({
  parcelKey: c.key,
  centroid: c.point,
}));
