/**
 * Planner + atom-construction tests for the three property-fact writers.
 */
import { describe, expect, it } from "vitest";

import {
  createOwnerFact,
  PARCEL_NODE_ID_PATTERN,
} from "@hauska-engine/atoms";

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


  it("Hays LANDUSE_JOIN_HOLD emits join-hold absences (not present atoms)", () => {
    const plan = planCountyCadParcelRoll(
      [
        {
          countyFips: "48209",
          propId: "R12345",
          taxYear: 2026,
          sourceFile: "hays.txt",
          sourceVintage: "2026-01-15",
          ownerName: "SHOULD WITHHOLD",
          marketValue: 250000,
          propertyUseCode: "A1",
        },
      ],
      { countyFips: "48209" },
    );
    expect(plan.hold).toBe(true);
    expect(plan.counts.present).toBe(0);
    expect(plan.counts.absentByKind["join-hold"]).toBe(1);
    const [row] = plan.planned;
    expect(row!.outcome).toBe("absent");
    if (row!.outcome === "absent") {
      expect(row.absenceKind).toBe("join-hold");
      expect(row.reason).toContain("LANDUSE_JOIN");
      expect(row.reason).not.toContain("CROSSWALK");
    }
    const atoms = buildAtomsForCadParcelRollPlan(plan, {
      ...CAD_PROV,
      jurisdictionTenant: "tx_48209",
    });
    expect(atoms).toHaveLength(1);
    expect(atoms[0]!.absence?.kind).toBe("join-hold");
    expect(atoms[0]!.ownerName).toBeUndefined();
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
  it("Tarrant-shaped space prop_id skips at plan time; land-use build does not abort", () => {
    const badKey = "A 101-1J03A";
    const goodKey = "27303";
    const plan = planCountyLandUseFacts(
      [{ parcelKey: badKey }, { parcelKey: goodKey }],
      [
        {
          propId: badKey,
          taxYear: 2026,
          propertyUseCode: "A1",
          sourceVintage: "2026-01-15",
        },
        {
          propId: goodKey,
          taxYear: 2026,
          propertyUseCode: "A1",
          sourceVintage: "2026-01-15",
        },
      ],
      { countyFips: "48439", taxYear: 2026 },
    );
    expect(plan.counts.skippedUnusableKey).toBeGreaterThanOrEqual(1);
    expect(plan.planned.some((p) => p.parcelKey.includes(" "))).toBe(false);
    expect(plan.counts.present).toBe(1);
    expect(() =>
      buildAtomsForLandUseFactPlan(plan, {
        ...LU_PROV,
        jurisdictionTenant: "tx_48439",
      }),
    ).not.toThrow();
    const atoms = buildAtomsForLandUseFactPlan(plan, {
      ...LU_PROV,
      jurisdictionTenant: "tx_48439",
    });
    expect(atoms.some((a) => a.parcelNodeId === "48439:27303")).toBe(true);
    expect(atoms.some((a) => String(a.parcelNodeId).includes(" "))).toBe(false);
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

  it("Tarrant-shaped space prop_id skips at plan time; county build does not abort", () => {
    const badKey = "A 101-1J03A";
    const goodKey = "27303";
    const plan = planCountyOwnerFacts(
      [{ parcelKey: badKey }, { parcelKey: goodKey }],
      [
        {
          propId: badKey,
          taxYear: 2026,
          ownerName: "BAD TOKEN OWNER",
          ownerMailingAddress: null,
          exemptionCodes: null,
          sourceVintage: "2026-01-15",
        },
        {
          propId: goodKey,
          taxYear: 2026,
          ownerName: "GOOD TOKEN OWNER",
          ownerMailingAddress: "PO BOX 1",
          exemptionCodes: ["HS"],
          sourceVintage: "2026-01-15",
        },
      ],
      { countyFips: "48439", taxYear: 2026 },
    );
    expect(plan.counts.skippedUnusableKey).toBeGreaterThanOrEqual(1);
    expect(plan.planned.some((p) => p.parcelKey.includes(" "))).toBe(false);
    expect(plan.counts.present).toBe(1);

    // Failure mode is row-level skip: a complete createOwnerFact payload with
    // only the illegal parcelNodeId must fail the alphabet refine — proving
    // the abort class is Zod on that row, not a missing-field throw that
    // would also satisfy a bare .toThrow().
    const illegalParcelNodeId = `48439:${badKey}`;
    expect(PARCEL_NODE_ID_PATTERN.test(illegalParcelNodeId)).toBe(false);
    expect(() =>
      createOwnerFact({
        entityType: "owner-fact",
        atomDid: "ownfact_aaaaaaaaaaaaaaaa",
        parcelNodeId: illegalParcelNodeId,
        taxYear: 2026,
        ownerName: "BAD TOKEN OWNER",
        accessPolicy: "public-paid",
        reasoningChain: { reasoningKind: "observed" },
        sourceTier: "cad-authoritative",
        sourceCitation: "test",
        extractedAt: "2026-08-09T12:00:00.000Z",
        verificationStatus: "machine",
        sourceAdapter: "test-adapter",
        evaluatedAt: "2026-08-09T12:00:00.000Z",
        atomTier: "data",
      }),
    ).toThrow(/parcelNodeId/);

    expect(() => buildAtomsForOwnerFactPlan(plan, {
      ...OWN_PROV,
      jurisdictionTenant: "tx_48439",
    })).not.toThrow();
    const atoms = buildAtomsForOwnerFactPlan(plan, {
      ...OWN_PROV,
      jurisdictionTenant: "tx_48439",
    });
    const good = atoms.find((a) => a.ownerName === "GOOD TOKEN OWNER");
    expect(good).toBeDefined();
    expect(good!.parcelNodeId).toBe("48439:27303");
    expect(atoms.some((a) => String(a.parcelNodeId).includes(" "))).toBe(false);
  });

});

describe("planCountyFloodHazard", () => {
  /**
   * A real parcel ring centred on (lng, lat). SS-W17 made
   * FloodParcelInput.geometry required, so a fixture that supplies only a
   * coordinate is exercising a path the writer can no longer take.
   */
  const parcelRing = (lng: number, lat: number, half = 0.002) => ({
    type: "Polygon",
    coordinates: [
      [
        [lng - half, lat - half],
        [lng + half, lat - half],
        [lng + half, lat + half],
        [lng - half, lat + half],
        [lng - half, lat - half],
      ],
    ],
  });

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
      [{ parcelKey: "15271", geometry: parcelRing(-97.5, 26.5) }],
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
        samplePointContainment: "contained",
      }),
    ).toEqual({ ok: true });
  });

  it("outside loaded zones fail-closes to typed absence (never Zone X by omission)", () => {
    expect(pointInGeoJson(-96, 26.5, square.geometry)).toBe(false);
    const plan = planCountyFloodHazard(
      [{ parcelKey: "1", geometry: parcelRing(-96, 26.5) }],
      [square],
      { countyFips: "48261" },
    );
    expect(plan.counts.presentOutside).toBe(0);
    expect(plan.counts.absent).toBe(1);
    expect(plan.planned[0]).toMatchObject({
      outcome: "absent",
      absenceKind: "no-flood-coverage",
    });
    const [atom] = buildAtomsForFloodHazardPlan(plan, FH_PROV);
    expect(atom!.absence?.kind).toBe("no-flood-coverage");
    expect(
      verifyStoredFloodHazardFactAtom(atom, {
        parcelNodeId: "48261:1",
        outcome: "absent",
        samplePointContainment: "contained",
      }),
    ).toEqual({ ok: true });
  });

  it("hits SFHA zone as present inSFHA=true", () => {
    const plan = planCountyFloodHazard(
      [{ parcelKey: "2", geometry: parcelRing(-97.5, 26.5) }],
      [square],
      { countyFips: "48261" },
    );
    expect(plan.counts.presentInSfha).toBe(1);
    const [atom] = buildAtomsForFloodHazardPlan(plan, FH_PROV);
    expect(atom!.inSpecialFloodHazardArea).toBe(true);
    expect(atom!.floodZone).toBe("AE");
    expect(atom!.samplePointContainment).toBe("contained");
    expect(atom!.samplePointDerivation).toBe("ring-centroid");
    expect(atom!.samplePoint).not.toBeNull();
  });

  it("REJECTS a stored atom that carries no containment stamp at all", () => {
    const plan = planCountyFloodHazard(
      [{ parcelKey: "2", geometry: parcelRing(-97.5, 26.5) }],
      [square],
      { countyFips: "48261" },
    );
    const [atom] = buildAtomsForFloodHazardPlan(plan, FH_PROV);
    const unstamped = { ...atom } as Record<string, unknown>;
    delete unstamped.samplePointContainment;
    const verdict = verifyStoredFloodHazardFactAtom(unstamped, {
      parcelNodeId: "48261:2",
      outcome: "present",
    });
    expect(verdict.ok).toBe(false);
    expect((verdict as { problem: string }).problem).toMatch(
      /no samplePointContainment/,
    );
  });

  it("REJECTS a stored atom whose containment stamp says not-contained", () => {
    const plan = planCountyFloodHazard(
      [{ parcelKey: "2", geometry: parcelRing(-97.5, 26.5) }],
      [square],
      { countyFips: "48261" },
    );
    const [atom] = buildAtomsForFloodHazardPlan(plan, FH_PROV);
    const tampered = { ...atom, samplePointContainment: "not-contained" };
    const verdict = verifyStoredFloodHazardFactAtom(tampered, {
      parcelNodeId: "48261:2",
      outcome: "present",
    });
    expect(verdict.ok).toBe(false);
    expect((verdict as { problem: string }).problem).toMatch(
      /reached the store/,
    );
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
