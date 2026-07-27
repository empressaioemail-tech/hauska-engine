/**
 * PRE-2 spot-check expected parcel-parcel neighbors (edge index -> prop_id|null).
 */

export const EXPECTED_ADJACENCY_28286: Readonly<Record<number, string | null>> = {
  0: null,
  1: "32341",
  2: "35671",
  3: null,
};

export const EXPECTED_ADJACENCY_34785: Readonly<Record<number, string | null>> = {
  0: "34801",
  1: "34769",
  2: null,
  3: "34777",
};

export const EXPECTED_ADJACENCY_33512: Readonly<Record<number, string | null>> = {
  0: null,
  1: "48754",
  2: "33596",
  3: "33603",
  4: "33617",
  5: null,
};

export const GOLD_PARCEL_ADJACENCY_FIXTURES = {
  "48021:28286": EXPECTED_ADJACENCY_28286,
  "48021:34785": EXPECTED_ADJACENCY_34785,
  "48021:33512": EXPECTED_ADJACENCY_33512,
} as const;
