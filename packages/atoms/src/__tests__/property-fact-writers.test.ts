/**
 * Seam tests for the three 1.14.0 property-fact writers.
 */
import { describe, expect, it } from "vitest";

import {
  CROSSWALK_HOLD_FIPS,
  LANDUSE_JOIN_HOLD_FIPS,
  cadParcelRollAtomDid,
  floodHazardFactAtomDid,
  isUsablePropId,
  landUseFactAtomDid,
  normalizeForJoin,
  ownerFactAtomDid,
} from "../fact-writer-ids.js";
import {
  buildCountyOwnerCoverageAbsenceAtom,
  buildOwnerFactAbsenceAtom,
  buildPresentOwnerFactAtom,
  deriveExemptionFlags,
  ownerFactClaimContentHash,
} from "../owner-fact-writer.js";
import {
  buildCadParcelRollAbsenceAtom,
  buildCountyCadRollCoverageAbsenceAtom,
  buildPresentCadParcelRollAtom,
  cadParcelRollClaimContentHash,
  type PropertyFactWriteProvenance,
} from "../cad-parcel-roll-writer.js";
import {
  buildLandUseFactAbsenceAtom,
  buildPresentLandUseFactAtom,
} from "../land-use-fact-writer.js";
import {
  buildCountyFloodHazardCoverageAbsenceAtom,
  buildFloodHazardFactAbsenceAtom,
  buildPresentFloodHazardFactAtom,
} from "../flood-hazard-fact-writer.js";
import {
  buildPresentRailCorridorFactAtom,
  buildRailCorridorFactAbsenceAtom,
  railCorridorFactClaimContentHash,
} from "../rail-corridor-fact-writer.js";
import {
  buildPresentRrcPipelineFactAtom,
  buildRrcPipelineFactAbsenceAtom,
  rrcPipelineFactClaimContentHash,
} from "../rrc-pipeline-fact-writer.js";
import {
  railCorridorFactAtomDid,
  rrcPipelineFactAtomDid,
} from "../fact-writer-ids.js";
import {
  buildOutsideSourceAbsenceReason,
  buildPresentSpecialDistrictFactAtom,
  buildSpecialDistrictFactAbsenceAtom,
} from "../special-district-fact-writer.js";

const PROVENANCE: PropertyFactWriteProvenance = {
  sourceAdapter: "cad-property-ingest-v1",
  sourceCitation: "Bastrop CAD 2026 property roll",
  sourceUrl: "https://example.test/cad",
  sourceVintage: "2026-01-15",
  observedAt: "2026-08-09T12:00:00.000Z",
  jurisdictionTenant: "tx_48021",
  contentHash: "fnv1a64:deadbeefdeadbeef",
};

describe("fact-writer-ids", () => {
  it("lists the eight OPS-1 CROSSWALK_HOLD counties", () => {
    expect(CROSSWALK_HOLD_FIPS.size).toBe(8);
    expect(CROSSWALK_HOLD_FIPS.has("48453")).toBe(true);
    expect(CROSSWALK_HOLD_FIPS.has("48295")).toBe(true);
  });

  it("lists Hays + Williamson as LANDUSE_JOIN_HOLD", () => {
    expect(LANDUSE_JOIN_HOLD_FIPS).toEqual(new Set(["48209", "48491"]));
  });

  it("normalizeForJoin strips leading zeros on all-digit ids", () => {
    expect(normalizeForJoin("00027303")).toBe("27303");
    expect(normalizeForJoin("A-12")).toBe("A-12");
  });

  it("isUsablePropId rejects null / blank / all-zero", () => {
    expect(isUsablePropId(null)).toBe(false);
    expect(isUsablePropId("")).toBe(false);
    expect(isUsablePropId("0")).toBe(false);
    expect(isUsablePropId("000")).toBe(false);
    expect(isUsablePropId("27303")).toBe(true);
  });

  it("isUsablePropId rejects tokens outside parcelNodeId alphabet (Tarrant spaces)", () => {
    expect(isUsablePropId("A 101-1J03A")).toBe(false);
    expect(isUsablePropId("10-1-1A")).toBe(true);
    expect(isUsablePropId("A/101")).toBe(false);
  });

  it("mints stable prefixed DIDs", () => {
    const cad = cadParcelRollAtomDid({
      parcelNodeId: "48021:27303",
      taxYear: 2026,
    });
    expect(cad).toMatch(/^cadroll_[0-9a-f]{16}$/);
    expect(
      cadParcelRollAtomDid({ parcelNodeId: "48021:27303", taxYear: 2026 }),
    ).toBe(cad);

    const lu = landUseFactAtomDid({
      parcelNodeId: "48021:27303",
      taxYear: 2026,
    });
    expect(lu).toMatch(/^lufact_[0-9a-f]{16}$/);

    const fh = floodHazardFactAtomDid({ parcelNodeId: "48021:27303" });
    expect(fh).toMatch(/^fhfact_[0-9a-f]{16}$/);
  });
});

describe("cad-parcel-roll writer seam", () => {
  it("builds a present atom with entityId parcelNodeId:taxYear", () => {
    const atom = buildPresentCadParcelRollAtom(
      {
        countyFips: "48021",
        parcelKey: "27303",
        taxYear: 2026,
        keyKind: "prop_id",
        joinPassedOwnerMatchGate: true,
        sourceFile: "bastropcad_2026_property.txt",
        ownerName: "EXAMPLE HOLDINGS LLC",
        situsAddress: "714 Spring St",
        marketValue: 300000,
        propertyUseCode: "A1",
      },
      {
        ...PROVENANCE,
        contentHash: cadParcelRollClaimContentHash({
          parcelNodeId: "48021:27303",
          taxYear: 2026,
          sourceTier: "cad-authoritative",
          joinPassedOwnerMatchGate: true,
          sourceFile: "bastropcad_2026_property.txt",
          marketValue: 300000,
          propertyUseCode: "A1",
          situsAddress: "714 Spring St",
        }),
      },
    );

    expect(atom.entityType).toBe("cad-parcel-roll");
    expect(atom.entityId).toBe("48021:27303:2026");
    expect(atom.atomDid).toMatch(/^cadroll_[0-9a-f]{16}$/);
    expect(atom.ownerName).toBe("EXAMPLE HOLDINGS LLC");
    expect(atom.sourceTier).toBe("cad-authoritative");
  });

  it("withholds owner fields on join-hold absence", () => {
    const atom = buildCadParcelRollAbsenceAtom(
      {
        countyFips: "48453",
        parcelKey: "0207310401",
        taxYear: 2026,
        keyKind: "prop_id",
        absenceKind: "join-hold",
        reason: "CROSSWALK_HOLD — prop_id join unsafe for Travis",
        sourceFile: "travis_2026.txt",
      },
      PROVENANCE,
    );
    expect(atom.absence?.kind).toBe("join-hold");
    expect(atom.joinPassedOwnerMatchGate).toBe(false);
    expect(atom.ownerName).toBeUndefined();
    expect(atom.entityId).toBe("48453:0207310401:2026");
  });

  it("builds county verifiedAbsence with provenanceScope", () => {
    const atom = buildCountyCadRollCoverageAbsenceAtom(
      {
        countyFips: "48301",
        taxYear: 2026,
        provenanceScope: ["county-cad-bulk", "tx-comptroller-roll"],
      },
      PROVENANCE,
    );
    expect(atom.sourceTier).toBe("absent");
    expect(atom.verifiedAbsence?.evaluated).toBe(true);
    expect(atom.verifiedAbsence?.provenanceScope.length).toBeGreaterThan(0);
    expect(atom.propId).toBe("_county_coverage");
  });
});

describe("land-use-fact writer seam", () => {
  it("builds present from CAD property_use_code", () => {
    const atom = buildPresentLandUseFactAtom(
      {
        parcelNodeId: "48021:27303",
        taxYear: 2026,
        landUseCode: "A1",
      },
      PROVENANCE,
    );
    expect(atom.entityType).toBe("land-use-fact");
    expect(atom.landUseCode).toBe("A1");
    expect(atom.entityId).toBe("48021:27303:2026");
    expect(atom.atomDid).toMatch(/^lufact_[0-9a-f]{16}$/);
  });

  it("builds no-land-use-code / no-cad-row / join-hold absences", () => {
    for (const kind of [
      "no-land-use-code",
      "no-cad-row",
      "join-hold",
    ] as const) {
      const atom = buildLandUseFactAbsenceAtom(
        {
          parcelNodeId: "48021:27303",
          taxYear: 2026,
          absenceKind: kind,
          reason: `test ${kind}`,
        },
        PROVENANCE,
      );
      expect(atom.absence?.kind).toBe(kind);
      expect(atom.landUseCode).toBeUndefined();
    }
  });
});

describe("owner-fact writer seam (the paid facet)", () => {
  it("builds present from CAD owner_name, tagged public-paid", () => {
    const atom = buildPresentOwnerFactAtom(
      {
        parcelNodeId: "48021:27303",
        taxYear: 2026,
        ownerName: "SAMPLE OWNER LLC",
        ownerMailingAddress: "PO BOX 1234, BASTROP, TX 78602",
      },
      PROVENANCE,
    );
    expect(atom.entityType).toBe("owner-fact");
    expect(atom.ownerName).toBe("SAMPLE OWNER LLC");
    expect(atom.entityId).toBe("48021:27303:2026");
    expect(atom.atomDid).toMatch(/^ownfact_[0-9a-f]{16}$/);
    // The whole point of the rail: owner never ships free.
    expect(atom.accessPolicy).toBe("public-paid");
  });

  it("EVERY owner atom is public-paid, including absences", () => {
    const absence = buildOwnerFactAbsenceAtom(
      {
        parcelNodeId: "48021:27303",
        taxYear: 2026,
        absenceKind: "owner-withheld",
        reason: "statutory confidentiality election",
      },
      PROVENANCE,
    );
    const county = buildCountyOwnerCoverageAbsenceAtom(
      { countyFips: "48021", taxYear: 2026, provenanceScope: ["cad_property"] },
      PROVENANCE,
    );
    expect(absence.accessPolicy).toBe("public-paid");
    expect(county.accessPolicy).toBe("public-paid");
  });

  it("builds all four absence kinds incl. statutory owner-withheld", () => {
    for (const kind of [
      "no-owner-name",
      "owner-withheld",
      "no-cad-row",
      "join-hold",
    ] as const) {
      const atom = buildOwnerFactAbsenceAtom(
        {
          parcelNodeId: "48021:27303",
          taxYear: 2026,
          absenceKind: kind,
          reason: `test ${kind}`,
        },
        PROVENANCE,
      );
      expect(atom.absence?.kind).toBe(kind);
      expect(atom.ownerName).toBeUndefined();
      expect(atom.ownerMailingAddress).toBeUndefined();
    }
  });

  it("atomDid is stable across runs and distinct per tax year", () => {
    const a = ownerFactAtomDid({ parcelNodeId: "48021:27303", taxYear: 2026 });
    const b = ownerFactAtomDid({ parcelNodeId: "48021:27303", taxYear: 2026 });
    const c = ownerFactAtomDid({ parcelNodeId: "48021:27303", taxYear: 2025 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  describe("deriveExemptionFlags — flags, never raw codes", () => {
    it("returns undefined when the roll carries no exemption data", () => {
      expect(deriveExemptionFlags(undefined)).toBeUndefined();
      expect(deriveExemptionFlags(null)).toBeUndefined();
      expect(deriveExemptionFlags([])).toBeUndefined();
      expect(deriveExemptionFlags(["", "  "])).toBeUndefined();
    });

    it("matches known CAD variants by prefix, not exact equality", () => {
      // A false negative would assert "no homestead", which is a wrong claim.
      for (const code of ["HS", "HB", "HS1", "hs"]) {
        expect(deriveExemptionFlags([code])?.homestead).toBe(true);
      }
      for (const code of ["OV65", "O65", "DP", "DI"]) {
        expect(deriveExemptionFlags([code])?.seniorOrDisability).toBe(true);
      }
      for (const code of ["DV1", "DV4", "VET"]) {
        expect(deriveExemptionFlags([code])?.veteran).toBe(true);
      }
      for (const code of ["AG", "1D1", "OS", "TIM"]) {
        expect(deriveExemptionFlags([code])?.agricultural).toBe(true);
      }
    });

    it("reports false — not undefined — for a roll with unrelated codes", () => {
      const flags = deriveExemptionFlags(["XYZ"]);
      expect(flags).toEqual({
        homestead: false,
        seniorOrDisability: false,
        agricultural: false,
        veteran: false,
      });
    });

    it("NEVER surfaces a raw exemption code on the atom", () => {
      const atom = buildPresentOwnerFactAtom(
        {
          parcelNodeId: "48021:27303",
          taxYear: 2026,
          ownerName: "SAMPLE OWNER LLC",
          exemptionFlags: deriveExemptionFlags(["HS", "OV65"]),
        },
        PROVENANCE,
      );
      const serialized = JSON.stringify(atom);
      expect(serialized).not.toContain("OV65");
      expect(atom.exemptionFlags).toEqual({
        homestead: true,
        seniorOrDisability: true,
        agricultural: false,
        veteran: false,
      });
    });
  });

  it("content hash is claim-shaped: stable on re-run, moves on owner change", () => {
    const base = {
      parcelNodeId: "48021:27303",
      taxYear: 2026,
      sourceTier: "cad-authoritative",
      ownerName: "SAMPLE OWNER LLC",
    };
    expect(ownerFactClaimContentHash(base)).toBe(
      ownerFactClaimContentHash(base),
    );
    expect(ownerFactClaimContentHash(base)).not.toBe(
      ownerFactClaimContentHash({ ...base, ownerName: "NEW OWNER LLC" }),
    );
  });
});

describe("flood-hazard-fact writer seam", () => {
  it("builds present outside-mapped SFHA=false", () => {
    const atom = buildPresentFloodHazardFactAtom(
      {
        parcelNodeId: "48261:15271",
        inSpecialFloodHazardArea: false,
        floodZone: null,
      },
      {
        ...PROVENANCE,
        sourceAdapter: "fema-nfhl-bulk-v1",
        sourceCitation: "FEMA NFHL S_FLD_HAZ_AR 2026-01-01",
      },
    );
    expect(atom.inSpecialFloodHazardArea).toBe(false);
    expect(atom.entityId).toBe("48261:15271");
    expect(atom.atomDid).toMatch(/^fhfact_[0-9a-f]{16}$/);
    expect(atom.absence).toBeUndefined();
    expect(atom.externalKeys?.[0]?.keyValue).toBe("48261:15271");
  });

  it("canonicalizes padded StratMap parcelNodeId and keeps the pad in externalKeys (WDLL 11 C1/C3)", () => {
    const atom = buildPresentFloodHazardFactAtom(
      {
        parcelNodeId: "48021:27303.00000000",
        inSpecialFloodHazardArea: false,
        floodZone: null,
      },
      {
        ...PROVENANCE,
        sourceAdapter: "fema-nfhl-bulk-v1",
        sourceCitation: "FEMA NFHL S_FLD_HAZ_AR 2026-01-01",
      },
    );
    expect(atom.entityId).toBe("48021:27303");
    expect(atom.parcelNodeId).toBe("48021:27303");
    expect(atom.externalKeys?.[0]?.keyValue).toBe("48021:27303.00000000");
  });

  it("builds per-parcel no-flood-coverage absence", () => {
    const atom = buildFloodHazardFactAbsenceAtom(
      {
        parcelNodeId: "48261:15271",
        absenceKind: "no-flood-coverage",
        reason: "empty NFHL zone index for evaluation AOI",
      },
      PROVENANCE,
    );
    expect(atom.absence?.kind).toBe("no-flood-coverage");
    expect(atom.inSpecialFloodHazardArea).toBeUndefined();
  });

  it("builds county verifiedAbsence with provenanceScope", () => {
    const atom = buildCountyFloodHazardCoverageAbsenceAtom(
      {
        countyFips: "48261",
        provenanceScope: ["tx_fema_nfhl_flood_zone", "to_regclass"],
      },
      PROVENANCE,
    );
    expect(atom.sourceTier).toBe("absent");
    expect(atom.verifiedAbsence?.provenanceScope).toContain(
      "tx_fema_nfhl_flood_zone",
    );
  });
});

describe("rail-corridor-fact writer seam", () => {
  it("mints stable prefixed DIDs including bufferMeters", () => {
    const did = railCorridorFactAtomDid({
      parcelNodeId: "48021:27303",
      bufferMeters: 152.4,
    });
    expect(did).toMatch(/^railfact_[0-9a-f]{16}$/);
  });

  it("builds present-near with status/class and buffer in body", () => {
    const atom = buildPresentRailCorridorFactAtom(
      {
        parcelNodeId: "48021:27303",
        nearRailCorridor: true,
        corridorStatus: "active",
        corridorClass: "mainline",
        nearestCorridorDistanceMeters: 42.5,
        atGradeCrossings: [{ crossingId: "416320C", distanceMeters: 88.2 }],
      },
      {
        ...PROVENANCE,
        contentHash: railCorridorFactClaimContentHash({
          parcelNodeId: "48021:27303",
          sourceTier: "ntad-narn",
          bufferMeters: 152.4,
          nearRailCorridor: true,
          corridorStatus: "active",
          corridorClass: "mainline",
          nearestCorridorDistanceMeters: 42.5,
          atGradeCrossings: [{ crossingId: "416320C", distanceMeters: 88.2 }],
        }),
      },
    );
    expect(atom.entityType).toBe("rail-corridor-fact");
    expect(atom.bufferMeters).toBe(152.4);
    expect(atom.accessPolicy).toBe("public-free");
    expect(atom.atGradeCrossings?.[0]?.crossingId).toBe("416320C");
  });

  it("builds present-outside with nearRailCorridor false", () => {
    const atom = buildPresentRailCorridorFactAtom(
      {
        parcelNodeId: "48021:99999",
        nearRailCorridor: false,
      },
      {
        ...PROVENANCE,
        contentHash: railCorridorFactClaimContentHash({
          parcelNodeId: "48021:99999",
          sourceTier: "ntad-narn",
          bufferMeters: 152.4,
          nearRailCorridor: false,
        }),
      },
    );
    expect(atom.nearRailCorridor).toBe(false);
    expect(atom.corridorStatus).toBeUndefined();
  });

  it("builds no-parcel-geometry absence", () => {
    const atom = buildRailCorridorFactAbsenceAtom(
      {
        parcelNodeId: "48021:88888",
        absenceKind: "no-parcel-geometry",
        reason: "missing ring",
      },
      PROVENANCE,
    );
    expect(atom.absence?.kind).toBe("no-parcel-geometry");
  });
});

describe("rrc-pipeline-fact writer seam", () => {
  it("mints stable pipefact_ DIDs including bufferMeters", () => {
    const did = rrcPipelineFactAtomDid({
      parcelNodeId: "48329:1001",
      bufferMeters: 152.4,
    });
    expect(did).toMatch(/^pipefact_[0-9a-f]{16}$/);
  });

  it("builds present-near with t4permit/p5Num and buffer in body; entityId bare parcelNodeId", () => {
    const atom = buildPresentRrcPipelineFactAtom(
      {
        parcelNodeId: "48329:1001",
        nearPipeline: true,
        nearestPipelineDistanceMeters: 42.5,
        t4permit: "T4-NEAR",
        p5Num: "555",
        operatorName: "ACME PIPE",
        systemName: "Permian Main",
        commodity: "CRUDE",
      },
      {
        ...PROVENANCE,
        contentHash: rrcPipelineFactClaimContentHash({
          parcelNodeId: "48329:1001",
          sourceTier: "rrc-public-gis",
          bufferMeters: 152.4,
          nearPipeline: true,
          nearestPipelineDistanceMeters: 42.5,
          t4permit: "T4-NEAR",
          p5Num: "555",
          operatorName: "ACME PIPE",
          systemName: "Permian Main",
          commodity: "CRUDE",
        }),
      },
    );
    expect(atom.entityType).toBe("rrc-pipeline-fact");
    expect(atom.entityId).toBe("48329:1001");
    expect(atom.bufferMeters).toBe(152.4);
    expect(atom.accessPolicy).toBe("public-free");
    expect(atom.t4permit).toBe("T4-NEAR");
    expect(atom.p5Num).toBe("555");
    expect(atom.atomDid).toMatch(/^pipefact_/);
  });

  it("builds present-outside with nearPipeline false", () => {
    const atom = buildPresentRrcPipelineFactAtom(
      {
        parcelNodeId: "48329:99999",
        nearPipeline: false,
      },
      {
        ...PROVENANCE,
        contentHash: rrcPipelineFactClaimContentHash({
          parcelNodeId: "48329:99999",
          sourceTier: "rrc-public-gis",
          bufferMeters: 152.4,
          nearPipeline: false,
        }),
      },
    );
    expect(atom.nearPipeline).toBe(false);
    expect(atom.t4permit).toBeUndefined();
    expect(atom.entityId).toBe("48329:99999");
  });

  it("builds no-parcel-geometry absence", () => {
    const atom = buildRrcPipelineFactAbsenceAtom(
      {
        parcelNodeId: "48329:88888",
        absenceKind: "no-parcel-geometry",
        reason: "missing ring",
      },
      PROVENANCE,
    );
    expect(atom.absence?.kind).toBe("no-parcel-geometry");
    expect(atom.entityId).toBe("48329:88888");
  });
});

describe("special-district-fact writer seam", () => {
  it("builds present membership with point-in-polygon basis only", () => {
    const atom = buildPresentSpecialDistrictFactAtom(
      {
        parcelNodeId: "48201:12345",
        districtName: "EXAMPLE MUD",
        districtId: "999",
        districtType: "MUD",
        countyFips: "48201",
      },
      {
        ...PROVENANCE,
        sourceAdapter: "tceq-water-districts-v1",
        contentHash: "fnv1a64:test",
      },
    );
    expect(atom.membershipBasis).toBe("point-in-polygon");
    expect(atom.entityId).toBe("48201:12345:sd:999");
  });

  it("BANS statewide-negative absence phrases", () => {
    expect(() =>
      buildSpecialDistrictFactAbsenceAtom(
        {
          parcelNodeId: "48201:12345",
          absenceKind: "outside-tceq-source-boundaries",
          reason: "This parcel is in no special district anywhere.",
        },
        PROVENANCE,
      ),
    ).toThrow(/banned statewide-negative phrase/);
  });

  it("accepts scoped outside-source absence copy", () => {
    const atom = buildSpecialDistrictFactAbsenceAtom(
      {
        parcelNodeId: "48021:27303",
        absenceKind: "outside-tceq-source-boundaries",
        reason: buildOutsideSourceAbsenceReason("48021"),
      },
      PROVENANCE,
    );
    expect(atom.absence?.kind).toBe("outside-tceq-source-boundaries");
    expect(atom.entityId).toBe("48021:27303:sd");
    expect(atom.entityId.includes("outside")).toBe(false);
    expect(atom.externalKeys?.[0]?.keyValue).toBe("48021:27303");
  });
});
