import { describe, expect, it } from "vitest";

import {
  bastropRoadwayIsAuthoritative,
  classifyCountyStreetAttributes,
  isDefinedCountySurface,
} from "../classify-county-street.js";

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

describe("bastropRoadwayIsAuthoritative (S2-F amendment)", () => {
  it("defined Paved surface is authoritative", () => {
    expect(
      bastropRoadwayIsAuthoritative({
        class: "LS",
        surface: "Paved",
        owner: "City",
      }),
    ).toBe(true);
  });

  it("Undefined surface with LS class is NOT authoritative", () => {
    expect(
      bastropRoadwayIsAuthoritative({
        class: "LS",
        surface: "Undefined",
        owner: "City",
        l_muni: "BASTROP",
      }),
    ).toBe(false);
  });

  it("empty surface is NOT authoritative", () => {
    expect(isDefinedCountySurface("")).toBe(false);
    expect(isDefinedCountySurface("Undefined")).toBe(false);
    expect(isDefinedCountySurface("Gravel")).toBe(true);
  });

  it("road_gravel_year implicit signal is authoritative", () => {
    expect(
      bastropRoadwayIsAuthoritative({
        class: "LS",
        surface: "Undefined",
        road_gravel_year: 2015,
      }),
    ).toBe(true);
  });
});
