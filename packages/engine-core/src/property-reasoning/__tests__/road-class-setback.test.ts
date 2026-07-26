import { describe, expect, it } from "vitest";

import bastropDescriptor from "../fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import { resolveRoadClassSetback } from "../resolve-road-class-setback.js";
import type { JurisdictionDescriptor } from "../types.js";

describe("resolveRoadClassSetback (27c WDLL 4)", () => {
  const descriptor = bastropDescriptor as JurisdictionDescriptor;

  it("resolves residential street front at 15 ft for P-5", () => {
    const hit = resolveRoadClassSetback(descriptor, "P-5", "residential", "front");
    expect(hit).not.toHaveProperty("kind", "honest-absence");
    if ("kind" in hit) throw new Error("expected setback");
    expect(hit.value).toBe(15);
    expect(hit.verification_state).toBe("human-verified");
  });

  it("resolves alley rear at 5 ft — different from street front (street-vs-alley divergence)", () => {
    const streetFront = resolveRoadClassSetback(
      descriptor,
      "P-5",
      "residential",
      "front",
    );
    const alleyRear = resolveRoadClassSetback(descriptor, "P-5", "alley", "rear");
    if ("kind" in streetFront || "kind" in alleyRear) {
      throw new Error("expected both setbacks");
    }
    expect(streetFront.value).toBe(15);
    expect(alleyRear.value).toBe(5);
    expect(alleyRear.value).not.toBe(streetFront.value);
  });

  it("carries assumed ROW width table on descriptor", () => {
    expect(descriptor.assumedRowWidthFt?.residential).toBe(50);
    expect(descriptor.assumedRowWidthFt?.alley).toBe(20);
  });

  it("falls back to flat district row when road-class cell missing", () => {
    const hit = resolveRoadClassSetback(
      descriptor,
      "P-5",
      "highway",
      "front",
    );
    if ("kind" in hit) throw new Error("expected flat fallback");
    expect(hit.value).toBe(15);
  });

  it("resolves gravel front at 15 ft — same as local street (B3 6.5.003 / Ch7 frontage)", () => {
    const gravelFront = resolveRoadClassSetback(descriptor, "P-5", "gravel", "front");
    const streetFront = resolveRoadClassSetback(
      descriptor,
      "P-5",
      "residential",
      "front",
    );
    if ("kind" in gravelFront || "kind" in streetFront) {
      throw new Error("expected both setbacks");
    }
    expect(gravelFront.value).toBe(15);
    expect(gravelFront.value).toBe(streetFront.value);
  });
});
