import { describe, expect, it } from "vitest";

import {
  OUTCOME_STATUSES,
  isLandedOutcome,
  isReenterOutcome,
  isOutcomeStatus,
} from "../outcomes.js";

describe("outcome enum exhaustiveness", () => {
  it("pins exactly seven statuses", () => {
    expect(OUTCOME_STATUSES).toHaveLength(7);
    expect(OUTCOME_STATUSES).toEqual([
      "NO-ZONING-AUTHORITY",
      "NO-EUCLIDEAN-REGIME",
      "ORDINANCE-NO-GIS",
      "AUTH-WALLED",
      "HOST-BROKEN",
      "NOT-FOUND-UNKNOWN-WHY",
      "LAYER-FOUND",
    ]);
  });

  it("uses landed/reenter helpers instead of boolean found/absent", () => {
    expect(isLandedOutcome("LAYER-FOUND")).toBe(true);
    expect(isLandedOutcome("HOST-BROKEN")).toBe(true);
    expect(isLandedOutcome("NOT-FOUND-UNKNOWN-WHY")).toBe(false);
    expect(isReenterOutcome("NOT-FOUND-UNKNOWN-WHY")).toBe(true);
    expect(isReenterOutcome("LAYER-FOUND")).toBe(false);
    expect(isOutcomeStatus("LAYER-FOUND")).toBe(true);
    expect(isOutcomeStatus("FOUND")).toBe(false);
  });
});
