import { z } from "zod";

import type { EngineEnvelope } from "../envelope/schema.js";

/**
 * Canonical map layer keys — shared across engine-api, hauska-mcp-server
 * (cc-agent-M gate exposure), and cortex-api/extension consumers (cc-agent-C).
 */
export const MAP_LAYER_KEYS = [
  "parcel-polygon",
  "flood-zone",
  "floodway",
  "dem",
  "topography",
  // Authoritative 1-ft LiDAR contours (Bastrop) with honest 3DEP fallback.
  // Distinct from `topography` (always 3DEP-derived 1m contours) so the map can
  // label the true interval/source per bbox and never mislabel 3DEP as 1-ft.
  "topography-1ft",
  // Live D8 flow channels for a viewport bbox (bbox -> GeoJSON LineStrings).
  // DERIVED tier — stays in the engine as report input; the customer map layer
  // for water features is `hydrography` (county-mapped, authoritative).
  "hydrology-flow",
  // County-MAPPED water features (creeks/streams) for a viewport bbox, from a
  // county-configured ArcGIS source (registry-driven, county-agnostic).
  // Counties without a configured source get honest-unavailable, never an
  // OSM-derived or D8-derived substitution.
  "hydrography",
  "opportunity-zone-tract",
  "zoning",
] as const;

export type MapLayerKey = (typeof MAP_LAYER_KEYS)[number];

/** Gate package id cc-agent-M should authorize for this capability. */
export const MAP_LAYERS_PACKAGE_ID = "map-layers" as const;

export const mapLayerKeySchema = z.enum(MAP_LAYER_KEYS);

export const mapLayersParcelSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  address: z.string().nullable().optional(),
  /** Stable parcel key for audit (APN, engagement id, or gate-issued id). */
  parcelKey: z.string().min(1).optional(),
});

export const mapLayersJurisdictionSchema = z.object({
  stateKey: z.enum(["utah", "idaho", "texas"]).nullable(),
  localKey: z
    .enum(["grand-county-ut", "lemhi-county-id", "bastrop-tx"])
    .nullable(),
  partnerCity: z.boolean().optional(),
});

export const mapLayersBboxSchema = z.object({
  westLng: z.number(),
  southLat: z.number(),
  eastLng: z.number(),
  northLat: z.number(),
});

export const mapLayersAssembleRequestSchema = z.object({
  parcel: mapLayersParcelSchema,
  jurisdiction: mapLayersJurisdictionSchema,
  /** Subset of layers; default all {@link MAP_LAYER_KEYS}. */
  layers: z.array(mapLayerKeySchema).optional(),
  forceRefresh: z.boolean().optional(),
  /**
   * Optional catchment bbox for DEM/topography once cc-agent-C wave-3
   * geometry lands. Ignored for pending shell slots until wired.
   */
  bbox: mapLayersBboxSchema.optional(),
});

export type MapLayersAssembleRequest = z.infer<
  typeof mapLayersAssembleRequestSchema
>;

export type MapLayerSlotStatus =
  | "ok"
  | "pending"
  | "no-coverage"
  | "dead-expected"
  | "failed";

/** Geometry + attribution surfaced to map renderers (not raw data sale). */
export interface MapLayerGeometryPayload {
  kind: string;
  geojson?: unknown;
  attributes?: Record<string, unknown>;
  provider?: string;
  snapshotDate?: string;
  note?: string | null;
}

export interface MapLayerSlot {
  layerKey: MapLayerKey;
  status: MapLayerSlotStatus;
  /** Per-layer sealed envelope — never bare geometry at the wire root. */
  envelope: EngineEnvelope<MapLayerGeometryPayload> | null;
  adapterKey?: string;
  pendingReason?: string;
  error?: { code: string; message: string };
}

export interface MapLayersAssemblePayload {
  parcelKey: string;
  place: {
    latitude: number;
    longitude: number;
    formattedAddress?: string | null;
  };
  tenantScope: string;
  layers: MapLayerSlot[];
  assembledAt: string;
}

export interface MapLayersAssembleResult {
  payload: MapLayersAssemblePayload;
}
