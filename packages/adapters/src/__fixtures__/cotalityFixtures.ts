/**
 * Recorded Cotality API response fixtures for unit tests.
 * Shapes are defensive/minimal — adapters tolerate upstream field drift.
 */

import type { AdapterContext } from "../types";

export const ROUND_ROCK_CLIP = "9876543210";
export const ROUND_ROCK_LAT = 30.5083;
export const ROUND_ROCK_LNG = -97.6789;
export const ROUND_ROCK_ADDRESS = "1904 Heathwood Cir, Round Rock, TX 78664";

export const ROUND_ROCK: AdapterContext = {
  parcel: {
    latitude: ROUND_ROCK_LAT,
    longitude: ROUND_ROCK_LNG,
    address: ROUND_ROCK_ADDRESS,
  },
  jurisdiction: { stateKey: "texas", localKey: null },
};

export const cotalityOAuthTokenResponse = {
  access_token: "test-bearer-token",
  expires_in: 3600,
  token_type: "Bearer",
};

export const cotalityGeocodeSearchResponse = {
  items: [
    {
      clip: ROUND_ROCK_CLIP,
      latitude: ROUND_ROCK_LAT,
      longitude: ROUND_ROCK_LNG,
      county: "Williamson",
    },
  ],
};

export const cotalitySpatialParcelsResponse = {
  parcels: [
    {
      clip: ROUND_ROCK_CLIP,
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-97.6791, 30.5081],
            [-97.6787, 30.5081],
            [-97.6787, 30.5085],
            [-97.6791, 30.5085],
            [-97.6791, 30.5081],
          ],
        ],
      },
    },
  ],
};

export const cotalitySiteLocationResponse = {
  coordinatesParcel: { type: "Point", coordinates: [-97.6789, 30.5083] },
  landUseAndZoningCodes: {
    zoningCode: "R-1",
    zoningDescription: "Single-Family Residential",
    landUseCode: "1100",
  },
  lot: { acres: 0.22, squareFeet: 9580 },
  vintage: "2026-03-15",
};

export const cotalitySiteLocationNoZoningResponse = {
  coordinatesParcel: { type: "Point", coordinates: [-97.6789, 30.5083] },
  landUseAndZoningCodes: {},
};

export const cotalityPropertyDetailResponse = {
  clip: ROUND_ROCK_CLIP,
  ownership: { ownerName: "Test Owner LLC" },
  lastMarketSale: { saleDate: "2019-06-15", salePrice: 425000 },
  taxAssessment: { assessedValue: 380000, taxYear: 2025 },
  buildings: [{ yearBuilt: 2004, livingArea: 2400 }],
  vintage: "2026-03-15",
};

export const cotalityAvmSummaryResponse = {
  estimatedValue: 445000,
  confidenceScore: 82,
  model: "thvConsumers",
};

export const cotalityTransactionHistoryResponse = {
  transactions: [
    { saleDate: "2019-06-15", salePrice: 425000, saleType: "arms-length" },
  ],
};

export const cotalityCraAr6Response = {
  clip: ROUND_ROCK_CLIP,
  perils: {
    extremePrecipitation: {
      current: { aalRatio: 0.012, riskScore: 42 },
      "2030": { SSP2_4_5: { aalRatio: 0.018, riskScore: 51 } },
    },
    inlandFlood: {
      current: { aalRatio: 0.008, riskScore: 38, aep100: 0.01 },
    },
  },
  horizons: ["current", "2030", "2040", "2050"],
};

export const cotalityRiskMeterClimateResponse = {
  clip: ROUND_ROCK_CLIP,
  FLXX: { score: 45, aal: 0.009 },
  STTH: { score: 52 },
};

export const cotalityInlandFloodCatModelResponse = {
  EstimatedFloodDepth_50: 0.3,
  EstimatedFloodDepth_100: 0.8,
  EstimatedFloodDepth_250: 1.2,
  EstimatedFloodDepth_500: 1.8,
  WaterSurfaceElev: 512.4,
  GroundElev: 510.6,
  HUC12: "120702050401",
};

export const cotalityFloodRiskScoreResponse = { score: 62, rating: "Moderate" };
export const cotalityWildfireRiskResponse = { score: 18, rating: "Low" };
export const cotalityResidentialRcvResponse = { replacementCostValue: 485000 };
export const cotalityCommercialRcvResponse = { replacementCostValue: null };

export const cotalitySpatialOgResponse = {
  parcels: [
    {
      clip: ROUND_ROCK_CLIP,
      wells: [{ apiNumber: "42-491-12345", status: "active" }],
      leases: [{ lessee: "Example Operator LLC" }],
    },
  ],
};

export const cotalitySpatialUtResponse = {
  parcels: [
    {
      clip: ROUND_ROCK_CLIP,
      utilities: {
        electric: [{ provider: "Example Co-op" }],
        water: [{ provider: "City of Round Rock" }],
      },
    },
  ],
};
