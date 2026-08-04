import { describe, expect, it } from "vitest";

import elginDescriptor from "../../property-reasoning/fixtures/descriptors/elgin_tx_descriptor.json" with { type: "json" };
import type { JurisdictionDescriptor } from "../../property-reasoning/types.js";
import { buildDescriptorSetbackKey } from "../cert-grade-core.js";

describe("buildDescriptorSetbackKey — elgin_tx R-1 ratified table", () => {
  const descriptor = elginDescriptor as JurisdictionDescriptor;

  it("returns front 25 / side 7.5 / rear 10 for R-1", () => {
    const built = buildDescriptorSetbackKey(descriptor, "R-1");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.key).toMatchObject({
      district: "R-1",
      F: 25,
      S: 7.5,
      R: 10,
    });
    expect(built.key.C).toBe(15);
  });

  it("uses leading token when district carries suffix text", () => {
    const built = buildDescriptorSetbackKey(descriptor, "R-1 Single Family");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.key.F).toBe(25);
    expect(built.key.S).toBe(7.5);
    expect(built.key.R).toBe(10);
  });

  it("declines when district missing from descriptor table", () => {
    const built = buildDescriptorSetbackKey(descriptor, "PDD");
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe("setback-no-match");
  });
});
