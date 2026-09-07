/**
 * item 18 -- floodplain acreage + FIRM panel citation. Mocked NFHL upstream
 * (no live network in unit tests), same pattern as
 * `site-plan/__tests__/discharge-point.test.ts`.
 *
 * The "real Bastrop parcel" fixtures below are not invented: they replay the
 * exact live responses captured 2026-09-07 querying
 * https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28
 * and /3 with parcel 48021:52726's real ring (1007 Water St, Bastrop, TX --
 * `CALC_ACRE` 0.064 on the Bastrop CAD parcel layer). Both real Bastrop
 * parcels checked (52726, 52727) came back identical: two intersecting
 * Zone X polygons (neither SFHA), one FIRM panel 48021C0355F effective
 * 2023-05-09 -- a genuine, live-verified "present, zero SFHA acreage" case,
 * which is exactly the case a whole-parcel boolean flag would get wrong by
 * reporting no flood exposure at all.
 */
import { describe, expect, it } from "vitest";

import { resolveFloodplainFact } from "../resolve-floodplain-acreage.js";
import type { Ring } from "../geo.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** The real parcel 48021:52726 ring, Bastrop CAD `Parcels_One_Click` layer, live 2026-09-07. */
const BASTROP_52726_RING: Ring = [
  [-97.3184093073769, 30.1114271504666],
  [-97.318674287706, 30.1114258161708],
  [-97.3186743572861, 30.111441661512],
  [-97.3186748649868, 30.1115567774232],
  [-97.3184091669594, 30.111560378826],
  [-97.3184093073769, 30.1114271504666],
];

/** A synthetic 100-acre AE (SFHA) zone that fully contains a small synthetic parcel. */
const SFHA_TEST_PARCEL: Ring = [
  [-97.0, 30.0],
  [-97.0001, 30.0],
  [-97.0001, 30.0001],
  [-97.0, 30.0001],
  [-97.0, 30.0],
];
const SFHA_ZONE_RING = [
  [-98.0, 29.0],
  [-96.0, 29.0],
  [-96.0, 31.0],
  [-98.0, 31.0],
  [-98.0, 29.0],
];

function realBastropZonesResponse() {
  return {
    features: [
      {
        attributes: {
          FLD_ZONE: "X",
          ZONE_SUBTY: "AREA OF MINIMAL FLOOD HAZARD",
          SFHA_TF: "F",
          STATIC_BFE: -9999.0,
          DFIRM_ID: "48021C",
        },
        geometry: { rings: [[[-98.0, 29.0], [-96.0, 29.0], [-96.0, 31.0], [-98.0, 31.0], [-98.0, 29.0]]] },
      },
      {
        attributes: {
          FLD_ZONE: "X",
          ZONE_SUBTY: "0.2 PCT ANNUAL CHANCE FLOOD HAZARD",
          SFHA_TF: "F",
          STATIC_BFE: -9999.0,
          DFIRM_ID: "48021C",
        },
        geometry: {
          rings: [
            [
              [-97.319, 30.111],
              [-97.318, 30.111],
              [-97.318, 30.112],
              [-97.319, 30.112],
              [-97.319, 30.111],
            ],
          ],
        },
      },
    ],
  };
}

function realBastropFirmPanelResponse() {
  return {
    features: [
      {
        attributes: {
          DFIRM_ID: "48021C",
          FIRM_PAN: "48021C0355F",
          PANEL: "0355",
          SUFFIX: "F",
          EFF_DATE: 1683590400000,
          PANEL_TYP: "Countywide, Panel Printed",
          SOURCE_CIT: "48021C_STUDY5",
        },
      },
    ],
  };
}

function routedFetch(byPath: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("/MapServer/28/query")) return jsonResponse(byPath["28"]);
    if (url.includes("/MapServer/3/query")) return jsonResponse(byPath["3"]);
    throw new Error(`unexpected NFHL URL in test: ${url}`);
  }) as unknown as typeof fetch;
}

describe("resolveFloodplainFact", () => {
  it("real Bastrop replay: present with zero SFHA acreage, never a fabricated whole-parcel flag", async () => {
    const fetchImpl = routedFetch({ "28": realBastropZonesResponse(), "3": realBastropFirmPanelResponse() });
    const result = await resolveFloodplainFact(BASTROP_52726_RING, fetchImpl);

    expect(result.acreage.status).toBe("present");
    if (result.acreage.status === "present") {
      expect(result.acreage.facts.sfhaAcres).toBe(0);
      expect(result.acreage.facts.zones).toHaveLength(2);
      expect(result.acreage.facts.zones.every((z) => z.sfhaTf === false)).toBe(true);
      // The parcel does sit in the 0.2%-annual-chance shaded-X zone -- present in the
      // zone list even though it does not count toward sfhaAcres.
      expect(result.acreage.facts.zones.some((z) => z.zoneSubty?.includes("0.2 PCT"))).toBe(true);
    }

    expect(result.firmPanel.status).toBe("present");
    if (result.firmPanel.status === "present") {
      expect(result.firmPanel.panels[0]!.firmPan).toBe("48021C0355F");
      expect(result.firmPanel.panels[0]!.effectiveDate).toBe("2023-05-09");
    }
  });

  it("present with real positive SFHA acreage when a parcel intersects an AE zone", async () => {
    const fetchImpl = routedFetch({
      "28": {
        features: [
          {
            attributes: { FLD_ZONE: "AE", ZONE_SUBTY: null, SFHA_TF: "T", STATIC_BFE: 512.3, DFIRM_ID: "48021C" },
            geometry: { rings: [SFHA_ZONE_RING] },
          },
        ],
      },
      "3": realBastropFirmPanelResponse(),
    });
    const result = await resolveFloodplainFact(SFHA_TEST_PARCEL, fetchImpl);

    expect(result.acreage.status).toBe("present");
    if (result.acreage.status === "present") {
      // The synthetic parcel is fully inside the synthetic AE zone, so SFHA
      // acreage should equal the parcel's own acreage (within float tolerance).
      expect(result.acreage.facts.sfhaAcres).toBeGreaterThan(0);
      expect(result.acreage.facts.sfhaAcres).toBeCloseTo(result.acreage.facts.parcelAcres, 1);
      expect(result.acreage.facts.zones[0]!.sfhaTf).toBe(true);
    }
  });

  it("honest absence, never a fabricated acreage, when the NFHL zone lookup fails", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/MapServer/28/query")) throw new Error("network unreachable");
      return jsonResponse(realBastropFirmPanelResponse());
    }) as unknown as typeof fetch;

    const result = await resolveFloodplainFact(BASTROP_52726_RING, fetchImpl);
    expect(result.acreage.status).toBe("absent");
    if (result.acreage.status === "absent") {
      expect(result.acreage.reason).toContain("network unreachable");
    }
    // The panel lookup is independent and must not be dragged down by the zone failure.
    expect(result.firmPanel.status).toBe("present");
  });

  it("honest absence for the panel citation when NFHL layer 3 returns no intersecting panel, acreage unaffected", async () => {
    const fetchImpl = routedFetch({ "28": realBastropZonesResponse(), "3": { features: [] } });
    const result = await resolveFloodplainFact(BASTROP_52726_RING, fetchImpl);

    expect(result.firmPanel.status).toBe("absent");
    if (result.firmPanel.status === "absent") {
      expect(result.firmPanel.reason).toContain("no panel intersecting");
    }
    expect(result.acreage.status).toBe("present");
  });

  it("honest absence, never a fabricated panel, when the FIRM panel lookup itself fails", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/MapServer/3/query")) throw new Error("ECONNRESET");
      return jsonResponse(realBastropZonesResponse());
    }) as unknown as typeof fetch;

    const result = await resolveFloodplainFact(BASTROP_52726_RING, fetchImpl);
    expect(result.firmPanel.status).toBe("absent");
    if (result.firmPanel.status === "absent") {
      expect(result.firmPanel.reason).toContain("ECONNRESET");
    }
    expect(result.acreage.status).toBe("present");
  });
});
