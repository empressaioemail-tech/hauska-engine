import { describe, expect, it } from "vitest";
import { pickPreferredSetbackRule } from "../setback-rule-pick.js";

describe("pickPreferredSetbackRule", () => {
  const parcelNodeId = "48021:34177";

  it("prefers authoritative layer-23 over newer depth-warm setback", () => {
    const depthWarm = {
      entityId: parcelNodeId,
      sourceAdapter: "depth-warm-verify-promote",
    };
    const layer23 = {
      entityId: parcelNodeId,
      sourceAdapter: "bastrop-per-parcel-record-layer-23",
    };
    expect(pickPreferredSetbackRule(depthWarm, layer23, parcelNodeId)).toBe(
      layer23,
    );
    expect(pickPreferredSetbackRule(layer23, depthWarm, parcelNodeId)).toBe(
      layer23,
    );
  });

  it("prefers canonical entityId over suffixed sibling", () => {
    const suffixed = { entityId: `${parcelNodeId}:setback:2`, sourceAdapter: "x" };
    const canonical = { entityId: parcelNodeId, sourceAdapter: "x" };
    expect(pickPreferredSetbackRule(suffixed, canonical, parcelNodeId)).toBe(
      canonical,
    );
  });
});
