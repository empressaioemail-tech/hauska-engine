/**
 * item 19 — named downstream discharge point. Mocked county-hydrography
 * upstream (no live network in unit tests), same pattern as
 * `packages/adapters/src/hydrography/__tests__/county-hydrography.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { createCountyHydrographyDischargeResolver } from "../discharge-point.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A real Bastrop coordinate, ~40m from the mocked Piney Creek line below. */
const BASTROP_EXIT_POINT = { lat: 30.1269, lng: -97.3305 };

/** Moab, UT — no county hydrography source configured for this bbox. */
const NO_SOURCE_EXIT_POINT = { lat: 38.57, lng: -109.55 };

function creeksResponse(): unknown {
  return {
    features: [
      {
        attributes: { GNIS_Name: "Piney Creek", FEATURE_TY: "STREAM/RIVER" },
        geometry: {
          paths: [
            [
              [-97.3298, 30.1269],
              [-97.33, 30.1265],
            ],
          ],
        },
      },
      {
        // Unnamed feature (blank GNIS_Name on the live layer) — must never
        // be reported as the discharge point's name even if it's closer.
        attributes: { GNIS_Name: " ", FEATURE_TY: "ARTIFICIAL PATH" },
        geometry: {
          paths: [
            [
              [-97.3305, 30.1269],
              [-97.3306, 30.127],
            ],
          ],
        },
      },
    ],
  };
}

describe("createCountyHydrographyDischargeResolver", () => {
  it("resolves the real nearest NAMED feature, never the closer unnamed one", async () => {
    const fetchImpl = (async () => jsonResponse(creeksResponse())) as unknown as typeof fetch;
    const resolver = createCountyHydrographyDischargeResolver(fetchImpl);
    const result = await resolver.resolve(BASTROP_EXIT_POINT);
    expect(result.status).toBe("present");
    if (result.status === "present") {
      expect(result.point.name).toBe("Piney Creek");
      expect(result.point.featureType).toBe("STREAM/RIVER");
      expect(result.point.distanceMeters).toBeGreaterThan(0);
      expect(result.point.distanceMeters).toBeLessThan(3000);
      expect(result.point.sourceUrl).toContain("Creeks_Streams");
    }
  });

  it("honest absence when no county hydrography source is registered for this point", async () => {
    const fetchImpl = (async () => jsonResponse(creeksResponse())) as unknown as typeof fetch;
    const resolver = createCountyHydrographyDischargeResolver(fetchImpl);
    const result = await resolver.resolve(NO_SOURCE_EXIT_POINT);
    expect(result.status).toBe("absent");
    if (result.status === "absent") {
      expect(result.reason).toContain("No county hydrography source registered");
    }
  });

  it("honest absence, never a fabricated name, when the upstream lookup fails", async () => {
    const fetchImpl = (async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;
    const resolver = createCountyHydrographyDischargeResolver(fetchImpl);
    const result = await resolver.resolve(BASTROP_EXIT_POINT);
    expect(result.status).toBe("absent");
    if (result.status === "absent") {
      expect(result.reason).toContain("network unreachable");
    }
  });

  it("honest absence when the layer has features but none are named", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        features: [
          {
            attributes: { GNIS_Name: "", FEATURE_TY: "ARTIFICIAL PATH" },
            geometry: { paths: [[[-97.3305, 30.1269], [-97.3306, 30.127]]] },
          },
        ],
      })) as unknown as typeof fetch;
    const resolver = createCountyHydrographyDischargeResolver(fetchImpl);
    const result = await resolver.resolve(BASTROP_EXIT_POINT);
    expect(result.status).toBe("absent");
    if (result.status === "absent") {
      expect(result.reason).toContain("No named waterway found");
    }
  });
});
