/**
 * R9 parcel-currency gate — prop_id must exist in current county cadastral (BCAD).
 * Dead/re-platted IDs surface as superseded, never a silently-nulled envelope.
 */

import type { Ring } from "../depth-warm/geometry.js";
import { openRing } from "../depth-warm/geometry.js";
import {
  BASTROP_BCAD_PARCELS_URL,
  fetchBcadParcelRings,
  type BcadParcelFetchResult,
} from "./lot-line-scrub.js";

export type ParcelCurrencyResult =
  | { ok: true; propId: string; ring: Ring; bcad: BcadParcelFetchResult }
  | {
      ok: false;
      propId: string;
      code: "superseded-prop-id";
      reason: string;
    };

/** Verify prop_id still resolves in authoritative BCAD cadastral. */
export async function assertParcelCurrencyInBcad(
  propId: string | number,
  fetchImpl?: typeof fetch,
  queryUrl = BASTROP_BCAD_PARCELS_URL,
): Promise<ParcelCurrencyResult> {
  const id = String(propId).trim();
  if (!id) {
    return {
      ok: false,
      propId: id,
      code: "superseded-prop-id",
      reason: "empty prop_id",
    };
  }

  const rows = await fetchBcadParcelRings([id], fetchImpl, queryUrl);
  const hit = rows.find((r) => String(r.propId) === id);
  if (!hit?.ring?.length) {
    return {
      ok: false,
      propId: id,
      code: "superseded-prop-id",
      reason: `prop_id ${id} absent from county cadastral — superseded; re-key manifest to successor parcel(s)`,
    };
  }

  return { ok: true, propId: id, ring: hit.ring, bcad: hit };
}

/** BCAD ring centroid for spatial layer-23 fallback (R9 re-plat companion). */
export function ringCentroidLngLat(ring: Ring): [number, number] {
  const verts = openRing(ring);
  if (!verts.length) return [0, 0];
  let lng = 0;
  let lat = 0;
  for (const [x, y] of verts) {
    lng += x;
    lat += y;
  }
  return [lng / verts.length, lat / verts.length];
}
