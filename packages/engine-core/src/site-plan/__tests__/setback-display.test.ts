import { describe, expect, it } from "vitest";
import {
  formatSetbackEdgeLabel,
  formatSetbackSummaryLine,
  notSpecifiedAxesFromSetbackTable,
  resolveNotSpecifiedAxes,
} from "../setback-display.js";

describe("setback-display", () => {
  it("formats a fully specified setback as F/S/R ft", () => {
    expect(
      formatSetbackSummaryLine({ front: 10, side: 5, rear: 20 }),
    ).toBe("10 / 5 / 20 ft");
  });

  it("never prints silent axes as real 0 ft; discloses build-to-line", () => {
    expect(
      formatSetbackSummaryLine({
        front: 15,
        side: 0,
        rear: 0,
        notSpecified: { side: true, rear: true },
      }),
    ).toBe("F 15' · S not specified · R not specified — build-to-line governs");
  });

  it("edge labels use the honest not-specified disclosure", () => {
    expect(formatSetbackEdgeLabel("side", 0, true)).toBe(
      "SIDE not specified — build-to-line governs",
    );
    expect(formatSetbackEdgeLabel("front", 15, false)).toBe("FRONT 15'");
  });

  it("resolves not_specified from fieldProvenance over table gaps", () => {
    const axes = resolveNotSpecifiedAxes({
      fieldProvenance: {
        side: { notSpecified: true },
        rear: { notSpecified: true },
      },
      tableAxes: { front: true },
    });
    expect(axes).toEqual({ front: true, side: true, rear: true });
  });

  it("looks up B3 P-5 silent side/rear from bastrop-city-tx table", () => {
    const axes = notSpecifiedAxesFromSetbackTable("bastrop-tx", "P-5");
    expect(axes?.side).toBe(true);
    expect(axes?.rear).toBe(true);
    expect(axes?.front).toBeUndefined();
  });
});
