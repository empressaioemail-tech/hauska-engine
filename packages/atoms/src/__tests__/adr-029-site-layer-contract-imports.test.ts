/**
 * Smoke: ADR-029 site-layer atom kinds are importable from @empressaio/atom-contract@1.12.0.
 * Writers are out of scope for the contract bump lane.
 */
import { describe, expect, it } from "vitest";

import type {
  BuildingFootprintAtomInstance,
  UtilityEasementAtomInstance,
} from "@empressaio/atom-contract/property";
import {
  BUILDING_FOOTPRINT_SCHEMA,
  UTILITY_EASEMENT_SCHEMA,
  BASTROP_ML_FOOTPRINT_FIXTURE,
  BASTROP_CITY_EASEMENT_FIXTURE,
} from "@empressaio/atom-contract/property";

describe("ADR-029 contract imports (@empressaio/atom-contract >=1.12.0)", () => {
  it("imports building-footprint types and schema", () => {
    const instance: BuildingFootprintAtomInstance = BASTROP_ML_FOOTPRINT_FIXTURE;
    expect(BUILDING_FOOTPRINT_SCHEMA.safeParse(instance).success).toBe(true);
    expect(instance.entityType).toBe("building-footprint");
  });

  it("imports utility-easement types and schema", () => {
    const instance: UtilityEasementAtomInstance = BASTROP_CITY_EASEMENT_FIXTURE;
    expect(UTILITY_EASEMENT_SCHEMA.safeParse(instance).success).toBe(true);
    expect(instance.entityType).toBe("utility-easement");
  });
});
