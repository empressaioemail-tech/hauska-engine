/**
 * Bastrop city per-parcel setback descriptor builder (WDLL STEP 1).
 * Fetches layer 23 and overlays descriptor.setbackTable for depth-warm.
 */

import {
  fetchBastropPerParcelSetbackRecord,
  getSetbackTableForZoning,
  type BastropPerParcelSetbackParsed,
} from "@hauska-engine/adapters";

import type { JurisdictionDescriptor } from "./types.js";
import { setbackTableDescriptorFromAdapter } from "./setback-table-from-adapter.js";

export function propIdFromParcelNodeId(parcelNodeId: string): string | null {
  const m = /^(\d{5}):([^:\s]+)$/.exec(parcelNodeId.trim());
  return m ? m[2]! : null;
}

export type BastropPerParcelDescriptorResult =
  | {
      ok: true;
      descriptor: JurisdictionDescriptor;
      record: BastropPerParcelSetbackParsed;
      /**
       * R26 — the GOVERNING (dominant-area) district. May differ from the engine
       * zoning stamp on split-zone parcels; the warm inset MUST key on THIS, not
       * the stamped sliver, or edge resolution misses the single per-parcel row.
       */
      governingDistrict: string;
    }
  | {
      ok: false;
      code: string;
      reason: string;
    };

/**
 * Build a jurisdiction descriptor whose setback NUMBERS come from layer 23.
 */
export async function buildBastropPerParcelSetbackDescriptor(
  base: JurisdictionDescriptor,
  parcelNodeId: string,
  district: string,
  cityKey: string,
  fetchImpl?: typeof fetch,
  centroidLngLat?: [number, number],
): Promise<BastropPerParcelDescriptorResult> {
  const propId = propIdFromParcelNodeId(parcelNodeId);
  if (!propId) {
    return {
      ok: false,
      code: "invalid-parcel-node-id",
      reason: `Expected {fips}:{prop_id}, got ${parcelNodeId}`,
    };
  }

  const fetched = await fetchBastropPerParcelSetbackRecord(propId, {
    fetchImpl,
    districtCode: district,
    centroidLngLat,
  });
  if (fetched.kind !== "parsed") {
    return {
      ok: false,
      code: fetched.code,
      reason: fetched.reason,
    };
  }

  // R26 — the DOMINANT-area layer-23 row governs the district, which may differ
  // from the engine zoning stamp when a parcel is split-zoned (e.g. a sliver).
  const governingDistrict = (fetched.resolvedDistrictCode ?? district).trim() || district;

  const adapterTable = getSetbackTableForZoning(cityKey, governingDistrict, {
    bastropPerParcelRecord: fetched,
    districtCode: governingDistrict,
  });
  const setbackTable = setbackTableDescriptorFromAdapter(adapterTable);
  if (!setbackTable?.rows?.length) {
    return {
      ok: false,
      code: "setback-table-missing",
      reason: "Per-parcel record did not produce a setback table row.",
    };
  }

  return {
    ok: true,
    record: fetched,
    governingDistrict,
    descriptor: {
      ...base,
      setbackTable,
      sourceAdapter: "bastrop-per-parcel-record-layer-23",
      sourceUrl: fetched.ordinanceLink,
    },
  };
}
