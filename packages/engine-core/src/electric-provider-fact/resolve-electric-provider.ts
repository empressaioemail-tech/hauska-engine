/**
 * P-120 item 21 (electric half) -- electric provider identification, staged
 * HIFLD data first.
 *
 * Real live check 2026-09-07 at both Bastrop test parcels (48021:52726,
 * 48021:52727): HIFLD's retail-territory layer returns THREE overlapping
 * candidates at that point -- "CITY OF BASTROP - (TX)" (municipal),
 * "BLUEBONNET ELECTRIC COOP, INC" (cooperative), "FAYETTE ELECTRIC COOP,
 * INC" (cooperative) -- a real HIFLD data-quality artifact (municipal
 * carve-outs are not always cleanly clipped out of the surrounding co-op
 * polygon), not a resolver bug. The honest answer is present-with-multiple-
 * candidates, never a silent pick of the "obvious" one (downtown Bastrop
 * reads as City of Bastrop, but that is a plausibility judgment, not a
 * verified single-source fact) and never a collapse to absence when real
 * data did reach the parcel.
 */
import { queryHifldElectricTerritory, type HifldElectricTerritory } from "./hifld-query.js";

export interface ElectricProviderFacts {
  candidates: HifldElectricTerritory[];
  /** True when more than one HIFLD territory polygon intersects the point --
   * a real, disclosed ambiguity, never silently resolved to one name. */
  ambiguous: boolean;
  sourceCitation: string;
}

export type ElectricProviderResult =
  | { status: "present"; facts: ElectricProviderFacts }
  | { status: "absent"; reason: string };

const HIFLD_SOURCE_CITATION =
  "HIFLD Electric Retail Service Territories (services2.arcgis.com/LYMgRMwHfrWWEg3s), same source staged 2026-08-14 as source_key hifld-electric-retail";

export async function resolveElectricProviderFact(
  point: { latitude: number; longitude: number },
  fetchImpl?: typeof fetch,
  signal?: AbortSignal,
): Promise<ElectricProviderResult> {
  let candidates: HifldElectricTerritory[];
  try {
    candidates = await queryHifldElectricTerritory(point, fetchImpl, signal);
  } catch (error) {
    return {
      status: "absent",
      reason: `HIFLD electric-retail-territory lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (candidates.length === 0) {
    return {
      status: "absent",
      reason: "The staged HIFLD electric-retail-territory data does not reach this parcel (no intersecting polygon).",
    };
  }

  return {
    status: "present",
    facts: { candidates, ambiguous: candidates.length > 1, sourceCitation: HIFLD_SOURCE_CITATION },
  };
}
