import { describe, expect, it } from "vitest";

import { parseConsequenceInputsFromProse } from "../parse.js";
import { deriveConsequenceStrata } from "../stratum.js";

describe("parseConsequenceInputsFromProse", () => {
  it("extracts ASCE 7 risk categories", () => {
    const inputs = parseConsequenceInputsFromProse(
      "Structures assigned to Risk Category III shall comply with additional requirements.",
    );
    expect(inputs?.asce7RiskCategories).toEqual(["III"]);
    expect(inputs?.sourceSpans?.length).toBeGreaterThan(0);
  });

  it("extracts IBC occupancy groups", () => {
    const inputs = parseConsequenceInputsFromProse(
      "Occupancy Group R-2 residential buildings require automatic sprinklers.",
    );
    expect(inputs?.ibcOccupancyGroups).toEqual(["R-2"]);
  });

  it("extracts IBC importance factors", () => {
    const inputs = parseConsequenceInputsFromProse(
      "For Risk Category IV, the importance factor of 1.5 applies (Ie = 1.5).",
    );
    expect(inputs?.ibcImportanceFactors).toContain("1.5");
  });

  it("returns undefined when no classification inputs present", () => {
    expect(parseConsequenceInputsFromProse("Setback shall be 10 feet.")).toBeUndefined();
  });
});

describe("deriveConsequenceStrata", () => {
  it("derives strata without a severity scalar", () => {
    const strata = deriveConsequenceStrata({
      asce7RiskCategories: ["III"],
      ibcOccupancyGroups: ["R-2"],
      ibcImportanceFactors: ["1.25"],
    });
    expect(strata).toEqual([
      { kind: "asce7-risk-category", value: "III" },
      { kind: "ibc-occupancy-group", value: "R-2" },
      { kind: "ibc-importance-factor", value: "1.25" },
    ]);
  });

  it("returns unclassified when inputs absent", () => {
    expect(deriveConsequenceStrata(undefined)).toEqual([
      { kind: "unclassified", value: "none" },
    ]);
  });
});
