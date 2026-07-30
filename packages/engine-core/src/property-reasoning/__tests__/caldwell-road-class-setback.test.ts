import { describe, expect, it } from "vitest";

import caldwellDescriptor from "../fixtures/descriptors/caldwell_tx_descriptor.json" with { type: "json" };
import {
  resolveDistrictEdgeSetback,
  resolveRoadClassSetback,
} from "../resolve-road-class-setback.js";
import type { JurisdictionDescriptor } from "../types.js";

describe("Caldwell/Lockhart flat setbackTable (RECIPE-PROOF 48055 / WDLL 7 STEP 4)", () => {
  const descriptor = caldwellDescriptor as JurisdictionDescriptor;

  it("has flat setbackTable and no roadClassSetbackTable value source", () => {
    expect(descriptor.setbackTable?.rows.length).toBeGreaterThan(0);
    expect(descriptor.roadClassSetbackTable).toBeUndefined();
  });

  it("resolves RLD residential street front at 25 ft from flat table", () => {
    const hit = resolveDistrictEdgeSetback(descriptor, "RLD", "front");
    expect(hit).not.toHaveProperty("kind", "honest-absence");
    if ("kind" in hit) throw new Error("expected setback");
    expect(hit.value).toBe(25);
  });

  it("resolves RLD side 7.5 and rear 10 from flat table", () => {
    const side = resolveDistrictEdgeSetback(descriptor, "RLD", "side");
    const rear = resolveDistrictEdgeSetback(descriptor, "RLD", "rear");
    if ("kind" in side || "kind" in rear) throw new Error("expected setbacks");
    expect(side.value).toBe(7.5);
    expect(rear.value).toBe(10);
  });

  it("alley rear uses flat rear (10) — no invented alley-specific feet", () => {
    // Compat shim still accepts roadClass but ignores it for VALUES.
    const alleyRear = resolveRoadClassSetback(descriptor, "RLD", "alley", "rear");
    if ("kind" in alleyRear) throw new Error("expected flat fallthrough");
    expect(alleyRear.value).toBe(10);
  });

  it("hard-hold PDD has no setback row", () => {
    const hit = resolveDistrictEdgeSetback(descriptor, "PDD", "front");
    expect(hit).toHaveProperty("kind", "honest-absence");
  });

  it("gravel front matches residential front for RMD (road class ignored)", () => {
    const gravel = resolveRoadClassSetback(descriptor, "RMD", "gravel", "front");
    const street = resolveRoadClassSetback(descriptor, "RMD", "residential", "front");
    if ("kind" in gravel || "kind" in street) throw new Error("expected both");
    expect(gravel.value).toBe(street.value);
    expect(gravel.value).toBe(25);
  });
});
