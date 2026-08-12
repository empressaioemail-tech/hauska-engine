/**
 * Factory 1.5 zoning staging — normalised payload contract.
 *
 * Staging lands in neondb `tx_zoning_district_staging`. Factory 2 zoning
 * writers will drain this table later; this module never mints atoms.
 *
 * CP1-F2: `layerRole` is registry-authoritative (base|overlay|unknown).
 * CP1-F3: `geometryGrain` records parcel-joined vs district-polygon.
 * CP1-F4: `sourceTierSatisfied` must be non-empty (fail closed).
 */

export type LayerRole = "base" | "overlay" | "unknown";
export type GeometryGrain = "parcel-joined" | "district-polygon";

export type GeoJsonPolygon = {
  type: "Polygon" | "MultiPolygon";
  coordinates: unknown;
};

export type ZoningStagingPayload = {
  stagingRowId: string;
  cityKey: string;
  cityGeoId: string;
  cityName: string;
  parentCountyFips: string;
  districtCode: string;
  districtName: string | null;
  geometry: GeoJsonPolygon;
  geometryCrs: string;
  isOverlay: boolean;
  isBaseDistrict: boolean;
  /** CP1-F2 — registry layer role; drain refuses overlay / unknown+baseOnly. */
  layerRole: LayerRole;
  /** CP1-F3 — geometric grain; do not dissolve parcel-joined layers. */
  geometryGrain: GeometryGrain;
  sourceUrl: string;
  sourceLayerId: string;
  fetchedAt: string;
  sourceTier: string[];
  /** CP1-F4 — which tier actually satisfied the fetch; never empty. */
  sourceTierSatisfied: string[];
  sourceVintage: string;
  sourceCitation: string;
  passthroughAttributes: Record<string, unknown>;
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
  codeFieldRaw: string | null;
  /**
   * True when registry codeDomainMap remapped the raw code
   * (e.g. Elgin A → R-4). False when identity or no map.
   */
  codeDomainMapApplied: boolean;
  layerWhere: string;
  objectId: string;
};

export class ZoningStagingContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZoningStagingContractError";
  }
}

/** Composite PK — never districtCode alone (cross-city C-3 collision trap). */
export function buildStagingRowId(cityKey: string, objectId: string | number): string {
  const ck = String(cityKey ?? "").trim();
  const oid = String(objectId ?? "").trim();
  if (!ck || !oid) {
    throw new ZoningStagingContractError(
      `stagingRowId requires cityKey and objectId (got cityKey=${ck! || "<empty>"} objectId=${oid || "<empty>"})`,
    );
  }
  return `${ck}:${oid}`;
}

/** Fail closed when harvest tier honesty is missing (CP1-F4). */
export function assertSourceTierSatisfied(tiers: unknown, context: string): string[] {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new ZoningStagingContractError(
      `${context}: sourceTierSatisfied must be a non-empty array (silent tier fallback forbidden)`,
    );
  }
  const cleaned = tiers.map((t) => String(t ?? "").trim()).filter(Boolean);
  if (cleaned.length === 0) {
    throw new ZoningStagingContractError(
      `${context}: sourceTierSatisfied has no non-empty tier labels`,
    );
  }
  return cleaned;
}

export function assertPayloadContract(row: ZoningStagingPayload, context = "payload"): void {
  if (!row.stagingRowId.includes(":")) {
    throw new ZoningStagingContractError(
      `${context}: stagingRowId must be cityKey:objectId composite`,
    );
  }
  if (!row.cityKey || !row.cityGeoId || !row.parentCountyFips) {
    throw new ZoningStagingContractError(
      `${context}: cityKey, cityGeoId, parentCountyFips are required`,
    );
  }
  if (!row.districtCode) {
    throw new ZoningStagingContractError(`${context}: districtCode required`);
  }
  if (!row.geometry || (row.geometry.type !== "Polygon" && row.geometry.type !== "MultiPolygon")) {
    throw new ZoningStagingContractError(`${context}: geometry must be Polygon or MultiPolygon`);
  }
  assertSourceTierSatisfied(row.sourceTierSatisfied, context);
  if (!row.layerRole) {
    throw new ZoningStagingContractError(`${context}: layerRole required (CP1-F2)`);
  }
  if (!row.geometryGrain) {
    throw new ZoningStagingContractError(`${context}: geometryGrain required (CP1-F3)`);
  }
}
