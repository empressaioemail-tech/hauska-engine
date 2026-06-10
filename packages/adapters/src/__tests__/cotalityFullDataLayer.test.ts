/**
 * Cotality full data-layer pack — extended adapters (Phases 1-3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cotalityPropertyAdapter,
  cotalityClimateAdapter,
  cotalityHazardsAdapter,
  cotalityReplacementCostAdapter,
  cotalityMineralAdapter,
  cotalityUtilityAdapter,
  extractClimateForcingFields,
} from "../national/cotalityExtended";
import {
  __resetCotalityClipDedupForTests,
  __resetCotalityTokenCacheForTests,
} from "../national/cotalityClient";
import { runAdapters } from "../runner";
import { FEDERAL_ADAPTERS } from "../registry";
import {
  ROUND_ROCK,
  cotalityAvmSummaryResponse,
  cotalityCommercialRcvResponse,
  cotalityCraAr6Response,
  cotalityFloodRiskScoreResponse,
  cotalityGeocodeSearchResponse,
  cotalityInlandFloodCatModelResponse,
  cotalityOAuthTokenResponse,
  cotalityPropertyDetailResponse,
  cotalityResidentialRcvResponse,
  cotalityRiskMeterClimateResponse,
  cotalitySiteLocationResponse,
  cotalitySpatialOgResponse,
  cotalitySpatialParcelsResponse,
  cotalitySpatialUtResponse,
  cotalityTransactionHistoryResponse,
  cotalityWildfireRiskResponse,
} from "../__fixtures__/cotalityFixtures";

const ALL_CREDS = {
  COTALITY_PROPERTY_KEY: "prop-key",
  COTALITY_PROPERTY_SECRET: "prop-secret",
  COTALITY_SPATIALTILE_KEY: "tile-key",
  COTALITY_SPATIALTILE_SECRET: "tile-secret",
  COTALITY_RISKMETER_KEY: "risk-key",
  COTALITY_RISKMETER_SECRET: "risk-secret",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bearerForBody(body: string): string {
  if (body.includes("prop-key")) return "property-token";
  if (body.includes("tile-key")) return "tile-token";
  if (body.includes("risk-key")) return "risk-token";
  return "token";
}

function fullPackFetchRouter() {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/oauth/token")) {
      const body = init?.body?.toString() ?? "";
      expect(body).toContain("scope=openid");
      return jsonResponse({
        ...cotalityOAuthTokenResponse,
        access_token: bearerForBody(body),
      });
    }

    const auth = (init?.headers as Record<string, string> | undefined)
      ?.Authorization;

    if (url.includes("/search/geocode")) {
      expect(auth).toBe("Bearer property-token");
      return jsonResponse(cotalityGeocodeSearchResponse);
    }
    if (url.includes("/property-detail")) {
      return jsonResponse(cotalityPropertyDetailResponse);
    }
    if (url.includes("/avm/")) {
      return jsonResponse(cotalityAvmSummaryResponse);
    }
    if (url.includes("/transaction-history")) {
      return jsonResponse(cotalityTransactionHistoryResponse);
    }
    if (url.includes("/site-location")) {
      return jsonResponse(cotalitySiteLocationResponse);
    }
    if (url.includes("/climate-risk-analytics/")) {
      return jsonResponse(cotalityCraAr6Response);
    }
    if (url.includes("/spatial-tile/parcels/SpatialRecordOG")) {
      expect(auth).toBe("Bearer tile-token");
      return jsonResponse(cotalitySpatialOgResponse);
    }
    if (url.includes("/spatial-tile/parcels/SpatialRecordUT")) {
      expect(auth).toBe("Bearer tile-token");
      return jsonResponse(cotalitySpatialUtResponse);
    }
    if (url.includes("/spatial-tile/parcels")) {
      expect(auth).toBe("Bearer tile-token");
      return jsonResponse(cotalitySpatialParcelsResponse);
    }

    if (url.includes("/riskmeter-api/")) {
      expect(auth).toBe("Bearer risk-token");
      if (url.includes("/climate-risk")) {
        return jsonResponse(cotalityRiskMeterClimateResponse);
      }
      if (url.includes("/us-inland-flood-cat-model")) {
        return jsonResponse(cotalityInlandFloodCatModelResponse);
      }
      if (url.includes("/flood-risk-score")) {
        return jsonResponse(cotalityFloodRiskScoreResponse);
      }
      if (url.includes("/wildfire-risk")) {
        return jsonResponse(cotalityWildfireRiskResponse);
      }
      if (url.includes("/residential-replacement-cost")) {
        return jsonResponse(cotalityResidentialRcvResponse);
      }
      if (url.includes("/commercial-replacement-cost")) {
        return jsonResponse(cotalityCommercialRcvResponse);
      }
      return jsonResponse({ score: 50 });
    }

    return new Response(`unexpected: ${url}`, { status: 404 });
  });
  return fetchImpl;
}

function setAllCreds(): void {
  for (const [k, v] of Object.entries(ALL_CREDS)) process.env[k] = v;
}

function clearAllCreds(): void {
  for (const k of Object.keys(ALL_CREDS)) delete process.env[k];
}

describe("Cotality full data-layer pack", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of Object.keys(ALL_CREDS)) saved[k] = process.env[k];
    __resetCotalityTokenCacheForTests();
    __resetCotalityClipDedupForTests();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    __resetCotalityTokenCacheForTests();
    __resetCotalityClipDedupForTests();
  });

  it("cotality:property — detail + avm + transaction history", async () => {
    setAllCreds();
    const fetchImpl = fullPackFetchRouter();
    const [outcome] = await runAdapters({
      adapters: [cotalityPropertyAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    expect(outcome?.status).toBe("ok");
    const payload = outcome?.result?.payload as Record<string, unknown>;
    expect(payload?.kind).toBe("cotality-property");
    expect(payload?.clip).toBe("9876543210");
    expect(payload?.cotalityDemoApp).toBe("property");
    expect(payload?.propertyDetail).toBeTruthy();
  });

  it("cotality:climate — CRA + RiskMeter with flood depth forcing fields", async () => {
    setAllCreds();
    const fetchImpl = fullPackFetchRouter();
    const [outcome] = await runAdapters({
      adapters: [cotalityClimateAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    expect(outcome?.status).toBe("ok");
    const payload = outcome?.result?.payload as Record<string, unknown>;
    expect(payload?.kind).toBe("cotality-climate");
    expect(payload?.floodDepthAtReturnPeriod).toBeTruthy();
    const forcing = extractClimateForcingFields(payload);
    expect(
      Object.keys(forcing.floodDepthAtReturnPeriod).length,
    ).toBeGreaterThan(0);
  });

  it("cotality:hazards — multi-peril RiskMeter bundle", async () => {
    setAllCreds();
    const fetchImpl = fullPackFetchRouter();
    const [outcome] = await runAdapters({
      adapters: [cotalityHazardsAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    expect(outcome?.status).toBe("ok");
    const payload = outcome?.result?.payload as {
      perils: Record<string, unknown>;
      floodDepthAtReturnPeriod: Record<string, unknown>;
    };
    expect(payload?.perils?.floodRiskScore).toBeTruthy();
    expect(payload?.floodDepthAtReturnPeriod?.estimatedFloodDepth_100yr).toBe(
      0.8,
    );
  });

  it("cotality:replacementcost — residential RCV", async () => {
    setAllCreds();
    const fetchImpl = fullPackFetchRouter();
    const [outcome] = await runAdapters({
      adapters: [cotalityReplacementCostAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    expect(outcome?.status).toBe("ok");
    const payload = outcome?.result?.payload as Record<string, unknown>;
    expect(payload?.residentialReplacementCost).toBeTruthy();
  });

  it("cotality:mineral — SpatialRecord O&G with reconciliation note", async () => {
    setAllCreds();
    const fetchImpl = fullPackFetchRouter();
    const [outcome] = await runAdapters({
      adapters: [cotalityMineralAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    expect(outcome?.status).toBe("ok");
    const payload = outcome?.result?.payload as Record<string, unknown>;
    expect(payload?.reconciliationNote).toMatch(/separate existing O&G app/i);
  });

  it("cotality:utility — SpatialRecord UT infrastructure", async () => {
    setAllCreds();
    const fetchImpl = fullPackFetchRouter();
    const [outcome] = await runAdapters({
      adapters: [cotalityUtilityAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    expect(outcome?.status).toBe("ok");
    expect(outcome?.result?.payload?.kind).toBe("cotality-utility");
  });

  it("missing creds — clean no-coverage, zero network", async () => {
    clearAllCreds();
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const outcomes = await runAdapters({
      adapters: [cotalityPropertyAdapter, cotalityClimateAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    expect(outcomes.every((o) => o.status === "no-coverage")).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("all extended adapters registered in FEDERAL_ADAPTERS", () => {
    const keys = FEDERAL_ADAPTERS.map((a) => a.adapterKey);
    expect(keys).toContain("cotality:property");
    expect(keys).toContain("cotality:climate");
    expect(keys).toContain("cotality:hazards");
    expect(keys).toContain("cotality:replacementcost");
    expect(keys).toContain("cotality:mineral");
    expect(keys).toContain("cotality:utility");
  });
});
