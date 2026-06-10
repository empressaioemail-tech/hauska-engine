/**
 * Regrid national parcel + zoning baseline adapter pair — Cortex
 * prop-intel SCOPE B (2026-05-23).
 *
 * Coverage (10 tests / dispatch min was 6):
 *   1. happy path                 → both adapters emit one upstream call
 *   2. zoning-only no-coverage    → parcel ok, zoning no-coverage
 *   3. trial-token out-of-coverage→ both adapters surface as no-coverage
 *   4. HTTP 5xx upstream error    → both adapters surface as upstream-error
 *   5. malformed JSON             → parse-error
 *   6. cache hit                  → second call within TTL skips upstream
 *   7. partner-city enrichment    → grand-county-ut adapters fire when partnerCity=true
 *   8. non-partner skip           → grand-county-ut adapters skip when partnerCity!=true
 *   9. registry shape             → ALL_ADAPTERS contains both regrid adapters under FEDERAL
 *  10. missing REGRID_API_KEY     → upstream-error with diagnostic message
 *
 * Network is stubbed via `fetchImpl`. REGRID_API_KEY env is pinned in
 * `beforeEach` and restored in `afterEach` so the test order doesn't
 * matter.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  regridParcelsAdapter,
  regridZoningAdapter,
  __resetRegridDedupForTests,
} from "../national/regrid";
import {
  grandCountyParcelsAdapter,
  grandCountyZoningAdapter,
} from "../local/grand-county-ut";
import { runAdapters } from "../runner";
import { FEDERAL_ADAPTERS, ALL_ADAPTERS } from "../registry";
import { arcgisFeatureWithGeometry } from "../__fixtures__/arcgisFixtures";
import type { AdapterContext } from "../types";

/** Stable Moab-ish lat/lng for the happy paths. */
const MOAB: AdapterContext = {
  parcel: { latitude: 38.5733, longitude: -109.5498 },
  jurisdiction: { stateKey: "utah", localKey: "grand-county-ut" },
};

/** Same coordinates with the partner-city flag set. */
const MOAB_PARTNER: AdapterContext = {
  parcel: MOAB.parcel,
  jurisdiction: { ...MOAB.jurisdiction, partnerCity: true },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Stand-in for the Regrid `/parcels/point` envelope. Shape matches
 * the OpenAPI spec at doc_repo/_research/2026-05-23_regrid_openapi_v2.yaml.
 */
function regridResponseFixture(opts: {
  withParcel?: boolean;
  withZoning?: boolean;
  county?: string | null;
} = {}): Record<string, unknown> {
  const { withParcel = true, withZoning = true, county = "Grand County" } = opts;
  const parcelFeature = {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-109.5499, 38.5732],
          [-109.5497, 38.5732],
          [-109.5497, 38.5734],
          [-109.5499, 38.5734],
          [-109.5499, 38.5732],
        ],
      ],
    },
    properties: {
      headline: "1144 N Kayenta Dr",
      fields: {
        parcelnumb: "01-12345",
        owner: "Test Owner",
        county,
        ll_last_refresh: "2026-04-15",
        ll_updated_at: "2026-04-15T10:30:00Z",
      },
    },
    id: 42,
  };
  const zoningFeature = {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-109.5499, 38.5732],
          [-109.5497, 38.5732],
          [-109.5497, 38.5734],
          [-109.5499, 38.5734],
          [-109.5499, 38.5732],
        ],
      ],
    },
    properties: {
      fields: {
        zoning: "R-1",
        zoning_description: "Single-Family Residential",
        zoning_type: "residential",
        zoning_subtype: "single-family",
        zoning_code_link: "https://example.gov/code/r1",
      },
    },
  };
  const out: Record<string, unknown> = {};
  if (withParcel) {
    out.parcels = { type: "FeatureCollection", features: [parcelFeature] };
  } else {
    out.parcels = { type: "FeatureCollection", features: [] };
  }
  if (withZoning) {
    out.zoning = { type: "FeatureCollection", features: [zoningFeature] };
  } else {
    out.zoning = { type: "FeatureCollection", features: [] };
  }
  return out;
}

describe("Regrid adapters — SCOPE B", () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.REGRID_API_KEY;
    process.env.REGRID_API_KEY = "test-regrid-api-key";
    __resetRegridDedupForTests();
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.REGRID_API_KEY;
    } else {
      process.env.REGRID_API_KEY = originalApiKey;
    }
    __resetRegridDedupForTests();
  });

  it("[1] happy path — both adapters emit one ok row each from a single upstream call", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(regridResponseFixture()),
    );
    const outcomes = await runAdapters({
      adapters: [regridParcelsAdapter, regridZoningAdapter],
      context: { ...MOAB, fetchImpl },
    });
    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    expect(byKey["regrid:parcels"]?.status).toBe("ok");
    expect(byKey["regrid:zoning"]?.status).toBe("ok");
    const parcelResult = byKey["regrid:parcels"]?.result;
    expect(parcelResult?.tier).toBe("federal");
    expect(parcelResult?.sourceKind).toBe("national-aggregator");
    expect(parcelResult?.layerKind).toBe("regrid-parcel");
    expect(parcelResult?.provider).toContain("Regrid");
    // snapshotDate maps from ll_last_refresh.
    expect(parcelResult?.snapshotDate).toMatch(/^2026-04-15/);
    const parcelPayload = parcelResult?.payload as {
      kind: string;
      parcel: { type: string; geometry: { type: string } };
    };
    expect(parcelPayload?.kind).toBe("parcel");
    expect(parcelPayload?.parcel?.type).toBe("Feature");
    expect(parcelPayload?.parcel?.geometry?.type).toBe("Polygon");
    const zoningPayload = byKey["regrid:zoning"]?.result?.payload as {
      kind: string;
      zoning: { type: string };
    };
    expect(zoningPayload?.kind).toBe("zoning");
    expect(zoningPayload?.zoning?.type).toBe("Feature");
    // Only one upstream call despite two adapters — process-local dedup.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchImpl.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("app.regrid.com/api/v2/parcels/point");
    expect(calledUrl).toContain("lat=38.5733");
    expect(calledUrl).toContain("lon=-109.5498");
    expect(calledUrl).toContain("token=test-regrid-api-key");
  });

  it("[2] zoning empty — parcel ok, zoning no-coverage", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(regridResponseFixture({ withZoning: false })),
    );
    const outcomes = await runAdapters({
      adapters: [regridParcelsAdapter, regridZoningAdapter],
      context: { ...MOAB, fetchImpl },
    });
    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    expect(byKey["regrid:parcels"]?.status).toBe("ok");
    expect(byKey["regrid:zoning"]?.status).toBe("no-coverage");
    expect(byKey["regrid:zoning"]?.error?.code).toBe("no-coverage");
  });

  it("[3] trial-token out-of-coverage — both adapters surface as no-coverage", async () => {
    // Regrid returns HTTP 200 with an error envelope when the trial
    // token hits an out-of-coverage county. Empty parcels + error
    // message hinting at the trial gate.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        parcels: { type: "FeatureCollection", features: [] },
        zoning: { type: "FeatureCollection", features: [] },
        error:
          "API token trial restricted: data limited to 7 counties; lat/lng is outside the trial coverage.",
      }),
    );
    const outcomes = await runAdapters({
      adapters: [regridParcelsAdapter, regridZoningAdapter],
      context: { ...MOAB, fetchImpl },
    });
    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    // Both surface as no-coverage (NOT upstream-error) so the per-row
    // pill reads cleanly while the operator's trial token is restricted.
    expect(byKey["regrid:parcels"]?.status).toBe("no-coverage");
    expect(byKey["regrid:parcels"]?.error?.code).toBe("no-coverage");
    expect(byKey["regrid:parcels"]?.error?.message).toMatch(/trial/i);
    expect(byKey["regrid:zoning"]?.status).toBe("no-coverage");
  });

  it("[4] HTTP 5xx — surfaces as upstream-error with body excerpt", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("Service Unavailable: backend DB down", {
        status: 503,
        headers: { "content-type": "text/plain" },
      }),
    );
    const outcomes = await runAdapters({
      adapters: [regridParcelsAdapter],
      context: { ...MOAB, fetchImpl },
    });
    expect(outcomes[0]?.status).toBe("failed");
    expect(outcomes[0]?.error?.code).toBe("upstream-error");
    expect(outcomes[0]?.error?.message).toContain("HTTP 503");
    expect(outcomes[0]?.error?.message).toContain("Service Unavailable");
  });

  it("[5] malformed JSON — surfaces as parse-error", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("<html><body>oops</body></html>", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const outcomes = await runAdapters({
      adapters: [regridParcelsAdapter],
      context: { ...MOAB, fetchImpl },
    });
    expect(outcomes[0]?.status).toBe("failed");
    expect(outcomes[0]?.error?.code).toBe("parse-error");
  });

  it("[6] cache hit — second concurrent run within TTL skips the upstream call", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(regridResponseFixture()),
    );
    // First call — both adapters run, one upstream call.
    const firstOutcomes = await runAdapters({
      adapters: [regridParcelsAdapter, regridZoningAdapter],
      context: { ...MOAB, fetchImpl },
    });
    expect(firstOutcomes.every((o) => o.status === "ok")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Second call right after — should hit the in-memory dedup, no
    // additional upstream call.
    const secondOutcomes = await runAdapters({
      adapters: [regridParcelsAdapter, regridZoningAdapter],
      context: { ...MOAB, fetchImpl },
    });
    expect(secondOutcomes.every((o) => o.status === "ok")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("[7] partner-city enrichment — grand-county-ut:* adapters fire when partnerCity=true", async () => {
    // grand-county-ut adapters now gate on partnerCity. With the flag
    // set, they apply alongside the Regrid baseline.
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("regrid")) return jsonResponse(regridResponseFixture());
      // County-GIS endpoints return ArcGIS feature shape.
      return jsonResponse(arcgisFeatureWithGeometry);
    });
    const outcomes = await runAdapters({
      adapters: [
        regridParcelsAdapter,
        regridZoningAdapter,
        grandCountyParcelsAdapter,
        grandCountyZoningAdapter,
      ],
      context: { ...MOAB_PARTNER, fetchImpl },
    });
    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    expect(byKey["regrid:parcels"]?.status).toBe("ok");
    expect(byKey["regrid:zoning"]?.status).toBe("ok");
    expect(byKey["grand-county-ut:parcels"]?.status).toBe("ok");
    expect(byKey["grand-county-ut:zoning"]?.status).toBe("ok");
  });

  it("[8] non-partner skip — grand-county-ut:* adapters short-circuit no-coverage when partnerCity is missing", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("regrid")) return jsonResponse(regridResponseFixture());
      throw new Error("county-GIS should not be called on a non-partner engagement");
    });
    const outcomes = await runAdapters({
      adapters: [
        regridParcelsAdapter,
        regridZoningAdapter,
        grandCountyParcelsAdapter,
        grandCountyZoningAdapter,
      ],
      context: { ...MOAB, fetchImpl }, // no partnerCity flag
    });
    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    expect(byKey["regrid:parcels"]?.status).toBe("ok");
    expect(byKey["regrid:zoning"]?.status).toBe("ok");
    // Grand County adapters skip via `appliesTo === false`, surfaced
    // as `no-coverage` by the runner so the UI still renders a row.
    expect(byKey["grand-county-ut:parcels"]?.status).toBe("no-coverage");
    expect(byKey["grand-county-ut:zoning"]?.status).toBe("no-coverage");
    // No county-GIS fetch happened — only the Regrid endpoint.
    for (const call of fetchImpl.mock.calls) {
      expect(String(call[0])).toContain("regrid");
    }
  });

  it("[9] registry shape — ALL_ADAPTERS contains both regrid adapters in the federal block", () => {
    const keys = ALL_ADAPTERS.map((a) => a.adapterKey);
    expect(keys).toContain("regrid:parcels");
    expect(keys).toContain("regrid:zoning");
    const federalKeys = FEDERAL_ADAPTERS.map((a) => a.adapterKey);
    expect(federalKeys).toContain("regrid:parcels");
    expect(federalKeys).toContain("regrid:zoning");
  });

  it("[10] missing REGRID_API_KEY — surfaces as upstream-error with diagnostic message", async () => {
    delete process.env.REGRID_API_KEY;
    const fetchImpl = vi.fn(async () =>
      jsonResponse(regridResponseFixture()),
    );
    const outcomes = await runAdapters({
      adapters: [regridParcelsAdapter],
      context: { ...MOAB, fetchImpl },
    });
    expect(outcomes[0]?.status).toBe("failed");
    expect(outcomes[0]?.error?.code).toBe("upstream-error");
    expect(outcomes[0]?.error?.message).toMatch(/REGRID_API_KEY/);
    // No upstream call when the key is missing — we fail fast before fetch.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
