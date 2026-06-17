/**
 * Minimal adapter-outcome port for map-layer assembly.
 *
 * engine-core stays independent of @hauska-engine/adapters; engine-api
 * maps AdapterRunOutcome values into this shape at the wire boundary.
 */

export interface MapLayerAdapterResult {
  adapterKey: string;
  layerKind: string;
  provider: string;
  snapshotDate: string;
  payload: Record<string, unknown>;
  note?: string | null;
}

export interface MapLayerAdapterOutcome {
  adapterKey: string;
  layerKind: string;
  status: "ok" | "no-coverage" | "failed";
  result?: MapLayerAdapterResult;
  error?: { code: string; message: string };
}
