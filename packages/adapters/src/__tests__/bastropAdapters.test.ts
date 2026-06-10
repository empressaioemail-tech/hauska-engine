import { describe, expect, it, vi } from "vitest";
import {
  bastropFloodAdapter,
  bastropParcelsAdapter,
  bastropZoningAdapter,
} from "../local/bastrop-tx";
import { runAdapters } from "../runner";
import {
  arcgisEmpty,
  arcgisFeatureFloodplain,
  arcgisFeatureWithGeometry,
  arcgisFeatureZoning,
  jsonResponse,
} from "../__fixtures__/arcgisFixtures";
import type { AdapterContext } from "../types";

const ctx: AdapterContext = {
  parcel: { latitude: 30.1105, longitude: -97.3186 }, // Bastrop, TX
  jurisdiction: { stateKey: "texas", localKey: "bastrop-tx" },
};

describe("Bastrop County, TX adapters", () => {
  it("emits parcel + zoning + floodplain rows for an in-floodplain parcel", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/Cadastral/Parcels/")) {
        return jsonResponse(arcgisFeatureWithGeometry);
      }
      if (url.includes("/LandUse/Zoning/")) {
        return jsonResponse(arcgisFeatureZoning);
      }
      if (url.includes("/Hazards/Floodplain/")) {
        return jsonResponse(arcgisFeatureFloodplain);
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const outcomes = await runAdapters({
      adapters: [
        bastropParcelsAdapter,
        bastropZoningAdapter,
        bastropFloodAdapter,
      ],
      context: { ...ctx, fetchImpl },
    });

    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    expect(byKey["bastrop-tx:parcels"].status).toBe("ok");
    expect(byKey["bastrop-tx:zoning"].status).toBe("ok");
    expect(byKey["bastrop-tx:floodplain"].status).toBe("ok");
    expect(
      (byKey["bastrop-tx:floodplain"].result?.payload as { inMappedFloodplain: boolean })
        .inMappedFloodplain,
    ).toBe(true);
    // Each adapter persists tier + sourceKind so the wire projection can
    // bucket them straight into the federal/state/local UI groups.
    expect(byKey["bastrop-tx:parcels"].result?.tier).toBe("local");
    expect(byKey["bastrop-tx:parcels"].result?.sourceKind).toBe("local-adapter");
  });

  it("flags floodplain rows as outside-floodplain when the layer returns no features", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(arcgisEmpty));
    const outcomes = await runAdapters({
      adapters: [bastropFloodAdapter],
      context: { ...ctx, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    expect(
      (outcomes[0].result?.payload as { inMappedFloodplain: boolean })
        .inMappedFloodplain,
    ).toBe(false);
  });

  it("marks the parcel adapter no-coverage if the lat/lng misses every parcel polygon", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(arcgisEmpty));
    const outcomes = await runAdapters({
      adapters: [bastropParcelsAdapter],
      context: { ...ctx, fetchImpl },
    });
    // Per the runner's normalization: an adapter that ran but
    // determined the upstream feed has no coverage for this parcel
    // is the same wire status as a non-applicable adapter — both
    // surface as `no-coverage` with the matching error code so the
    // UI renders one neutral pill.
    expect(outcomes[0].status).toBe("no-coverage");
    expect(outcomes[0].error?.code).toBe("no-coverage");
  });

  it("does not run when the resolved jurisdiction is not Bastrop", async () => {
    const fetchImpl = vi.fn();
    const outcomes = await runAdapters({
      adapters: [bastropParcelsAdapter],
      context: {
        parcel: ctx.parcel,
        jurisdiction: { stateKey: "utah", localKey: "grand-county-ut" },
        fetchImpl,
      },
    });
    expect(outcomes[0].status).toBe("no-coverage");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
