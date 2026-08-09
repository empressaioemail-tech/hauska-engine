import { describe, expect, it } from "vitest";

import {
  buildAtomsForUtilityEasementPlan,
  planCountyUtilityEasement,
} from "../index.js";
import { easementIntersectsParcelRing } from "../geo.js";

const PARCEL_RING: Array<[number, number]> = [
  [-97.32, 30.11],
  [-97.319, 30.11],
  [-97.319, 30.109],
  [-97.32, 30.109],
  [-97.32, 30.11],
];

describe("planCountyUtilityEasement", () => {
  it("honest-absence county emits one county-coverage planned row (48021)", () => {
    const plan = planCountyUtilityEasement({ countyFips: "48021" });
    expect(plan.route.adapterKind).toBe("honest-absence");
    expect(plan.planned).toHaveLength(1);
    expect(plan.planned[0]?.outcome).toBe("county-coverage-absence");
    expect(plan.counts.countyCoverageAbsence).toBe(1);
    expect(plan.counts.present).toBe(0);
  });

  it("builds contract-valid county-coverage atom with verifiedAbsence", () => {
    const plan = planCountyUtilityEasement({ countyFips: "48021" });
    const atoms = buildAtomsForUtilityEasementPlan(plan, {
      sourceAdapter: "honest-absence-v1",
      sourceCitation: "probe",
      sourceUrl: "provenanceScope",
      observedAt: "2026-08-09T12:00:00.000Z",
      jurisdictionTenant: "tx_48021",
      verificationStatus: "machine",
    });
    expect(atoms).toHaveLength(1);
    const atom = atoms[0]!;
    expect(atom.sourceTier).toBe("absent");
    expect(atom.verifiedAbsence?.evaluated).toBe(true);
    expect(atom.verifiedAbsence?.provenanceScope.length).toBeGreaterThan(0);
    expect(atom.easementGeometry).toBeUndefined();
    expect(atom.accessPolicy).toBe("public-free");
    expect(atom.parcelNodeId).toBe("48021:_county_coverage");
  });

  it("cad-easement-rest joins present + per-parcel absence without fake geometry", () => {
    const easementGeometry = {
      type: "LineString" as const,
      coordinates: [
        [-97.3195, 30.1095],
        [-97.3197, 30.1097],
      ] as Array<[number, number]>,
    };
    expect(
      easementIntersectsParcelRing(easementGeometry, PARCEL_RING, 10),
    ).toBe(true);

    const plan = planCountyUtilityEasement({
      countyFips: "48309",
      parcels: [
        { parcelKey: "1001", ring: PARCEL_RING },
        { parcelKey: "2002", ring: [[0, 0], [0, 0.001], [0.001, 0.001], [0.001, 0], [0, 0]] },
      ],
      easements: [
        {
          easementId: "9:42",
          geometry: easementGeometry,
          status: "UTILITY",
          docNum: null,
        },
      ],
    });

    expect(plan.route.adapterKind).toBe("cad-easement-rest");
    expect(plan.counts.present).toBe(1);
    expect(plan.counts.perParcelAbsence).toBe(1);
    expect(plan.planned.some((p) => p.outcome === "present")).toBe(true);
    expect(plan.planned.some((p) => p.outcome === "per-parcel-absence")).toBe(
      true,
    );
  });

  it("municipal scope joins city-limit parcels only", () => {
    const easementGeometry = {
      type: "Polygon" as const,
      coordinates: [
        [
          [-97.3195, 30.1095],
          [-97.3193, 30.1095],
          [-97.3193, 30.1097],
          [-97.3195, 30.1097],
          [-97.3195, 30.1095],
        ],
      ],
    };
    const plan = planCountyUtilityEasement({
      countyFips: "48021",
      scope: "city-limits",
      parcels: [
        { parcelKey: "27303", ring: PARCEL_RING, inCityLimits: true },
        { parcelKey: "99999", ring: PARCEL_RING, inCityLimits: false },
      ],
      easements: [
        {
          easementId: "Easements_/43:1287",
          geometry: easementGeometry,
          status: "UTILITY",
          docNum: null,
        },
      ],
    });
    expect(plan.route.adapterKind).toBe("municipal-easement-rest");
    expect(plan.counts.present).toBe(1);
    expect(plan.counts.perParcelAbsence).toBe(0);
  });
});
