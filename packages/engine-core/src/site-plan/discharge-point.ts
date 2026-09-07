/**
 * P-120 item 19 — named downstream discharge point.
 *
 * The D8 flood-drainage model already computes a real, un-named exit
 * coordinate per flow line (`FloodDrainageFlowExit`, `flood-drainage-study.ts`)
 * — where modeled flow leaves the parcel. This module names that point by
 * matching it against the county's own mapped hydrography (real named
 * creeks/streams, `@hauska-engine/adapters/hydrography`), reusing the
 * point-to-line-segment distance helpers already built for rail-corridor
 * proximity rather than re-deriving them.
 *
 * Honest by construction: a county with no registered hydrography source, or
 * a lookup that turns up no named feature within the search radius, is an
 * absence with a real reason — never a fabricated name.
 */
import {
  fetchCountyHydrography,
  resolveCountyHydrographySource,
  type CountyHydrographyFeature,
} from "@hauska-engine/adapters/hydrography";

import { lineStringsFromGeoJson, pointToSegmentMeters, type LngLat } from "../rail-corridor-fact/geo.js";

export interface NamedDischargePoint {
  name: string;
  featureType: string | null;
  distanceMeters: number;
  sourceUrl: string;
  layerName: string;
}

export type NamedDischargePointResult =
  | { status: "present"; point: NamedDischargePoint }
  | { status: "absent"; reason: string };

/** Generous but bounded — a match further than this isn't the discharge point, it's a coincidence. */
const SEARCH_RADIUS_METERS = 3000;
const METERS_PER_DEG_LAT = 111_320;

export interface DischargePointResolver {
  resolve(exitPoint: { lat: number; lng: number }): Promise<NamedDischargePointResult>;
}

/** Real, live resolver backed by the county-hydrography adapter. */
export function createCountyHydrographyDischargeResolver(
  fetchImpl?: typeof fetch,
): DischargePointResolver {
  return {
    async resolve(exitPoint) {
      const dLat = SEARCH_RADIUS_METERS / METERS_PER_DEG_LAT;
      const dLng = dLat / Math.max(0.2, Math.cos((exitPoint.lat * Math.PI) / 180));
      const bbox = {
        westLng: exitPoint.lng - dLng,
        eastLng: exitPoint.lng + dLng,
        southLat: exitPoint.lat - dLat,
        northLat: exitPoint.lat + dLat,
      };

      const source = resolveCountyHydrographySource(bbox);
      if (!source) {
        return {
          status: "absent",
          reason: "No county hydrography source registered for this parcel's county.",
        };
      }

      let result;
      try {
        result = await fetchCountyHydrography(source, bbox, { fetchImpl });
      } catch (error) {
        return {
          status: "absent",
          reason: `County hydrography lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      const point: LngLat = [exitPoint.lng, exitPoint.lat];
      let best: { feature: CountyHydrographyFeature; distanceMeters: number } | null = null;
      for (const feature of result.features) {
        if (!feature.properties.name) continue;
        for (const line of lineStringsFromGeoJson(feature.geometry)) {
          for (let i = 0; i < line.length - 1; i++) {
            const d = pointToSegmentMeters(point, line[i]!, line[i + 1]!);
            if (!best || d < best.distanceMeters) {
              best = { feature, distanceMeters: d };
            }
          }
        }
      }

      if (!best || best.distanceMeters > SEARCH_RADIUS_METERS) {
        return {
          status: "absent",
          reason: "No named waterway found near the modeled discharge point.",
        };
      }

      return {
        status: "present",
        point: {
          name: best.feature.properties.name!,
          featureType: best.feature.properties.featureType,
          distanceMeters: best.distanceMeters,
          sourceUrl: result.sourceUrl,
          layerName: result.layerName,
        },
      };
    },
  };
}
