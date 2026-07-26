/**
 * Real parcel ring fixtures for geometry-correctness tests (R0 / 27c WDLL 1+2).
 *
 * Captured live 2026-07-25 from Bastrop County Cadastral FeatureServer
 * (`maps.co.bastrop.tx.us`, `f=geojson&inSR=4326&outSR=4326`) — same source
 * as `brokerageTxParcels.ts` Bastrop county config.
 */

import type { Ring } from "../geometry.js";

/** 714 Spring St — 48021:33512 (P-5, the live jagged-envelope repro). */
export const PARCEL_714_SPRING_33512: Ring = [
  [-97.318877912876758, 30.111687978216349],
  [-97.318877723732541, 30.112150529169611],
  [-97.319364216813966, 30.112141447326074],
  [-97.31936330526635, 30.111922981862524],
  [-97.319362685591784, 30.111852622210147],
  [-97.319361180474942, 30.111682368725386],
  [-97.318877912876758, 30.111687978216349],
];

/** Irregular Bastrop lot — 48021:47728 (companion QA parcel). */
export const PARCEL_BASTROP_47728: Ring = [
  [-97.318460282482718, 30.110629788548856],
  [-97.318453703414377, 30.111094015376466],
  [-97.318682876576474, 30.111095209469298],
  [-97.318682015964271, 30.110630969758134],
  [-97.318460282482718, 30.110629788548856],
];

/**
 * Injected wrong ring: the parcel boundary itself passed off as a 15' inset.
 * Must FAIL the geometry-correctness gate (WDLL 2 RED fixture).
 */
/** Synthetic 80x100ft rectangular lot for street-vs-alley warm tests. */
export const PARCEL_RECT_80x100: Ring = [
  [-97.32, 30.11],
  [-97.31975, 30.11],
  [-97.31975, 30.1103],
  [-97.32, 30.1103],
  [-97.32, 30.11],
];

/**
 * 1009 Chestnut St — 48021:34785 (P-5, ~98×165 ft near-rect).
 * Synthetic ring at Bastrop lat matching txgio dimensions for FIX 1 parity tests.
 */
/** Live txgio ring for 48021:34785 (2026-07-26 planner recon). Slightly skewed vs synthetic. */
export const PARCEL_1009_CHESTNUT_34785_LIVE_TXGIO: Ring = [
  [-97.31530582699997, 30.110068038000065],
  [-97.31561687599998, 30.110068166000076],
  [-97.31562900799997, 30.110515726000074],
  [-97.31531885299995, 30.11051941100004],
  [-97.31530582699997, 30.110068038000065],
];

export const PARCEL_1009_CHESTNUT_34785: Ring = (() => {
  const FEET = 0.3048;
  const W = 98 * FEET;
  const D = 165 * FEET;
  const lat0 = 30.110067;
  const lng0 = -97.3155;
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const mPerDegLng = mPerDegLat * Math.cos((lat0 * Math.PI) / 180);
  const dLat = D / mPerDegLat;
  const dLng = W / mPerDegLng;
  const sw: [number, number] = [lng0 - dLng / 2, lat0 - dLat / 2];
  return [
    [sw[0], sw[1]],
    [sw[0] + dLng, sw[1]],
    [sw[0] + dLng, sw[1] + dLat],
    [sw[0], sw[1] + dLat],
    [sw[0], sw[1]],
  ];
})();

