import { describe, expect, it, vi } from "vitest";
import { utahParcelsAdapter, utahDemAdapter } from "../state/utah";
import { idahoParcelsAdapter, idahoDemAdapter } from "../state/idaho";
import {
  grandCountyParcelsAdapter,
  grandCountyZoningAdapter,
  grandCountyRoadsAdapter,
} from "../local/grand-county-ut";
import {
  lemhiCountyParcelsAdapter,
  lemhiCountyZoningAdapter,
  lemhiCountyRoadsAdapter,
} from "../local/lemhi-county-id";
import { runAdapters } from "../runner";
import {
  arcgisFeatureWithGeometry,
  arcgisFeatureZoning,
  arcgisEmpty,
  jsonResponse,
  osmRoadsResponse,
} from "../__fixtures__/arcgisFixtures";
import type { AdapterContext } from "../types";
import { SLOW_UPSTREAM_TIMEOUT_MS } from "../timeouts";

// Cortex prop-intel SCOPE B (2026-05-23): grand-county-ut adapters
// now gate on `partnerCity: true` — the test fixture flips the flag
// so the existing per-county chain still fires here. Real engagements
// only get `partnerCity: true` when the jurisdiction is a Hauska
// substrate partner; today the moab fixture is the only such test case.
const moab: AdapterContext = {
  parcel: { latitude: 38.5733, longitude: -109.5498 },
  jurisdiction: {
    stateKey: "utah",
    localKey: "grand-county-ut",
    partnerCity: true,
  },
};
const salmon: AdapterContext = {
  parcel: { latitude: 45.1755, longitude: -113.8957 },
  jurisdiction: { stateKey: "idaho", localKey: "lemhi-county-id" },
};

/** Generic OK responder used by adapters that just want a feature list. */
function okFetch(body: unknown) {
  return vi.fn(async () => jsonResponse(body));
}

describe("Moab / Grand County UT adapter chain", () => {
  it("emits state-tier UGRC parcels + DEM and local-tier Grand County parcels/zoning at a Moab lat/lng", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("UtahDEM10Meter")) {
        return jsonResponse({ samples: [{ value: 4025.4 }] });
      }
      if (url.includes("/Parcels_") || url.includes("/Cadastre/")) {
        return jsonResponse(arcgisFeatureWithGeometry);
      }
      if (url.includes("Zoning")) {
        return jsonResponse(arcgisFeatureZoning);
      }
      return jsonResponse(arcgisFeatureWithGeometry);
    });

    const outcomes = await runAdapters({
      adapters: [
        utahDemAdapter,
        utahParcelsAdapter,
        grandCountyParcelsAdapter,
        grandCountyZoningAdapter,
      ],
      context: { ...moab, fetchImpl },
    });

    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    expect(byKey["ugrc:dem"].status).toBe("ok");
    expect(byKey["ugrc:parcels"].status).toBe("ok");
    expect(byKey["grand-county-ut:parcels"].status).toBe("ok");
    expect(byKey["grand-county-ut:zoning"].status).toBe("ok");

    // Tier metadata is what the UI uses to bucket sources — assert it
    // explicitly so a refactor that drops the field can't ship silently.
    expect(byKey["ugrc:dem"].result?.tier).toBe("state");
    expect(byKey["grand-county-ut:parcels"].result?.tier).toBe("local");
  });

  it("falls back to OSM Overpass for Grand County roads when the county GIS layer is empty", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("overpass")) {
        return jsonResponse(osmRoadsResponse);
      }
      // County GIS responds 200 with no features -> trigger the fallback.
      return jsonResponse(arcgisEmpty);
    });
    const outcomes = await runAdapters({
      adapters: [grandCountyRoadsAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      kind: string;
      source: string;
    };
    expect(payload.kind).toBe("roads");
    // The OSM fallback path tags the payload with `source: "osm"` and
    // overrides the result-level provider so the briefing engine can
    // attribute the fallback explicitly.
    expect(payload.source).toBe("osm");
    expect(outcomes[0].result?.provider).toMatch(/OpenStreetMap/i);
  });

  it("sends an identifying User-Agent and a permissive Accept on the Overpass POST so Apache does not 406 the request", async () => {
    // Production reproduction: with Node fetch's default headers
    // Overpass's Apache front door returned `HTTP 406 Not Acceptable`.
    // The adapter must spell out a UA + Accept on the POST so the
    // upstream accepts the call (Task #494).
    let overpassInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("overpass")) {
        overpassInit = init;
        return jsonResponse(osmRoadsResponse);
      }
      return jsonResponse(arcgisEmpty);
    });
    await runAdapters({
      adapters: [grandCountyRoadsAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(overpassInit).toBeDefined();
    const headers = (overpassInit?.headers ?? {}) as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/smartcity-plan-review/);
    expect(headers["Accept"]).toMatch(/application\/json/);
  });

  it("declares a roads-adapter timeout floor wide enough for two Overpass attempts", async () => {
    // Two attempts at the upstream's `[timeout:25]` plus backoff
    // should comfortably fit in the configured budget.
    expect(grandCountyRoadsAdapter.timeoutMs).toBeGreaterThanOrEqual(50_000);
  });

  it("completes the Overpass fallback when the first attempt 408s after 25s and the second succeeds near the upstream timeout", async () => {
    // Production-failure shape: Overpass hits its own server-side
    // `[timeout:25]` and returns HTTP 408 at ~25s, then the retry
    // succeeds at ~25s. Total ~50s — would be killed by the legacy
    // 15s runner default, but the adapter's timeout floor keeps the
    // window open.
    vi.useFakeTimers();
    try {
      let overpassCalls = 0;
      const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("overpass")) {
          overpassCalls += 1;
          await sleep(25_000);
          if (overpassCalls === 1) {
            return new Response("upstream timeout", { status: 408 });
          }
          return jsonResponse(osmRoadsResponse);
        }
        return jsonResponse(arcgisEmpty);
      });
      const promise = runAdapters({
        adapters: [grandCountyRoadsAdapter],
        context: { ...moab, fetchImpl, timeoutMs: 15_000 },
      });
      await vi.advanceTimersByTimeAsync(55_000);
      const outcomes = await promise;
      expect(outcomes[0].status).toBe("ok");
      expect(overpassCalls).toBe(2);
      const payload = outcomes[0].result?.payload as { source: string };
      expect(payload.source).toBe("osm");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries an immediate Overpass HTTP 408 before completing the OSM fallback", async () => {
    // First call hits the county GIS (empty -> triggers OSM fallback);
    // the next two calls hit Overpass — the first returns 408, the
    // second returns the recorded OSM body. The adapter must retry
    // the 408 instead of surfacing it as a hard failure.
    let overpassCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("overpass")) {
        overpassCalls += 1;
        if (overpassCalls === 1) {
          return new Response("upstream timeout", { status: 408 });
        }
        return jsonResponse(osmRoadsResponse);
      }
      return jsonResponse(arcgisEmpty);
    });
    const outcomes = await runAdapters({
      adapters: [grandCountyRoadsAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    expect(overpassCalls).toBe(2);
    const payload = outcomes[0].result?.payload as { source: string };
    expect(payload.source).toBe("osm");
  });
});

describe("Salmon / Lemhi County ID adapter chain", () => {
  it("emits INSIDE Idaho DEM + Lemhi parcels/zoning/roads outcomes at a Salmon lat/lng", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("overpass")) {
        return jsonResponse(osmRoadsResponse);
      }
      if (url.toLowerCase().includes("zon")) {
        return jsonResponse(arcgisFeatureZoning);
      }
      // Default: a non-empty ArcGIS feature envelope satisfies the
      // DEM/parcels adapters (they only care that `features` is present).
      return jsonResponse(arcgisFeatureWithGeometry);
    });

    const outcomes = await runAdapters({
      adapters: [
        idahoDemAdapter,
        idahoParcelsAdapter,
        lemhiCountyParcelsAdapter,
        lemhiCountyZoningAdapter,
        lemhiCountyRoadsAdapter,
      ],
      context: { ...salmon, fetchImpl },
    });

    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    expect(byKey["inside-idaho:dem"].status).toBe("ok");
    expect(byKey["inside-idaho:parcels"].status).toBe("ok");
    expect(byKey["lemhi-county-id:parcels"].status).toBe("ok");
    expect(byKey["lemhi-county-id:zoning"].status).toBe("ok");
    expect(byKey["lemhi-county-id:roads"].status).toBe("ok");
  });

  it("isolates a Lemhi zoning failure without breaking the parcel adapter", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.toLowerCase().includes("zon")) {
        return jsonResponse(
          { error: { code: 500, message: "boom" } },
          500,
        );
      }
      return jsonResponse(arcgisFeatureWithGeometry);
    });
    const outcomes = await runAdapters({
      adapters: [lemhiCountyParcelsAdapter, lemhiCountyZoningAdapter],
      context: { ...salmon, fetchImpl },
    });
    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    expect(byKey["lemhi-county-id:parcels"].status).toBe("ok");
    expect(byKey["lemhi-county-id:zoning"].status).toBe("failed");
  });
});

describe("QA-22 — Grand County per-adapter timeout floors", () => {
  it("parcels and zoning carry the widened SLOW_UPSTREAM_TIMEOUT_MS budget", () => {
    expect(grandCountyParcelsAdapter.timeoutMs).toBe(SLOW_UPSTREAM_TIMEOUT_MS);
    expect(grandCountyZoningAdapter.timeoutMs).toBe(SLOW_UPSTREAM_TIMEOUT_MS);
  });

  it("roads keeps its larger Overpass-sized budget, above the shared slow floor", () => {
    // Roads falls back to OSM Overpass, whose server-side
    // `[timeout:25]` directive needs more headroom than the shared
    // slow-upstream floor — so it is deliberately a distinct, larger
    // value rather than the shared constant.
    expect(grandCountyRoadsAdapter.timeoutMs).toBeGreaterThan(
      SLOW_UPSTREAM_TIMEOUT_MS,
    );
  });
});
