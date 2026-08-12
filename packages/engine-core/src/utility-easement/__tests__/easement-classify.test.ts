import { describe, expect, it } from "vitest";

import { classifyEasementStatus } from "../easement-classify.js";

describe("classifyEasementStatus", () => {
  it("maps utility tokens", () => {
    expect(classifyEasementStatus("UTILITY")).toBe("utility");
    expect(classifyEasementStatus("UE")).toBe("utility");
    expect(classifyEasementStatus("Public Utility Easement")).toBe("utility");
  });

  it("maps drainage and ingress", () => {
    expect(classifyEasementStatus("DRAINAGE")).toBe("drainage");
    expect(classifyEasementStatus("SIDEWALK PUE")).toBe("ingress-egress");
  });

  it("returns unknown for blank", () => {
    expect(classifyEasementStatus(null)).toBe("unknown");
    expect(classifyEasementStatus("")).toBe("unknown");
  });
});
