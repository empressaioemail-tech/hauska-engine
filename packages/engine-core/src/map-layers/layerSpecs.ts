import type { MapLayerKey } from "./contract.js";

export interface MapLayerSpec {
  layerKey: MapLayerKey;
  /** Adapter keys tried in priority order (first ok wins). */
  adapterKeys?: readonly string[];
  /** Resolved by engine-api wave-3 geometry (cc-agent-C). */
  wave3?: boolean;
  pendingReason?: string;
  /** Cotality-only layers: missing geometry → pending, not silent fallback. */
  requiresGeometry?: boolean;
}

/**
 * Layer assembly map — adapter-backed slots + wave-3 geometry resolvers.
 */
export const MAP_LAYER_SPECS: readonly MapLayerSpec[] = [
  {
    layerKey: "parcel-polygon",
    adapterKeys: ["cotality:parcels"],
    requiresGeometry: true,
    pendingReason:
      "Cotality returned no parcel polygon",
  },
  {
    layerKey: "flood-zone",
    adapterKeys: ["fema:nfhl-flood-zone"],
  },
  {
    layerKey: "floodway",
    wave3: true,
    adapterKeys: ["fema:nfhl-flood-zone"],
  },
  {
    layerKey: "dem",
    wave3: true,
  },
  {
    layerKey: "topography",
    wave3: true,
  },
  {
    layerKey: "opportunity-zone-tract",
    wave3: true,
  },
  {
    layerKey: "zoning",
    adapterKeys: ["cotality:zoning"],
    requiresGeometry: true,
    pendingReason:
      "Cotality returned no zoning geometry at this parcel",
  },
];

export function specForLayer(layerKey: MapLayerKey): MapLayerSpec {
  const spec = MAP_LAYER_SPECS.find((s) => s.layerKey === layerKey);
  if (!spec) {
    throw new Error(`unknown map layer key: ${layerKey}`);
  }
  return spec;
}

export function adapterKeysForMapLayers(
  layerKeys: readonly MapLayerKey[],
): string[] {
  const keys = new Set<string>();
  for (const layerKey of layerKeys) {
    const spec = specForLayer(layerKey);
    for (const ak of spec.adapterKeys ?? []) {
      keys.add(ak);
    }
  }
  return [...keys];
}
