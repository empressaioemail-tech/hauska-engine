import { describe, it, expect } from "vitest";

import { RECIPE_VERSION, DEPTH_WARM_PROMOTION_MARKER } from "../types.js";

// A3 (OPS-4): every promoted atom must carry the recipe version it was warmed
// under — the rewarm trigger. The performance ledger compares a jurisdiction's
// atoms' recipeVersion against current RECIPE_VERSION to know what needs
// rewarming after a recipe improvement.
describe("recipe version (the rewarm trigger)", () => {
  it("RECIPE_VERSION is a semver string, distinct from the promotion marker", () => {
    expect(typeof RECIPE_VERSION).toBe("string");
    expect(RECIPE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    // The promotion marker ("came from a warm") and the recipe version
    // ("under which recipe") are DISTINCT signals — never conflate them.
    expect(RECIPE_VERSION).not.toBe(DEPTH_WARM_PROMOTION_MARKER);
  });
});
