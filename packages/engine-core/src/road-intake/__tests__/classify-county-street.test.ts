import { describe, expect, it } from "vitest";

import { classifyCountyStreetAttributes } from "../classify-county-street.js";

describe("classify-county-street (S2-U1 U1.1)", () => {
  it("maps Unpaved/Gravel CR surface to gravel", () => {
    expect(
      classifyCountyStreetAttributes({
        class: "LS",
        surface: "Unpaved/Gravel CR",
      }),
    ).toBe("gravel");
  });

  it("maps Two Course/Paved CR to residential", () => {
    expect(
      classifyCountyStreetAttributes({
        class: "LS",
        surface: "Two Course/Paved CR",
      }),
    ).toBe("residential");
  });

  it("maps Non County (US, State, City) to major_collector", () => {
    expect(
      classifyCountyStreetAttributes({
        class: "LS",
        surface: "Non County (US, State, City)",
      }),
    ).toBe("major_collector");
  });

  it("maps DW Hotmix/Asphalt to minor_collector", () => {
    expect(
      classifyCountyStreetAttributes({
        class: "DW",
        surface: "Hotmix/Asphalt CR",
      }),
    ).toBe("minor_collector");
  });

  it("uses road_grave flag when surface text is empty", () => {
    expect(
      classifyCountyStreetAttributes({
        class: "LS",
        surface: " ",
        road_grave: 1,
      }),
    ).toBe("gravel");
  });
});
