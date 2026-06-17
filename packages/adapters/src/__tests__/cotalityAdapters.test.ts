/**
 * Cotality parcel + zoning adapters — OAuth2 + CLIP-joined Spatial Tile / Property API.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cotalityParcelsAdapter,
  cotalityZoningAdapter,
  __resetCotalityDedupForTests,
  __resetCotalityTokenCacheForTests,
  __resetCotalityClipDedupForTests,
  cotalityTokenUrl,
  cotalityPropertyBaseUrl,
  cotalitySpatialTileBaseUrl,
} from "../national/cotality";
import { runAdapters } from "../runner";
import { FEDERAL_ADAPTERS, ALL_ADAPTERS } from "../registry";
import {
  ROUND_ROCK,
  cotalityGeocodeSearchResponse,
  cotalityOAuthTokenResponse,
  cotalitySiteLocationNoZoningResponse,
  cotalitySiteLocationResponse,
  cotalitySpatialParcelsResponse,
} from "../__fixtures__/cotalityFixtures";

const TEST_CREDS = {
  COTALITY_PROPERTY_KEY: "prop-key",
  COTALITY_PROPERTY_SECRET: "prop-secret",
  COTALITY_SPATIALTILE_KEY: "tile-key",
  COTALITY_SPATIALTILE_SECRET: "tile-secret",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tokenForBody(body: string): string {
  if (body.includes("prop-key")) return "property-token";
  if (body.includes("tile-key")) return "tile-token";
  return "unknown-token";
}

/** Mock router for token + geocode + spatial parcels + site-location. */
function cotalityFetchRouter(opts: {
  siteLocationBody?: unknown;
  spatialBody?: unknown;
  geocodeEmpty?: boolean;
} = {}) {
  const {
    siteLocationBody = cotalitySiteLocationResponse,
    spatialBody = cotalitySpatialParcelsResponse,
    geocodeEmpty = false,
  } = opts;

  let propertyTokenPosts = 0;
  let tileTokenPosts = 0;

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/oauth/token") || url === cotalityTokenUrl()) {
      const body = init?.body?.toString() ?? "";
      if (body.includes("prop-key")) propertyTokenPosts += 1;
      if (body.includes("tile-key")) tileTokenPosts += 1;
      expect(body).toContain("scope=openid");
      const token = body.includes("tile-key")
        ? "tile-token"
        : "property-token";
      return jsonResponse({ ...cotalityOAuthTokenResponse, access_token: token });
    }

    const auth = (init?.headers as Record<string, string> | undefined)
      ?.Authorization;

    if (url.includes("/search/geocode")) {
      expect(auth).toBe("Bearer property-token");
      if (geocodeEmpty) return jsonResponse({ items: [] });
      return jsonResponse(cotalityGeocodeSearchResponse);
    }
    if (url.includes("/site-location")) {
      expect(auth).toBe("Bearer property-token");
      return jsonResponse(siteLocationBody);
    }

    if (
      url.includes("/spatial-tile/parcels") ||
      url.includes(cotalitySpatialTileBaseUrl())
    ) {
      expect(auth).toBe("Bearer tile-token");
      return jsonResponse(spatialBody);
    }

    return new Response(`unexpected url: ${url}`, { status: 404 });
  });

  return {
    fetchImpl,
    getTokenCounts: () => ({ propertyTokenPosts, tileTokenPosts }),
  };
}

function setCreds(all = true): void {
  if (all) {
    process.env.COTALITY_PROPERTY_KEY = TEST_CREDS.COTALITY_PROPERTY_KEY;
    process.env.COTALITY_PROPERTY_SECRET = TEST_CREDS.COTALITY_PROPERTY_SECRET;
    process.env.COTALITY_SPATIALTILE_KEY = TEST_CREDS.COTALITY_SPATIALTILE_KEY;
    process.env.COTALITY_SPATIALTILE_SECRET =
      TEST_CREDS.COTALITY_SPATIALTILE_SECRET;
  }
}

function clearCreds(): void {
  for (const k of Object.keys(TEST_CREDS)) delete process.env[k];
}

describe("Cotality parcel + zoning adapters", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of Object.keys(TEST_CREDS)) saved[k] = process.env[k];
    __resetCotalityDedupForTests();
    __resetCotalityTokenCacheForTests();
    __resetCotalityClipDedupForTests();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    __resetCotalityDedupForTests();
    __resetCotalityTokenCacheForTests();
    __resetCotalityClipDedupForTests();
  });

  it("happy path — bearer on API calls; spatial polygon + site-location zoning", async () => {
    setCreds();
    const { fetchImpl } = cotalityFetchRouter();

    const outcomes = await runAdapters({
      adapters: [cotalityParcelsAdapter, cotalityZoningAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    expect(byKey["cotality:parcels"]?.status).toBe("ok");
    expect(byKey["cotality:zoning"]?.status).toBe("ok");

    const parcelPayload = byKey["cotality:parcels"]?.result?.payload as {
      parcel: { geometry: { type: string }; properties: { clip: string } };
    };
    expect(parcelPayload?.parcel?.geometry?.type).toBe("Polygon");
    expect(parcelPayload?.parcel?.properties?.clip).toBe("9876543210");
  });

  it("token cached — second run reuses bearer", async () => {
    setCreds();
    const { fetchImpl, getTokenCounts } = cotalityFetchRouter();
    await runAdapters({
      adapters: [cotalityParcelsAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    const first = getTokenCounts();
    expect(first.propertyTokenPosts).toBe(1);
    expect(first.tileTokenPosts).toBe(1);

    __resetCotalityDedupForTests();
    __resetCotalityClipDedupForTests();

    await runAdapters({
      adapters: [cotalityParcelsAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    const second = getTokenCounts();
    expect(second.propertyTokenPosts).toBe(1);
    expect(second.tileTokenPosts).toBe(1);
  });

  it("zoning absent — parcel ok, zoning no-coverage", async () => {
    setCreds();
    const { fetchImpl } = cotalityFetchRouter({
      siteLocationBody: cotalitySiteLocationNoZoningResponse,
    });
    const outcomes = await runAdapters({
      adapters: [cotalityParcelsAdapter, cotalityZoningAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    expect(byKey["cotality:parcels"]?.status).toBe("ok");
    expect(byKey["cotality:zoning"]?.status).toBe("no-coverage");
  });

  it("missing PROPERTY creds — no-coverage, zero network", async () => {
    clearCreds();
    process.env.COTALITY_SPATIALTILE_KEY = TEST_CREDS.COTALITY_SPATIALTILE_KEY;
    process.env.COTALITY_SPATIALTILE_SECRET =
      TEST_CREDS.COTALITY_SPATIALTILE_SECRET;

    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const outcomes = await runAdapters({
      adapters: [cotalityParcelsAdapter, cotalityZoningAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    expect(outcomes.every((o) => o.status === "no-coverage")).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("registry includes cotality parcel + zoning in FEDERAL and ALL", () => {
    const all = ALL_ADAPTERS.map((a) => a.adapterKey);
    expect(all).toContain("cotality:parcels");
    expect(all).toContain("cotality:zoning");
    const fed = FEDERAL_ADAPTERS.map((a) => a.adapterKey);
    expect(fed).toContain("cotality:parcels");
    expect(fed).toContain("cotality:zoning");
  });
});
