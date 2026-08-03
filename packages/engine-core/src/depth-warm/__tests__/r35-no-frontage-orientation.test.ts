/**
 * R35 — no-frontage / landlocked situs honest-declines orientation (cert PASS).
 */

import { describe, expect, it } from "vitest";

import {
  isNoDeterminableFrontageSitus,
  R35_ORIENTATION_DECLINE,
  verifyFacesAnswerMatch,
} from "../cert-equivalent-gates.js";
import { verifyFrontEdgeOrientation } from "../verify-mechanical.js";

describe("R35 no-determinable-frontage orientation decline", () => {
  it("detects lot-behind / landlocked situs patterns", () => {
    expect(isNoDeterminableFrontageSitus("LOT BEHIND 2208 PECAN , BASTROP, TX")).toBe(true);
    expect(isNoDeterminableFrontageSitus("909 PECAN ST , BASTROP, TX")).toBe(false);
    expect(isNoDeterminableFrontageSitus("908 PINE , BASTROP, TX")).toBe(false);
  });

  it("facesAnswer gate passes with disclosed R35 decline (48021:53859 class)", () => {
    const result = verifyFacesAnswerMatch({
      situsAddress: "LOT BEHIND 2208 PECAN , BASTROP, TX 78602",
      roads: [],
      parcelRing: [
        [-97.32, 30.11],
        [-97.319, 30.11],
        [-97.319, 30.109],
        [-97.32, 30.109],
        [-97.32, 30.11],
      ],
    });
    expect(result.pass).toBe(true);
    expect(result.orientationHonestDecline).toBe(R35_ORIENTATION_DECLINE);
    expect(result.facesAnswer).toBe(false);
  });

  it("front orientation verify passes under R35 without guessing front", () => {
    const result = verifyFrontEdgeOrientation(
      {
        parcelNodeId: "48021:53859",
        district: "SF-1",
        parcelRing: [
          [-97.32, 30.11],
          [-97.319, 30.11],
          [-97.319, 30.109],
          [-97.32, 30.109],
          [-97.32, 30.11],
        ],
        insetRing: null,
        insetFeetPerEdge: {},
        empty: true,
        edges: [],
        roads: [],
      },
      { jurisdictionTenant: "bastrop-tx" } as never,
      { situsAddress: "LOT BEHIND 2208 PECAN , BASTROP, TX 78602", roads: [] },
    );
    expect(result.pass).toBe(true);
    expect(result.reasons).toContain(R35_ORIENTATION_DECLINE);
  });
});
