/**
 * Planner + atom-construction tests for the three property-fact writers.
 */
import { describe, expect, it } from "vitest";

import {
  buildAtomsForCadParcelRollPlan,
  planCountyCadParcelRoll,
  verifyStoredCadParcelRollAtom,
  type CadCountyRunProvenance,
} from "../cad-parcel-roll/index.js";
import {
  buildAtomsForLandUseFactPlan,
  planCountyLandUseFacts,
  verifyStoredLandUseFactAtom,
  type LandUseCountyRunProvenance,
} from "../land-use-fact/index.js";
import {
  buildAtomsForOwnerFactPlan,
  planCountyOwnerFacts,
  verifyStoredOwnerFactAtom,
  type OwnerCountyRunProvenance,
} from "../owner-fact/index.js";
import {
  buildAtomsForFloodHazardPlan,
  filterZonesByBBox,
  planCountyFloodHazard,
  pointInGeoJson,
  verifyStoredFloodHazardFactAtom,
  type FloodCountyRunProvenance,
  type FloodZoneFeature,
} from "../flood-hazard-fact/index.js";

const CAD_PROV: CadCountyRunProvenance = {
  sourceAdapter: "cad-property-ingest-v1",
  sourceCitation: "test CAD roll",
  sourceUrl: "https://example.test/cad",
  observedAt: "2026-08-09T12:00:00.000Z",
  jurisdictionTenant: "tx_48021",
  verificationStatus: "machine",
};

const LU_PROV: LandUseCountyRunProvenance = {
  ...CAD_PROV,
  sourceCitation: "test land use",
};

const OWN_PROV: OwnerCountyRunProvenance = {
  ...CAD_PROV,
  sourceAdapter: "cad-property-owner-v1",
  sourceCitation: "test owner",
};

const FH_PROV: FloodCountyRunProvenance = {
  sourceAdapter: "fema-nfhl-bulk-v1",
  sourceCitation: "FEMA NFHL test",
  sourceUrl: "https://hazards.fema.gov/",
  observedAt: "2026-08-09T12:00:00.000Z",
  jurisdictionTenant: "tx_48261",
  verificationStatus: "machine",
};

describe("planCountyCadParcelRoll", () => {
  it("emits present atoms from cad_property for non-HOLD counties", () => {
    const plan = planCountyCadParcelRoll(
      [
        {
          countyFips: "48021",
          propId: "27303",
          taxYear: 2026,
          sourceFile: "bastrop.txt",
          sourceVintage: "2026-01-15",
          ownerName: "EXAMPLE LLC",
          situsAddress: "714 Spring St",
          marketValue: 300000,
          propertyUseCode: "A1",
        },
      ],
      { countyFips: "48021" },
    );
    expect(plan.hold).toBe(false);
    expect(plan.counts.present).toBe(1);
    const atoms = buildAtomsForCadParcelRollPlan(plan, CAD_PROV);
    expect(atoms[0]!.entityId).toBe("48021:27303:2026");
    expect(atoms[0]!.ownerName).toBe("EXAMPLE LLC");
    const verdict = verifyStoredCadParcelRollAtom(atoms[0], {
      parcelNodeId: "48021:27303",
      taxYear: 2026,
      outcome: "present",
    });
    expect(verdict).toEqual({ ok: true });
  });

  it("emits join-hold absences for CROSSWALK_HOLD counties (Travis)", () => {
    const plan = planCountyCadParcelRoll(
      [
        {
          countyFips: "48453",
          propId: "0207310401",
          taxYear: 2026,
          sourceFile: "travis.txt",
          sourceVintage: "2026-01-15",
          ownerName: "SHOULD WITHHOLD",
          marketValue: 1,
        },
      ],
      { countyFips: "48453" },
    );
    expect(plan.hold).toBe(true);
    expect(plan.counts.absentByKind["join-hold"]).toBe(1);
    const [atom] = buildAtomsForCadParcelRollPlan(plan, {
      ...CAD_PROV,
      jurisdictionTenant: "tx_48453",
    });
    expect(atom!.absence?.kind).toBe("join-hold");
    expect(atom!.ownerName).toBeUndefined();
    // normalizeForJoin strips leading zeros on all-digit prop ids
    expect(atom!.entityId).toBe("48453:207310401:2026");
    expect(atom!.parcelNodeId).toBe("48453:207310401");
  });

  it("rejects stored bodies that embed geometry", () => {
    const bad = {
      entityType: "cad-parcel-roll",
      atomDid: "cadroll_aaaaaaaaaaaaaaaa",
      parcelNodeId: "48021:1",
      taxYear: 2026,
      countyFips: "48021",
      propId: "1",
      keyKind: "prop_id",
      joinPassedOwnerMatchGate: false,
      reasoningChain: { reasoningKind: "observed" },
      sourceTier: "cad-authoritative",
      geometry: { type: "Point", coordinates: [0, 0] },
      sourceFile: "x.txt",
      situsAddress: "x",
      accessPolicy: "public-free",
      sourceCitation: "x",
      extractedAt: "2026-08-09T12:00:00.000Z",
      verificationStatus: "machine",
      sourceAdapter: "x",
      evaluatedAt: "2026-08-09T12:00:00.000Z",
      atomTier: "data",
    };
    const verdict = verifyStoredCadParcelRollAtom(bad, {
      parcelNodeId: "48021:1",
      taxYear: 2026,
      outcome: "present",
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problem).toMatch(/geometry/);
  });
});

describe("planCountyLandUseFacts", () => {
  it("joins parcels to cad via normalizeForJoin", () => {
    const plan = planCountyLandUseFacts(
      [{ parcelKey: "00027303" }, { parcelKey: "99999" }],
      [
        {
          propId: "27303",
          taxYear: 2026,
          propertyUseCode: "A1",
          sourceVintage: "2026-01-15",
        },
      ],
      { countyFips: "48021", taxYear: 2026 },
    );
    expect(plan.counts.present).toBe(1);
    expect(plan.counts.absentByKind["no-cad-row"]).toBe(1);
    const atoms = buildAtomsForLandUseFactPlan(plan, LU_PROV);
    const present = atoms.find((a) => a.landUseCode === "A1");
    expect(present!.parcelNodeId).toBe("48021:27303");
    expect(present!.entityId).toBe("48021:27303:2026");
    expect(
      verifyStoredLandUseFactAtom(present, {
        parcelNodeId: "48021:27303",
        taxYear: 2026,
        outcome: "present",
      }),
    ).toEqual({ ok: true });
  });

  it("HOLD counties emit join-hold; blank use emits no-land-use-code", () => {
    const hold = planCountyLandUseFacts(
      [{ parcelKey: "100" }],
      [{ propId: "100", taxYear: 2026, propertyUseCode: "A1" }],
      { countyFips: "48209", taxYear: 2026 },
    );
    expect(hold.hold).toBe(true);
    expect(hold.counts.absentByKind["join-hold"]).toBe(1);

    const blank = planCountyLandUseFacts(
      [{ parcelKey: "100" }],
      [{ propId: "100", taxYear: 2026, propertyUseCode: "  " }],
      { countyFips: "48021", taxYear: 2026 },
    );
    expect(blank.counts.absentByKind["no-land-use-code"]).toBe(1);
  });
});

describe("planCountyOwnerFacts", () => {
  it("joins parcels to cad via normalizeForJoin and tags the atom public-paid", () => {
    const plan = planCountyOwnerFacts(
      [{ parcelKey: "00027303" }, { parcelKey: "99999" }],
      [
        {
          propId: "27303",
          taxYear: 2026,
          ownerName: "SAMPLE OWNER LLC",
          ownerMailingAddress: "PO BOX 1234, BASTROP, TX 78602",
          exemptionCodes: ["HS"],
          sourceVintage: "2026-01-15",
        },
      ],
      { countyFips: "48021", taxYear: 2026 },
    );
    expect(plan.counts.present).toBe(1);
    expect(plan.counts.absentByKind["no-cad-row"]).toBe(1);
    expect(plan.counts.withMailingAddress).toBe(1);

    const atoms = buildAtomsForOwnerFactPlan(plan, OWN_PROV);
    const present = atoms.find((a) => a.ownerName === "SAMPLE OWNER LLC");
    expect(present!.parcelNodeId).toBe("48021:27303");
    expect(present!.entityId).toBe("48021:27303:2026");
    expect(present!.accessPolicy).toBe("public-paid");
    expect(
      verifyStoredOwnerFactAtom(present, {
        parcelNodeId: "48021:27303",
        taxYear: 2026,
        outcome: "present",
      }),
    ).toEqual({ ok: true });
  });

  it("reduces exemption codes to flags — no raw code reaches the atom", () => {
    const plan = planCountyOwnerFacts(
      [{ parcelKey: "27303" }],
      [
        {
          propId: "27303",
          taxYear: 2026,
          ownerName: "SAMPLE OWNER LLC",
          ownerMailingAddress: null,
          exemptionCodes: ["HS", "OV65"],
        },
      ],
      { countyFips: "48021", taxYear: 2026 },
    );
    const [atom] = buildAtomsForOwnerFactPlan(plan, OWN_PROV);
    expect(atom.exemptionFlags).toEqual({
      homestead: true,
      seniorOrDisability: true,
      agricultural: false,
      veteran: false,
    });
    expect(JSON.stringify(atom)).not.toContain("OV65");
  });

  it("HOLD counties emit join-hold; blank owner emits no-owner-name", () => {
    const hold = planCountyOwnerFacts(
      [{ parcelKey: "100" }],
      [
        {
          propId: "100",
          taxYear: 2026,
          ownerName: "SOMEONE",
          ownerMailingAddress: null,
          exemptionCodes: null,
        },
      ],
      { countyFips: "48209", taxYear: 2026 },
    );
    expect(hold.hold).toBe(true);
    expect(hold.counts.absentByKind["join-hold"]).toBe(1);

    const blank = planCountyOwnerFacts(
      [{ parcelKey: "100" }],
      [
        {
          propId: "100",
          taxYear: 2026,
          ownerName: "   ",
          ownerMailingAddress: null,
          exemptionCodes: null,
        },
      ],
      { countyFips: "48021", taxYear: 2026 },
    );
    expect(blank.counts.absentByKind["no-owner-name"]).toBe(1);
  });

  it("promotes a PUBLISHED suppression key to owner-withheld, never inferring it", () => {
    const rows = [
      {
        propId: "100",
        taxYear: 2026,
        ownerName: "REDACTED BY DISTRICT",
        ownerMailingAddress: null,
        exemptionCodes: null,
      },
    ];
    // Without the list: we make the weaker true claim (the name is present).
    const inferred = planCountyOwnerFacts([{ parcelKey: "100" }], rows, {
      countyFips: "48021",
      taxYear: 2026,
    });
    expect(inferred.counts.present).toBe(1);
    expect(inferred.counts.absentByKind["owner-withheld"]).toBe(0);

    // With the district's published list: an ESTABLISHED absence.
    const declared = planCountyOwnerFacts([{ parcelKey: "100" }], rows, {
      countyFips: "48021",
      taxYear: 2026,
      withheldKeys: new Set(["100"]),
    });
    expect(declared.counts.absentByKind["owner-withheld"]).toBe(1);
    const [atom] = buildAtomsForOwnerFactPlan(declared, OWN_PROV);
    expect(atom.absence?.kind).toBe("owner-withheld");
    expect(atom.ownerName).toBeUndefined();
    // An absence still reveals that we looked — it stays paid.
    expect(atom.accessPolicy).toBe("public-paid");
  });

  it("a mailing address never survives without an owner name", () => {
    const plan = planCountyOwnerFacts(
      [{ parcelKey: "100" }],
      [
        {
          propId: "100",
          taxYear: 2026,
          ownerName: null,
          ownerMailingAddress: "PO BOX 9, BASTROP, TX 78602",
          exemptionCodes: null,
        },
      ],
      { countyFips: "48021", taxYear: 2026 },
    );
    const [atom] = buildAtomsForOwnerFactPlan(plan, OWN_PROV);
    expect(atom.absence?.kind).toBe("no-owner-name");
    expect(atom.ownerMailingAddress).toBeUndefined();
    expect(JSON.stringify(atom)).not.toContain("PO BOX 9");
  });

  it("verify REJECTS a stored atom mutated onto the free tier", () => {
    const plan = planCountyOwnerFacts(
      [{ parcelKey: "27303" }],
      [
        {
          propId: "27303",
          taxYear: 2026,
          ownerName: "SAMPLE OWNER LLC",
          ownerMailingAddress: null,
          exemptionCodes: null,
        },
      ],
      { countyFips: "48021", taxYear: 2026 },
    );
    const [atom] = buildAtomsForOwnerFactPlan(plan, OWN_PROV);
    const tampered = { ...atom, accessPolicy: "public-free" };
    const verdict = verifyStoredOwnerFactAtom(tampered, {
      parcelNodeId: "48021:27303",
      taxYear: 2026,
      outcome: "present",
    });
    expect(verdict.ok).toBe(false);
  });

  it("dedupes parcels sharing a normalized account key", () => {
    const plan = planCountyOwnerFacts(
      [{ parcelKey: "00027303" }, { parcelKey: "27303" }],
      [
        {
          propId: "27303",
          taxYear: 2026,
          ownerName: "SAMPLE OWNER LLC",
          ownerMailingAddress: null,
          exemptionCodes: null,
        },
      ],
      { countyFips: "48021", taxYear: 2026 },
    );
    expect(plan.planned.length).toBe(1);
  });
});

describe("planCountyFloodHazard", () => {
  const square: FloodZoneFeature = {
    zoneRowId: "48261C:1",
    fldZone: "AE",
    zoneSubty: null,
    sfhaTf: "T",
    staticBfe: 12,
    westLng: -98,
    southLat: 26,
    eastLng: -97,
    northLat: 27,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-98, 26],
          [-97, 26],
          [-97, 27],
          [-98, 27],
          [-98, 26],
        ],
      ],
    },
    sourceVintage: "2026-01-01",
  };

  it("treats empty zone index as typed absence", () => {
    const plan = planCountyFloodHazard(
      [{ parcelKey: "15271", centroid: [-97.5, 26.5] }],
      [],
      { countyFips: "48261" },
    );
    expect(plan.emptyZoneIndex).toBe(true);
    expect(plan.counts.absent).toBe(1);
    const [atom] = buildAtomsForFloodHazardPlan(plan, FH_PROV);
    expect(atom!.absence?.kind).toBe("no-flood-coverage");
    expect(atom!.entityId).toBe("48261:15271");
    expect(
      verifyStoredFloodHazardFactAtom(atom, {
        parcelNodeId: "48261:15271",
        outcome: "absent",
      }),
    ).toEqual({ ok: true });
  });

  it("outside zones is present inSFHA=false", () => {
    expect(pointInGeoJson(-96, 26.5, square.geometry)).toBe(false);
    const plan = planCountyFloodHazard(
      [{ parcelKey: "1", centroid: [-96, 26.5] }],
      [square],
      { countyFips: "48261" },
    );
    expect(plan.counts.presentOutside).toBe(1);
    const [atom] = buildAtomsForFloodHazardPlan(plan, FH_PROV);
    expect(atom!.inSpecialFloodHazardArea).toBe(false);
    expect(atom!.floodZone).toBeNull();
  });

  it("hits SFHA zone as present inSFHA=true", () => {
    const plan = planCountyFloodHazard(
      [{ parcelKey: "2", centroid: [-97.5, 26.5] }],
      [square],
      { countyFips: "48261" },
    );
    expect(plan.counts.presentInSfha).toBe(1);
    const [atom] = buildAtomsForFloodHazardPlan(plan, FH_PROV);
    expect(atom!.inSpecialFloodHazardArea).toBe(true);
    expect(atom!.floodZone).toBe("AE");
  });

  it("bbox-filters zones (Kenedy-friendly)", () => {
    const far: FloodZoneFeature = {
      ...square,
      zoneRowId: "far",
      westLng: -100,
      eastLng: -99.5,
      southLat: 30,
      northLat: 31,
    };
    const filtered = filterZonesByBBox([square, far], {
      westLng: -98.1,
      southLat: 25.9,
      eastLng: -96.9,
      northLat: 27.1,
    });
    expect(filtered.map((z) => z.zoneRowId)).toEqual(["48261C:1"]);
  });
});
