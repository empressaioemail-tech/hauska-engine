/**
 * Zoning staging source registry — city layer configs for Factory 1.5.
 *
 * cityGeoId values are roster-verified (texas_roster_v1.json):
 *   elgin-tx     place_fips 23044 → geoid 4823044  (CP1-F1: NOT 4823042)
 *   smithville-tx place_fips 68456 → geoid 4868456
 *
 * Fail closed if a cityKey is missing from this registry.
 */

import type { GeometryGrain, LayerRole } from "./payload-contract.js";
import { ZoningStagingContractError } from "./payload-contract.js";

export type ZoningCityRegistryEntry = {
  cityKey: string;
  cityName: string;
  /** Roster geoid (state+place FIPS). Fail closed if absent. */
  cityGeoId: string;
  parentCountyFips: string;
  /** Optional multi-county span note (CP1-F5 / Elgin Travis sliver). */
  allCountyFips?: string[];
  layerUrl: string;
  layerId: string;
  /** ArcGIS layer-metadata declaration. Never infer from attribute names. */
  objectIdField: string;
  codeField: string;
  descriptionField: string | null;
  codeDomainMap: Record<string, string> | null;
  codeExtractRegex: string | null;
  nullDistrictCodes: string[];
  layerWhere: string;
  /** Prefer richest first; satisfied tier is recorded at stage time. */
  sourceTier: string[];
  authPosture: "public-record";
  geometryTypeExpected: "esriGeometryPolygon";
  nativeCrsWkid: number;
  /** CP1-F2 */
  layerRole: LayerRole;
  /** CP1-F3 */
  geometryGrain: GeometryGrain;
  probeEvidencePath: string;
  verifiedAt: string;
  confidence: "high" | "medium" | "low";
  rosterCitation: string;
};

/**
 * Two-city CP1 pair. Do not invent geo_ids — values traced to
 * `_catalog/texas_roster_v1.json` 2026-08-12.
 */
export const ZONING_STAGING_REGISTRY: Record<string, ZoningCityRegistryEntry> = {
  "elgin-tx": {
    cityKey: "elgin-tx",
    cityName: "Elgin",
    cityGeoId: "4823044",
    parentCountyFips: "48021",
    allCountyFips: ["48021", "48453"],
    layerUrl:
      "https://services3.arcgis.com/wdTkTU0MdZbNBEZy/arcgis/rest/services/Elgin_Zoning/FeatureServer/0",
    layerId: "0",
    objectIdField: "OBJECTID",
    codeField: "Zone_Code",
    descriptionField: "Zoning",
    // Elgin A (legacy multifamily letter) → ordinance R-4.
    codeDomainMap: {
      "R-1": "R-1",
      "R-2": "R-2",
      "R-3": "R-3",
      A: "R-4",
      "C-1": "C-1",
      "C-2": "C-2",
      "C-3": "C-3",
      I: "I",
    },
    codeExtractRegex: null,
    nullDistrictCodes: [],
    layerWhere: "CITY_LIMIT = 'ELGIN'",
    sourceTier: ["municipal-arcgis-featureserver"],
    authPosture: "public-record",
    geometryTypeExpected: "esriGeometryPolygon",
    nativeCrsWkid: 102739,
    layerRole: "base",
    geometryGrain: "parcel-joined",
    probeEvidencePath: "_inbox/2026-08-12_H1_cp1_payload_contract_prereg.json",
    verifiedAt: "2026-08-12T16:05:11.759Z",
    confidence: "high",
    rosterCitation: "texas_roster_v1.json place_fips=23044 geoid=4823044",
  },
  "smithville-tx": {
    cityKey: "smithville-tx",
    cityName: "Smithville",
    cityGeoId: "4868456",
    parentCountyFips: "48021",
    allCountyFips: ["48021"],
    layerUrl:
      "https://services3.arcgis.com/wdTkTU0MdZbNBEZy/arcgis/rest/services/Smithville_Zoning/FeatureServer/0",
    layerId: "0",
    objectIdField: "OBJECTID",
    codeField: "ZONING",
    descriptionField: null,
    codeDomainMap: null,
    codeExtractRegex: null,
    nullDistrictCodes: [],
    layerWhere: "1=1",
    sourceTier: ["municipal-arcgis-featureserver"],
    authPosture: "public-record",
    geometryTypeExpected: "esriGeometryPolygon",
    nativeCrsWkid: 102739,
    layerRole: "base",
    geometryGrain: "district-polygon",
    probeEvidencePath: "_inbox/2026-08-12_H1_cp1_payload_contract_prereg.json",
    verifiedAt: "2026-08-12T16:05:11.759Z",
    confidence: "high",
    rosterCitation: "texas_roster_v1.json place_fips=68456 geoid=4868456",
  },
};

export function resolveZoningStagingCity(cityKey: string): ZoningCityRegistryEntry {
  const key = String(cityKey ?? "").trim().toLowerCase();
  const entry = ZONING_STAGING_REGISTRY[key];
  if (!entry) {
    throw new ZoningStagingContractError(
      `cityKey=${cityKey} missing from ZONING_STAGING_REGISTRY — fail closed (CP1-F1)`,
    );
  }
  if (!entry.cityGeoId || !/^\d{7}$/.test(entry.cityGeoId)) {
    throw new ZoningStagingContractError(
      `cityKey=${key} has invalid cityGeoId=${entry.cityGeoId} — roster lookup required (CP1-F1)`,
    );
  }
  return entry;
}

export function listZoningStagingCityKeys(): string[] {
  return Object.keys(ZONING_STAGING_REGISTRY).sort();
}
