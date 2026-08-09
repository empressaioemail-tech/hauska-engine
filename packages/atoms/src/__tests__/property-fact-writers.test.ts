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
} from "../fact-writer-ids.js";
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
