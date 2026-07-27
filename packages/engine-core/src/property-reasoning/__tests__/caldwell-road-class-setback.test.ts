import { describe, expect, it } from "vitest";

import caldwellDescriptor from "../fixtures/descriptors/caldwell_tx_descriptor.json" with { type: "json" };
import { resolveRoadClassSetback } from "../resolve-road-class-setback.js";
import type { JurisdictionDescriptor } from "../types.js";

describe("Caldwell/Lockhart resolveRoadClassSetback (RECIPE-PROOF 48055 gate 4)", () => {
  const descriptor = caldwellDescriptor as JurisdictionDescriptor;

  it("resolves RLD residential street front at 25 ft", () => {
    const hit = resolveRoadClassSetback(descriptor, "RLD", "residential", "front");
    expect(hit).not.toHaveProperty("kind", "honest-absence");
    if ("kind" in hit) throw new Error("expected setback");
    expect(hit.value).toBe(25);
  });

  it("resolves RLD side 7.5 and rear 10 from road-class table", () => {
    const side = resolveRoadClassSetback(descriptor, "RLD", "residential", "side");
    const rear = resolveRoadClassSetback(descriptor, "RLD", "residential", "rear");
    if ("kind" in side || "kind" in rear) throw new Error("expected setbacks");
    expect(side.value).toBe(7.5);
    expect(rear.value).toBe(10);
  });

  it("honest absence of alley-specific row — flat rear fallthrough (no invented alley feet)", () => {
    const alleyRear = resolveRoadClassSetback(descriptor, "RLD", "alley", "rear");
    // No alley entry in roadClassSetbackTable → flat rear fallthrough (10), not invented 5'.
    if ("kind" in alleyRear) throw new Error("expected flat fallthrough");
    expect(alleyRear.value).toBe(10);
  });

  it("hard-hold PDD has no setback row", () => {
    const hit = resolveRoadClassSetback(descriptor, "PDD", "residential", "front");
    expect(hit).toHaveProperty("kind", "honest-absence");
  });

  it("gravel front matches residential front for RMD", () => {
    const gravel = resolveRoadClassSetback(descriptor, "RMD", "gravel", "front");
    const street = resolveRoadClassSetback(descriptor, "RMD", "residential", "front");
    if ("kind" in gravel || "kind" in street) throw new Error("expected both");
    expect(gravel.value).toBe(street.value);
    expect(gravel.value).toBe(25);
  });
});
