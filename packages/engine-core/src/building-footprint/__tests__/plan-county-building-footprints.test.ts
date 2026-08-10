/**
 * County planner + atom builder tests for building-footprint writer.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { BUILDING_FOOTPRINT_SCHEMA } from "@hauska-engine/atoms";

import {
  buildAtomsForBuildingFootprintPlan,
  loadMlFootprintsForBbox,
  planCountyBuildingFootprints,
  resolveFootprintRoute,
} from "../index.js";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "__fixtures__",
);

const PARCEL_RING = [
  [-97.326, 30.106],
  [-97.326, 30.107],
  [-97.325, 30.107],
  [-97.325, 30.106],
  [-97.326, 30.106],
] as const;

describe("resolveFootprintRoute", () => {
  it("defaults every county to ml-global-building-footprints", () => {
    const route = resolveFootprintRoute();
    expect(route.adapterKind).toBe("ml-global-building-footprints");
    expect(route.sourceTier).toBe("ml-derived");
  });

  it("routes honest-absence without county branching", () => {
    const route = resolveFootprintRoute({
      footprintAdapterKind: "honest-absence",
    });
    expect(route.sourceTier).toBe("absent");
  });
});

describe("planCountyBuildingFootprints", () => {
  it("emits county-coverage absence when ML bbox is empty (never zero rows)", () => {
    const plan = planCountyBuildingFootprints(
      [{ parcelKey: "27303", ring: [...PARCEL_RING] }],
      [],
      { countyFips: "48021" },
    );
    expect(plan.mlEmptyBbox).toBe(true);
    expect(plan.planned).toHaveLength(1);
    expect(plan.planned[0]?.outcome).toBe("county-coverage-absent");
    expect(plan.counts.countyCoverageAbsent).toBe(1);
  });

  it("joins inline ML footprints and emits per-parcel absence for empty parcels", () => {
    const insideRing = [
      [-97.3255, 30.1064],
      [-97.3253, 30.1064],
      [-97.3253, 30.1066],
      [-97.3255, 30.1066],
      [-97.3255, 30.1064],
    ] as const;

    const plan = planCountyBuildingFootprints(
      [
        { parcelKey: "31362", ring: [...PARCEL_RING] },
        { parcelKey: "99999", ring: [...PARCEL_RING] },
      ],
      [
        { footprintId: "ml-fixture-1", ring: [...insideRing] },
        {
          footprintId: "ml-fixture-orphan",
          ring: [
            [-97.33, 30.11],
            [-97.3298, 30.11],
            [-97.3298, 30.1102],
            [-97.33, 30.1102],
            [-97.33, 30.11],
          ],
        },
      ],
      { countyFips: "48021" },
    );

    expect(plan.counts.present).toBeGreaterThanOrEqual(1);
    expect(plan.counts.absentPerParcel).toBeGreaterThanOrEqual(1);
    expect(plan.joinStats.orphanRejected).toBeGreaterThanOrEqual(1);
  });
});

describe("buildAtomsForBuildingFootprintPlan", () => {
  it("builds contract-valid atoms with public-free ml-derived accessPolicy", async () => {
    const bbox = {
      westLng: -97.33,
      southLat: 30.105,
      eastLng: -97.325,
      northLat: 30.108,
    };
    const ml = await loadMlFootprintsForBbox({
      bbox,
      fixturePath: join(FIXTURE_DIR, "jonesHigginsMlFootprints.json"),
    });
    const plan = planCountyBuildingFootprints(
      [{ parcelKey: "31362", ring: [...PARCEL_RING] }],
      ml.features,
      { countyFips: "48021" },
    );
    const atoms = buildAtomsForBuildingFootprintPlan(plan, {
      sourceAdapter: "ml-global-building-footprints-v1",
      sourceCitation:
        "Microsoft Building Footprints (ODC-By 1.0) via ml-global-building-footprints-v1",
      sourceUrl:
        "https://minedbuildings.z5.web.core.windows.net/legacy/usbuildings-v2/Texas.geojson.zip",
      sourceVintage: "GlobalMLBuildingFootprints-Texas",
      observedAt: "2026-08-09T12:00:00.000Z",
      jurisdictionTenant: "tx_48021",
      verificationStatus: "machine",
    });

    expect(atoms.length).toBeGreaterThan(0);
    for (const atom of atoms) {
      expect(BUILDING_FOOTPRINT_SCHEMA.safeParse(atom).success).toBe(true);
      expect(atom.accessPolicy).toBe("public-free");
      expect(atom.entityId).toMatch(/^48021:\d+:footprint:/);
    }
  });
});
