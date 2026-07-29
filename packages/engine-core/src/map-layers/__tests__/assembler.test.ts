import { describe, expect, it, vi } from "vitest";

import type { MapLayerAdapterOutcome } from "../adapterOutcome.js";
import { engineEnvelopeSchema } from "../../envelope/index.js";
import {
  aggregateMapLayersCoverage,
  assembleMapLayers,
  vintageFromMapLayers,
} from "../assembler";
import { MAP_LAYER_KEYS } from "../contract";

const baseRequest = {
  parcel: {
    latitude: 30.2672,
    longitude: -97.7431,
    address: "501 Congress Ave, Austin, TX",
    parcelKey: "parcel-test-1",
  },
  jurisdiction: { stateKey: "texas" as const, localKey: null },
};

function okOutcome(
  adapterKey: string,
  layerKind: string,
  payload: Record<string, unknown>,
): MapLayerAdapterOutcome {
  return {
    adapterKey,
    tier: "federal",
    layerKind,
    status: "ok",
    fromCache: false,
    cachedAt: null,
    result: {
      adapterKey,
      tier: "federal",
      layerKind,
      sourceKind: "national-aggregator",
      provider: "Test Provider",
      snapshotDate: "2026-06-01T00:00:00.000Z",
      payload,
    },
  };
}

describe("assembleMapLayers", () => {
  it("returns enveloped slots for all canonical layer keys", async () => {
    const runAdapterOutcomes = vi.fn().mockResolvedValue([
      okOutcome("cotality:parcels", "cotality-parcel", {
        kind: "parcel",
        parcel: { type: "Feature", geometry: { type: "Polygon" } },
      }),
      okOutcome("fema:nfhl-flood-zone", "fema-nfhl-flood-zone", {
        kind: "flood-zone",
        floodZone: "X",
      }),
      okOutcome("cotality:zoning", "cotality-zoning", {
        kind: "zoning",
        zone: "CBD",
      }),
    ]);

    const { payload } = await assembleMapLayers(
      baseRequest,
      { tenantId: "tenant-a", product: "cortex", requestId: "req-1" },
      { runAdapterOutcomes },
    );

    expect(payload.parcelKey).toBe("parcel-test-1");
    expect(payload.tenantScope).toBe("tenant-a");
    expect(payload.layers.map((l) => l.layerKey)).toEqual([...MAP_LAYER_KEYS]);

    for (const slot of payload.layers) {
      expect(slot.envelope).not.toBeNull();
      const parsed = engineEnvelopeSchema.safeParse(slot.envelope);
      expect(parsed.success, slot.layerKey).toBe(true);
      expect(typeof slot.envelope!.coverage.degraded).toBe("boolean");
      expect(slot.envelope!.confidence.kind).toBeTruthy();
    }
  });

  it("marks wave-3 slots no-coverage when resolver is absent", async () => {
    const { payload } = await assembleMapLayers(
      baseRequest,
      { tenantId: "tenant-a", product: "brief-extension", requestId: "req-2" },
      { runAdapterOutcomes: vi.fn().mockResolvedValue([]) },
    );

    const wave3 = payload.layers.filter((l) =>
      ["dem", "floodway", "opportunity-zone-tract", "topography"].includes(
        l.layerKey,
      ),
    );
    for (const slot of wave3) {
      expect(slot.status).toBe("no-coverage");
    }
  });

  it("resolves wave-3 slots via resolveWave3Slot dep", async () => {
    const resolveWave3Slot = vi.fn().mockImplementation(async (layerKey) => ({
      layerKey,
      status: "ok" as const,
      adapterKey: "wave3:test",
      envelope: {
        payload: { kind: layerKey },
        confidence: { value: 1, kind: "deterministic" },
        dataVintage: "2026-06-01T00:00:00.000Z",
        coverage: { degraded: false },
        source: { adapter: "wave3:test" },
      },
    }));

    const { payload } = await assembleMapLayers(
      baseRequest,
      { tenantId: "t", product: "cortex", requestId: "r" },
      {
        runAdapterOutcomes: vi.fn().mockResolvedValue([]),
        resolveWave3Slot,
      },
    );

    expect(resolveWave3Slot).toHaveBeenCalledTimes(7);
    const wave3 = payload.layers.filter((l) =>
      [
        "dem",
        "floodway",
        "opportunity-zone-tract",
        "topography",
        "topography-1ft",
        "hydrology-flow",
        "hydrography",
      ].includes(l.layerKey),
    );
    expect(wave3.every((s) => s.status === "ok")).toBe(true);
  });

  it("marks parcel-polygon pending when Cotality returns no geometry", async () => {
    const runAdapterOutcomes = vi.fn().mockResolvedValue([
      okOutcome("cotality:parcels", "cotality-parcel", {
        kind: "parcel",
        parcel: { type: "Feature", geometry: { type: "Polygon", coordinates: [] } },
      }),
    ]);

    const { payload } = await assembleMapLayers(
      baseRequest,
      { tenantId: "t", product: "cortex", requestId: "r" },
      { runAdapterOutcomes },
    );

    const parcel = payload.layers.find((l) => l.layerKey === "parcel-polygon");
    expect(parcel?.status).toBe("pending");
    expect(parcel?.pendingReason).toContain("Cotality");
    expect(parcel?.envelope?.coverage.degraded).toBe(true);
  });

  it("does not fall back to Regrid when Cotality is absent", async () => {
    const runAdapterOutcomes = vi.fn().mockResolvedValue([
      okOutcome("regrid:parcels", "regrid-parcel", {
        kind: "parcel",
        parcel: { type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0]]] } },
      }),
    ]);

    const { payload } = await assembleMapLayers(
      baseRequest,
      { tenantId: "t", product: "cortex", requestId: "r" },
      { runAdapterOutcomes },
    );

    const parcel = payload.layers.find((l) => l.layerKey === "parcel-polygon");
    expect(parcel?.status).toBe("pending");
    expect(parcel?.adapterKey).toBeUndefined();
  });

  it("scopes tenant on payload for gate handoff", async () => {
    const { payload } = await assembleMapLayers(
      baseRequest,
      { tenantId: "smartcity-tenant-42", product: "smartcity", requestId: "r" },
      { runAdapterOutcomes: vi.fn().mockResolvedValue([]) },
    );
    expect(payload.tenantScope).toBe("smartcity-tenant-42");
  });
});

describe("aggregateMapLayersCoverage", () => {
  it("reports partial when pending wave-3 slots exist", async () => {
    const { payload } = await assembleMapLayers(
      baseRequest,
      { tenantId: "t", product: "cortex", requestId: "r" },
      {
        runAdapterOutcomes: vi.fn().mockResolvedValue([
          okOutcome("fema:nfhl-flood-zone", "fema-nfhl-flood-zone", {
            kind: "flood-zone",
          }),
        ]),
      },
    );
    const coverage = aggregateMapLayersCoverage(payload.layers);
    expect(coverage.degraded).toBe(true);
    expect(coverage.reason).toContain("partial");
  });
});

describe("vintageFromMapLayers", () => {
  it("picks latest snapshot date from ok layers", async () => {
    const { payload } = await assembleMapLayers(
      baseRequest,
      { tenantId: "t", product: "cortex", requestId: "r" },
      {
        runAdapterOutcomes: vi.fn().mockResolvedValue([
          okOutcome("fema:nfhl-flood-zone", "fema-nfhl-flood-zone", {
            kind: "flood-zone",
          }),
        ]),
      },
    );
    expect(vintageFromMapLayers(payload.layers)).toBe("2026-06-01T00:00:00.000Z");
  });
});
