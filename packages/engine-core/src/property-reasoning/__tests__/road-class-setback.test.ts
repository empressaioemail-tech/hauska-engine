import { describe, expect, it } from "vitest";

import bastropDescriptor from "../fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import {
  resolveDistrictEdgeSetback,
  resolveRoadClassSetback,
} from "../resolve-road-class-setback.js";
import type { JurisdictionDescriptor } from "../types.js";

describe("resolveDistrictEdgeSetback (WDLL 7 — flat table VALUE source)", () => {
  const descriptor = bastropDescriptor as JurisdictionDescriptor;

  it("resolves SF-1 front at 30 ft from flat BDC table (not road-class)", () => {
    const hit = resolveDistrictEdgeSetback(descriptor, "SF-1", "front");
    expect(hit).not.toHaveProperty("kind", "honest-absence");
    if ("kind" in hit) throw new Error("expected setback");
    expect(hit.value).toBe(30);
    expect(hit.verification_state).toBe("human-verified");
  });

  it("alley rear uses flat rear — road-class cell no longer invents a different number", () => {
    const streetFront = resolveRoadClassSetback(
      descriptor,
      "SF-1",
      "residential",
      "front",
    );
    const alleyRear = resolveRoadClassSetback(descriptor, "SF-1", "alley", "rear");
    if ("kind" in streetFront || "kind" in alleyRear) {
      throw new Error("expected both setbacks");
    }
    expect(streetFront.value).toBe(30);
    expect(alleyRear.value).toBe(30);
  });

  it("carries assumed ROW width table on descriptor (road twin kept)", () => {
    expect(descriptor.assumedRowWidthFt?.residential).toBe(50);
    expect(descriptor.assumedRowWidthFt?.alley).toBe(20);
  });

  it("highway front equals flat front — road class does not override", () => {
    const hit = resolveRoadClassSetback(descriptor, "SF-1", "highway", "front");
    if ("kind" in hit) throw new Error("expected flat fallback");
    expect(hit.value).toBe(30);
  });

  it("gravel front equals residential front (both read flat table)", () => {
    const gravelFront = resolveRoadClassSetback(descriptor, "SF-1", "gravel", "front");
    const streetFront = resolveRoadClassSetback(
      descriptor,
      "SF-1",
      "residential",
      "front",
    );
    if ("kind" in gravelFront || "kind" in streetFront) {
      throw new Error("expected both setbacks");
    }
    expect(gravelFront.value).toBe(30);
    expect(gravelFront.value).toBe(streetFront.value);
  });
});
