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
): Promise<BastropPerParcelDescriptorResult> {
  const propId = propIdFromParcelNodeId(parcelNodeId);
  if (!propId) {
    return {
      ok: false,
      code: "invalid-parcel-node-id",
      reason: `Expected {fips}:{prop_id}, got ${parcelNodeId}`,
    };
  }

  const fetched = await fetchBastropPerParcelSetbackRecord(propId, { fetchImpl });
  if (fetched.kind !== "parsed") {
    return {
      ok: false,
      code: fetched.code,
      reason: fetched.reason,
    };
  }

  const adapterTable = getSetbackTableForZoning(cityKey, district, {
    bastropPerParcelRecord: fetched,
    districtCode: district,
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
    descriptor: {
      ...base,
      setbackTable,
      sourceAdapter: "bastrop-per-parcel-record-layer-23",
      sourceUrl: fetched.ordinanceLink,
    },
  };
}
