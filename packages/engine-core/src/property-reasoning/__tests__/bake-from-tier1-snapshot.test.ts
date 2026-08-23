import { describe, expect, it } from "vitest";

import {
  descriptorForCounty,
  emitFromTier1Snapshot,
} from "../bake-from-tier1-snapshot.js";

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
  it("emits setback-RULE for pflugerville-tx SF-S (Travis gold table)", () => {
    const result = emitFromTier1Snapshot(
      "48453:TEST-PFLUGERVILLE-SFS",
      {
        bakedAt: "2026-07-24T20:00:00.000Z",
        zoning: {
          district: "SF-S",
          jurisdictionKey: "pflugerville-tx",
          provenance: gisProv({
            sourceUrl: "https://example.test/pflugerville-zoning",
            codeField: "ZONING",
            cityKey: "pflugerville-tx",
          }),
        },
      },
      "48453",
    );
    expect(result.setbackPresent).toBe(true);
    const setback = result.atoms.find((a) => a.entityType === "setback-rule");
    expect(setback).toMatchObject({ front: 25, side: 7.5, rear: 20 });
  });

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

  it("emits full atom chain for elgin-tx R-1 (STEP 2 Option A)", () => {
    const result = emitFromTier1Snapshot(
      "48021:TEST-ELGIN-R1",
      {
        bakedAt: "2026-08-04T00:00:00.000Z",
        baseFacts: { situsCity: "Elgin" },
        zoning: {
          district: "R-1",
          jurisdictionKey: "elgin-tx",
          provenance: gisProv({
            sourceUrl:
              "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Elgin_Zoning/FeatureServer/0",
            codeField: "Zone_Code",
            cityKey: "elgin-tx",
            layerName: "Elgin_Zoning",
          }),
        },
        envelope: { status: "declined", declineReason: "atom_path_pending" } as {
          status: string;
        },
      },
      "48021",
    );
    expect(result.zoningPresent).toBe(true);
    expect(result.setbackPresent).toBe(true);
    expect(result.envelopePresent).toBe(true);
    expect(result.notes).toEqual(
      expect.arrayContaining(["zoning", "setback", "envelope"]),
    );
    expect(result.notes).not.toContain("setback-table-missing:elgin-tx");

    const zoning = result.atoms.find((a) => a.entityType === "zoning-fact") as {
      district?: string;
      sourceCodeAtomRef?: { atomDid: string };
      codeSectionRefs?: {
        districtRequirements: { atomDid: string };
        permittedUseTable: { atomDid: string };
      };
    };
    expect(zoning?.district).toBe("R-1");
    expect(zoning?.sourceCodeAtomRef).toMatchObject({
      atomDid:
        "did:hauska:code-section:elgin_tx/elgin-code-of-ordinances-current-supplement/46-233",
    });
    expect(zoning?.codeSectionRefs).toMatchObject({
      districtRequirements: {
        atomDid:
          "did:hauska:code-section:elgin_tx/elgin-code-of-ordinances-current-supplement/46-233",
      },
      permittedUseTable: {
        atomDid:
          "did:hauska:code-section:elgin_tx/elgin-code-of-ordinances-current-supplement/46-231",
      },
    });
    expect(zoning?.sourceCodeAtomRef?.atomDid).not.toContain("bastrop_tx");

    const setback = result.atoms.find((a) => a.entityType === "setback-rule");
    expect(setback).toMatchObject({
      entityType: "setback-rule",
      front: 25,
      side: 7.5,
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

  it("R13: Bastrop city breadth-bake OMITS setback (per-parcel layer-23 record only)", () => {
    // AMENDMENT 2 R1 + R13: Bastrop city setback NUMBERS come only from the
    // per-parcel layer-23 record. A tier1 breadth-bake must NOT synthesize the
    // repealed/ordinance-chart scalar (30/10/20/30) — it omits setback so the
    // warm path fetches layer 23.
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
    expect(result.setbackPresent).toBe(false);
    expect(
      result.atoms.find((a) => a.entityType === "setback-rule"),
    ).toBeUndefined();
    expect(
      result.notes.some((n) => n.includes("requires-per-parcel-record")),
    ).toBe(true);
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

describe("descriptorForCounty — district-code-section-map key resolution (48021 fix)", () => {
  it("resolves 48021 (Bastrop) to jurisdiction key bastrop_tx, not the generic breadth_ key", () => {
    const descriptor = descriptorForCounty("48021:TEST-001", "Bastrop", "48021");
    expect(descriptor.key).toBe("bastrop_tx");
    // jurisdictionTenant is unaffected — cascade SQL LIKE 'breadth_48021_%' and
    // the road-intake emitters key off this field, not descriptor.key.
    expect(descriptor.jurisdictionTenant).toBe("breadth_48021_bastrop");
  });

  it("falls back to breadth_${fips} for an unmapped county (byte-identical to pre-fix)", () => {
    const descriptor = descriptorForCounty("48029:TEST-001", "San Antonio", "48029");
    expect(descriptor.key).toBe("breadth_48029");
  });

  it("resolves Elgin city hint on 48021 to elgin_tx, not bastrop_tx county default", () => {
    expect(descriptorForCounty("48021:TEST-ELGIN", "elgin-tx", "48021").key).toBe(
      "elgin_tx",
    );
  });

  it("keeps Bastrop city hint on 48021 on bastrop_tx county default", () => {
    expect(
      descriptorForCounty("48021:TEST-BASTROP", "bastrop-city-tx", "48021").key,
    ).toBe("bastrop_tx");
  });
});

describe("emitFromTier1Snapshot — bake path mints district code-section refs (48021 fix)", () => {
  it("Bastrop district parcel (SF-1) carries sourceCodeAtomRef + codeSectionRefs via the bake path", () => {
    const result = emitFromTier1Snapshot(
      "48021:TEST-REFS-1",
      {
        bakedAt: "2026-08-03T00:00:00.000Z",
        baseFacts: { situsCity: "Bastrop" },
        zoning: {
          district: "SF-1",
          jurisdictionKey: "bastrop-tx",
          provenance: gisProv({
            sourceUrl:
              "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Zoning_Place_Type/FeatureServer/0",
            codeField: "PlaceTypeClass",
            cityKey: "bastrop-city-tx",
            layerName: "Zoning_Place_Type",
          }),
        },
      },
      "48021",
    );
    const zoning = result.atoms.find((a) => a.entityType === "zoning-fact") as {
      sourceCodeAtomRef?: { atomDid: string };
      codeSectionRefs?: {
        districtRequirements: { atomDid: string };
        permittedUseTable: { atomDid: string };
      };
    };
    expect(zoning?.sourceCodeAtomRef).toMatchObject({
      atomDid: "did:hauska:code-section:bastrop_tx-bdc-2026-adopted/14-02-003",
    });
    expect(zoning?.codeSectionRefs).toMatchObject({
      districtRequirements: {
        atomDid: "did:hauska:code-section:bastrop_tx-bdc-2026-adopted/14-02-003",
      },
      permittedUseTable: {
        atomDid: "did:hauska:code-section:bastrop_tx-bdc-2026-adopted/14-02-008",
      },
    });
  });

  it("unmapped county (San Antonio, 48029) emits with no code-section refs — byte-identical to pre-fix behavior", () => {
    const result = emitFromTier1Snapshot(
      "48029:TEST-REFS-2",
      {
        bakedAt: "2026-08-03T00:00:00.000Z",
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
    const zoning = result.atoms.find((a) => a.entityType === "zoning-fact") as {
      sourceCodeAtomRef?: unknown;
      codeSectionRefs?: unknown;
    };
    expect(zoning?.sourceCodeAtomRef).toBeUndefined();
    expect(zoning?.codeSectionRefs).toBeUndefined();
  });
});
