/**
 * R33 — cert-equivalent gates + facesAnswer normalization tests.
 */

import { describe, expect, it } from "vitest";

import {
  streetNamesMatchForFacesAnswer,
  verifyFacesAnswerMatch,
} from "../cert-equivalent-gates.js";
import {
  expandStreetAbbreviationTokens,
  normalizeStreetNameForMatch,
} from "../edgeLabeling.js";
import { verifyWarmCandidateMechanically } from "../verify-mechanical.js";
import { computeWarmCandidate, injectBadWarmCandidate } from "../warm-compute.js";
import bastropDescriptor from "../../property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import { getSetbackTable } from "@hauska-engine/adapters";
import { setbackTableDescriptorFromAdapter } from "../../property-reasoning/setback-table-from-adapter.js";
import type { JurisdictionDescriptor } from "../../property-reasoning/types.js";
import { PARCEL_714_SPRING_33512 } from "../fixtures/parcelRings.js";
import { edgeLabels714SpringHonest } from "../fixtures/edgeLabels714Spring.js";
import type { WarmRoadSource } from "../types.js";

function buildDescriptor(): JurisdictionDescriptor {
  const adapterSetback = setbackTableDescriptorFromAdapter(
    getSetbackTable("bastrop-development-code"),
  );
  return {
    ...(bastropDescriptor as JurisdictionDescriptor),
    setbackTable: adapterSetback!,
  };
}

describe("R33 facesAnswer normalization", () => {
  it("JR/JUNIOR + DR/DRIVE abbreviation pairs match (48021:35865 regression)", () => {
    expect(
      streetNamesMatchForFacesAnswer(
        "MARTIN LUTHER KING JR DR",
        "Martin Luther King Junior Drive",
      ),
    ).toBe(true);
    expect(normalizeStreetNameForMatch("MARTIN LUTHER KING JR DR")).toBe(
      "MARTIN LUTHER KING JUNIOR",
    );
    expect(normalizeStreetNameForMatch("Martin Luther King Junior Drive")).toBe(
      "MARTIN LUTHER KING JUNIOR",
    );
  });

  it("expands SR/SENIOR and common suffix stripping", () => {
    expect(expandStreetAbbreviationTokens("MARTIN LUTHER KING JR")).toBe(
      "MARTIN LUTHER KING JUNIOR",
    );
    expect(normalizeStreetNameForMatch("800 OAK LN")).toBe("OAK");
    expect(normalizeStreetNameForMatch("Oak Lane")).toBe("OAK");
  });

  it("genuine wrong street name still fails facesAnswer", () => {
    expect(streetNamesMatchForFacesAnswer("PECAN ST", "Pine Street")).toBe(false);
    expect(streetNamesMatchForFacesAnswer("MAIN ST", "Martin Luther King Junior Drive")).toBe(
      false,
    );
  });
});

describe("verifyFacesAnswerMatch genuine wrong-edge", () => {
  const CORNER_RING: [number, number][] = [
    [-97.32, 30.11],
    [-97.3194, 30.11],
    [-97.3194, 30.1104],
    [-97.32, 30.1104],
    [-97.32, 30.11],
  ];

  const PECAN_ROAD: WarmRoadSource = {
    osmWayId: 1001,
    osmHighwayTag: "residential",
    name: "Pecan Street",
    classification: "residential",
    polyline: [
      [-97.32008, 30.1098],
      [-97.32008, 30.1106],
    ],
  };

  const PINE_ROAD: WarmRoadSource = {
    osmWayId: 1002,
    osmHighwayTag: "residential",
    name: "Pine Street",
    classification: "residential",
    polyline: [
      [-97.3202, 30.10995],
      [-97.3192, 30.10995],
    ],
  };

  it("fails when situs street does not match the front road (wrong orientation context)", () => {
    const result = verifyFacesAnswerMatch({
      situsAddress: "500 MAIN ST",
      roads: [PECAN_ROAD, PINE_ROAD],
      parcelRing: CORNER_RING,
    });
    expect(result.facesAnswer).toBe(false);
    expect(result.pass).toBe(false);
  });

  it("passes when situs matches the front road with abbreviation variants", () => {
    const result = verifyFacesAnswerMatch({
      situsAddress: "901 PECAN ST",
      roads: [PECAN_ROAD, PINE_ROAD],
      parcelRing: CORNER_RING,
    });
    expect(result.facesAnswer).toBe(true);
    expect(result.pass).toBe(true);
  });
});

describe("R33 promote gate — would-fail-cert does not pass verify", () => {
  const descriptor = buildDescriptor();
  const SPRING_ROAD: WarmRoadSource = {
    osmWayId: 123456789,
    osmHighwayTag: "residential",
    name: "Spring Street",
    classification: "residential",
    polyline: [
      [-97.3188, 30.1102],
      [-97.3182, 30.1105],
      [-97.3176, 30.1108],
    ],
  };

  it("geometry-tampered warm fails R33 verify (would not promote)", () => {
    const good = computeWarmCandidate({
      parcelNodeId: "48021:33512",
      district: "SF-1",
      parcelRing: PARCEL_714_SPRING_33512,
      descriptor,
      roads: [SPRING_ROAD],
      edgeLabels: edgeLabels714SpringHonest(),
    });
    const bad = injectBadWarmCandidate(good);
    const verify = verifyWarmCandidateMechanically(bad, descriptor, { roads: [SPRING_ROAD] });
    expect(verify.pass).toBe(false);
    expect(verify.gates.geometry.pass).toBe(false);
  });
});
