/**
 * M0 — COMPLETE-BASTROP A1 / WDLL item 5.
 * Bake FAILS when district present && zoning.provenance.sourceUrl empty.
 * Cited fixture GREEN; stripped fixture RED.
 */

import { describe, expect, it } from "vitest";

import {
  assertZoningProvenancePresent,
  emitFromTier1Snapshot,
} from "../bake-from-tier1-snapshot.js";

const BASTROP_AGOL =
  "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Zoning_Place_Type/FeatureServer/0";

const bastropProvenance = {
  sourceUrl: BASTROP_AGOL,
  codeField: "PlaceTypeClass",
  cityKey: "bastrop-city-tx",
  layerName: "Zoning_Place_Type",
  stampedAt: "2026-07-27T12:00:00.000Z",
};

describe("A1 M0 zoning provenance guard", () => {
  it("RED: district present + empty provenance.sourceUrl throws", () => {
    expect(() =>
      emitFromTier1Snapshot(
        "48021:33512",
        {
          bakedAt: "2026-07-27T12:00:00.000Z",
          zoning: { district: "P-5", jurisdictionKey: "bastrop-city-tx" },
        },
        "48021",
      ),
    ).toThrow(/zoning-provenance-required/);
  });

  it("RED: assertZoningProvenancePresent rejects stripped fixture", () => {
    expect(() =>
      assertZoningProvenancePresent("P-5", {
        zoning: { district: "P-5" },
      }),
    ).toThrow(/zoning-provenance-required/);
  });

  it("GREEN: cited fixture emits GIS sourceAdapter/sourceUrl/sourceCitation", () => {
    const result = emitFromTier1Snapshot(
      "48021:33512",
      {
        bakedAt: "2026-07-27T12:00:00.000Z",
        baseFacts: { situsCity: "Bastrop" },
        zoning: {
          district: "P-5",
          jurisdictionKey: "bastrop-city-tx",
          provenance: bastropProvenance,
        },
        provenance: { zoningSource: BASTROP_AGOL },
      },
      "48021",
    );
    expect(result.zoningPresent).toBe(true);
    const z = result.atoms.find((a) => a.entityType === "zoning-fact") as {
      sourceAdapter?: string;
      sourceUrl?: string;
      sourceCitation?: string;
      district?: string;
      reasoningChain?: {
        reasoningKind?: string;
        transformSteps?: Array<{ kind?: string; adapter?: string }>;
      };
    };
    expect(z?.district).toBe("P-5");
    expect(z?.sourceAdapter).toBe("txgio-zoning-stamp:bastrop-city-tx");
    expect(z?.sourceUrl).toBe(BASTROP_AGOL);
    expect(z?.sourceCitation).toContain("PlaceTypeClass");
    expect(z?.sourceCitation).toContain("bastrop-city-tx");
    expect(z?.sourceCitation).not.toMatch(/^Breadth bake zoning from cortex/);
    expect(z?.reasoningChain?.reasoningKind).toBe("observed");
    expect(z?.reasoningChain?.transformSteps?.[0]?.kind).toBe("TRANSFORM");
    expect(z?.reasoningChain?.transformSteps?.[0]?.adapter).toBe(
      "cortex-tier1-snapshot-breadth-bake",
    );
  });

  it("GREEN: top-level provenance.zoningSource alone satisfies the guard", () => {
    const result = emitFromTier1Snapshot(
      "48021:34785",
      {
        bakedAt: "2026-07-27T12:00:00.000Z",
        zoning: {
          district: "P-5",
          jurisdictionKey: "bastrop_city_tx",
        },
        provenance: { zoningSource: BASTROP_AGOL },
      },
      "48021",
    );
    expect(result.zoningPresent).toBe(true);
    const z = result.atoms.find((a) => a.entityType === "zoning-fact") as {
      sourceUrl?: string;
    };
    expect(z?.sourceUrl).toBe(BASTROP_AGOL);
  });
});
