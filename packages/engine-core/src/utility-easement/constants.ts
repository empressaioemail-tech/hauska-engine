/**
 * County easement routing — T3 ingest spec §3.2 / §3.3 snapshot (2026-08-05).
 */

export type EasementAdapterKind =
  | "cad-easement-rest"
  | "county-gis-easement-rest"
  | "municipal-easement-rest"
  | "record-extracted"
  | "utility-adjacent-skip"
  | "honest-absence";

export type EasementSourceTier =
  | "plat-gis-authoritative"
  | "county-gis"
  | "record-extracted"
  | "absent";

export type EasementScope = "county" | "municipal-etj" | "city-limits";

export interface CountyEasementRouteBase {
  adapterKind: EasementAdapterKind;
  sourceTier: EasementSourceTier;
  sourceUrl: string | null;
  scope: EasementScope;
}

export interface HonestAbsenceEasementRoute extends CountyEasementRouteBase {
  adapterKind: "honest-absence";
  sourceTier: "absent";
  sourceUrl: null;
  provenanceScope: readonly string[];
}

export interface CadEasementRestRoute extends CountyEasementRouteBase {
  adapterKind: "cad-easement-rest";
  sourceTier: "plat-gis-authoritative";
  serviceRootUrl: string;
  layerIds: readonly number[];
  corridorDefaultWidthFt: number;
}

export interface MunicipalEasementRestRoute extends CountyEasementRouteBase {
  adapterKind: "municipal-easement-rest";
  sourceTier: "county-gis";
  layerUrl: string;
  layerName: string;
  cityField: string;
  cityLimitsValue: string;
  parcelLayerUrl: string;
}

export type CountyEasementRoute =
  | HonestAbsenceEasementRoute
  | CadEasementRestRoute
  | MunicipalEasementRestRoute;

export const BASTROP_FIPS = "48021";
export const MCLENNAN_FIPS = "48309";

export const BASTROP_COUNTY_EASEMENT_PROVENANCE_SCOPE = [
  "maps.co.bastrop.tx.us/server/rest/services — no county easement layer",
  "BastropCADWebService — no easement layer",
  "document-parse track — county clerk plats",
] as const;

export const MCLENNAN_CAD_EASEMENT_SERVICE_ROOT =
  "https://services8.arcgis.com/5e4b1SY8bogTc3pH/arcgis/rest/services/McLennanCADWebService/FeatureServer";

export const BASTROP_MUNICIPAL_EASEMENTS_LAYER_URL =
  "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Easements_/FeatureServer/43";

export const BASTROP_BCAD_PARCELS_LAYER_URL =
  "https://maps.co.bastrop.tx.us/server/rest/services/Cadastral_BP/Bastrop_County_Parcels/FeatureServer/0";

/** Default breadth cohort: honest-absence at county scope. */
export const DEFAULT_HONEST_ABSENCE_PROVENANCE = [
  "county-cad-gis-catalog — no queryable property easement layer",
  "document-parse track — county clerk plats (out of scope v1 bulk ingest)",
] as const;

const HONEST_ABSENCE_BY_FIPS: Readonly<Record<string, readonly string[]>> = {
  [BASTROP_FIPS]: BASTROP_COUNTY_EASEMENT_PROVENANCE_SCOPE,
};

/**
 * Resolve easement routing for a county + scope pair.
 * Present-data exceptions: 48309 cad-easement-rest; Bastrop city-limits municipal.
 */
export function resolveCountyEasementRoute(
  countyFips: string,
  scope: EasementScope = "county",
): CountyEasementRoute {
  if (scope === "city-limits" && countyFips === BASTROP_FIPS) {
    return {
      adapterKind: "municipal-easement-rest",
      sourceTier: "county-gis",
      sourceUrl: BASTROP_MUNICIPAL_EASEMENTS_LAYER_URL,
      scope: "city-limits",
      layerUrl: BASTROP_MUNICIPAL_EASEMENTS_LAYER_URL,
      layerName: "Easements_/43",
      cityField: "city",
      cityLimitsValue: "BASTROP",
      parcelLayerUrl: BASTROP_BCAD_PARCELS_LAYER_URL,
    };
  }

  if (countyFips === MCLENNAN_FIPS && scope === "county") {
    return {
      adapterKind: "cad-easement-rest",
      sourceTier: "plat-gis-authoritative",
      sourceUrl: MCLENNAN_CAD_EASEMENT_SERVICE_ROOT,
      scope: "county",
      serviceRootUrl: MCLENNAN_CAD_EASEMENT_SERVICE_ROOT,
      layerIds: [9, 10],
      corridorDefaultWidthFt: 10,
    };
  }

  return {
    adapterKind: "honest-absence",
    sourceTier: "absent",
    sourceUrl: null,
    scope: "county",
    provenanceScope:
      HONEST_ABSENCE_BY_FIPS[countyFips] ?? DEFAULT_HONEST_ABSENCE_PROVENANCE,
  };
}
