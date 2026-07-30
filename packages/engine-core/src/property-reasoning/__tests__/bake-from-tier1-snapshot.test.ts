import { describe, expect, it } from "vitest";

import { emitFromTier1Snapshot } from "../bake-from-tier1-snapshot.js";

/** Minimal GIS provenance so district-present fixtures pass A1 M0 guard. */
function gisProv(opts: {
  sourceUrl: string;
  codeField: string;
  cityKey: string;
  layerName?: string;
}) {
  return {
    sourceUrl: opts.sourceUrl,
    codeField: opts.codeField,
    cityKey: opts.cityKey,
    layerName: opts.layerName ?? "Zoning",
    stampedAt: "2026-07-24T20:00:00.000Z",
  };
}

describe("emitFromTier1Snapshot setback via cityKey (WDLL 3.4–3.6)", () => {
  it("emits setback-RULE + envelope DERIVED for austin-tx SF-3", () => {
    const result = emitFromTier1Snapshot(
      "48453:TEST-AUSTIN-SF3",
      {
        bakedAt: "2026-07-24T20:00:00.000Z",
        baseFacts: { situsCity: "Austin" },
        zoning: {
          district: "SF-3",
          jurisdictionKey: "austin-tx",
          provenance: gisProv({
            sourceUrl: "https://example.test/austin-zoning",
            codeField: "ZONING_Z",
            cityKey: "austin-tx",
          }),
        },
        envelope: { status: "declined", declineReason: "atom_path_pending" } as {
          status: string;
        },
      },
      "48453",
    );
    expect(result.zoningPresent).toBe(true);
    expect(result.setbackPresent).toBe(true);
    expect(result.envelopePresent).toBe(true);
    expect(result.notes).toEqual(
      expect.arrayContaining(["zoning", "setback", "envelope"]),
    );
    const setback = result.atoms.find((a) => a.entityType === "setback-rule");
    expect(setback).toMatchObject({
      entityType: "setback-rule",
      front: 25,
      side: 5,
      rear: 10,
      sourceCodeAtomRef: {
        role: "rule",
        entityType: "code-section",
      },
    });
    const envelope = result.atoms.find(
      (a) => a.entityType === "buildable-envelope",
    );
    expect(envelope).toMatchObject({
      entityType: "buildable-envelope",
      reasoningChain: { reasoningKind: "derived" },
      outcome: { kind: "provisional-front-edge" },
    });
  });

  it("emits setback-RULE for san-antonio-tx R-6", () => {
    const result = emitFromTier1Snapshot(
      "48029:TEST-SA-R6",
      {
        bakedAt: "2026-07-24T20:00:00.000Z",
        zoning: {
          district: "R-6",
          jurisdictionKey: "san_antonio_tx",
          provenance: gisProv({
            sourceUrl: "https://example.test/sa-zoning",
            codeField: "Base",
            cityKey: "san-antonio-tx",
          }),
        },
      },
      "48029",
    );
    expect(result.setbackPresent).toBe(true);
    const setback = result.atoms.find((a) => a.entityType === "setback-rule");
    expect(setback).toMatchObject({
      entityType: "setback-rule",
      sourceCodeAtomRef: { role: "rule" },
    });
  });

  it("honest-absence when jurisdiction has no setback table", () => {
    const result = emitFromTier1Snapshot(
      "48187:TEST-SEGUIN",
      {
        bakedAt: "2026-07-24T20:00:00.000Z",
        zoning: {
          district: "R-1",
          jurisdictionKey: "seguin-tx",
          provenance: gisProv({
            sourceUrl: "https://example.test/seguin-zoning",
            codeField: "ZONE",
            cityKey: "seguin-tx",
          }),
        },
      },
      "48187",
    );
    expect(result.zoningPresent).toBe(true);
    expect(result.setbackPresent).toBe(false);
    expect(result.notes).toContain("setback-table-missing:seguin-tx");
  });

  it("honest-absence when no jurisdictionKey on multi-city parcel", () => {
    const result = emitFromTier1Snapshot(
      "48453:TEST-NO-KEY",
      {
        bakedAt: "2026-07-24T20:00:00.000Z",
        zoning: {
          district: "SF-3",
          provenance: gisProv({
            sourceUrl: "https://example.test/travis-unknown",
            codeField: "ZONING_Z",
            cityKey: "austin-tx",
          }),
        },
      },
      "48453",
    );
    expect(result.zoningPresent).toBe(true);
    expect(result.setbackPresent).toBe(false);
    expect(result.notes).toContain("setback-omitted-no-jurisdiction-key");
  });

  it("Bastrop SF-1 routes to bastrop-development-code; ordinance 30/10/20/30", () => {
    const result = emitFromTier1Snapshot(
      "48021:105054",
      {
        bakedAt: "2026-07-29T20:00:00.000Z",
        baseFacts: { situsCity: "Bastrop" },
        zoning: {
          district: "SF-1",
          jurisdictionKey: "bastrop-tx",
          provenance: gisProv({
            sourceUrl:
              "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Zoned_Parcels/FeatureServer/83",
            codeField: "ZoneType",
            cityKey: "bastrop-city-tx",
            layerName: "Zoned_Parcels",
          }),
        },
        envelope: { status: "ok", buildableAreaSqFt: 10000 },
      },
      "48021",
    );
    expect(result.setbackPresent).toBe(true);
    const setback = result.atoms.find((a) => a.entityType === "setback-rule") as {
      front?: number;
      side?: number;
      rear?: number;
    };
    expect(setback?.front).toBe(30);
    expect(setback?.side).toBe(10);
    expect(setback?.rear).toBe(30);
  });

  it("Bastrop repealed P-3 honest-declines setback (does not serve B3 as current)", () => {
    const result = emitFromTier1Snapshot(
      "48021:141209",
      {
        bakedAt: "2026-07-29T20:00:00.000Z",
        baseFacts: { situsCity: "Bastrop" },
        zoning: {
          district: "P-3",
          jurisdictionKey: "bastrop-tx",
          provenance: gisProv({
            sourceUrl:
              "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Zoning_Place_Type/FeatureServer/0",
            codeField: "PlaceTypeClass",
            cityKey: "bastrop-city-tx",
            layerName: "Zoning_Place_Type",
          }),
        },
        envelope: { status: "no-buildable-area", buildableAreaSqFt: 0 },
      },
      "48021",
    );
    expect(result.setbackPresent).toBe(false);
    const zoning = result.atoms.find((a) => a.entityType === "zoning-fact") as {
      sourceAdapter?: string;
      sourceUrl?: string;
    };
    expect(zoning?.sourceAdapter).toBe("txgio-zoning-stamp:bastrop-city-tx");
    expect(zoning?.sourceUrl).toContain("Zoning_Place_Type");
  });
});
