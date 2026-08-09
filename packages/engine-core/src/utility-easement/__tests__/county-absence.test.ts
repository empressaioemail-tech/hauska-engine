import { describe, expect, it } from "vitest";

import { planCountyEasementHonestAbsence } from "../county-absence.js";
import { BASTROP_COUNTY_EASEMENT_PROVENANCE_SCOPE } from "../constants.js";

describe("planCountyEasementHonestAbsence", () => {
  it("emits exactly one county-coverage row for Bastrop county scope", () => {
    const result = planCountyEasementHonestAbsence({ countyFips: "48021" });
    expect(result.atomsWouldWrite).toBe(1);
    expect(result.countyCoverage.outcome).toBe("county-coverage-absence");
    expect(result.countyCoverage.provenanceScope).toEqual(
      BASTROP_COUNTY_EASEMENT_PROVENANCE_SCOPE,
    );
  });

  it("rejects non-honest-absence counties", () => {
    expect(() =>
      planCountyEasementHonestAbsence({ countyFips: "48309" }),
    ).toThrow(/cad-easement-rest/);
  });
});
