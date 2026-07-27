import { describe, expect, it } from "vitest";

import {
  caldwellCadIsAuthoritative,
  caldwellCadSyntheticWayId,
  classifyCaldwellCadAttributes,
  isDefinedCaldwellSurface,
} from "../classify-caldwell-cad.js";
import {
  caldwellCadRoadIntakeDescriptor,
  emitCaldwellCadRoadNode,
  parseCaldwellCadRoadFeature,
} from "../emit-caldwell-cad-road-node.js";

describe("Caldwell CAD classify + authoritative gate (RECIPE-PROOF 48055)", () => {
  it("rejects empty/Undefined/numeric SURFACE as not defined", () => {
    expect(isDefinedCaldwellSurface("")).toBe(false);
    expect(isDefinedCaldwellSurface("Undefined")).toBe(false);
    expect(isDefinedCaldwellSurface("0")).toBe(false);
    expect(isDefinedCaldwellSurface("59")).toBe(false);
    expect(isDefinedCaldwellSurface("PAVD")).toBe(true);
    expect(isDefinedCaldwellSurface("GRVL")).toBe(true);
  });

  it("classifies HWY_FM as highway and GRVL county street as gravel", () => {
    expect(
      classifyCaldwellCadAttributes({ CLASS: "HWY_FM", ROADTYPE: "FM", SURFACE: "PAVD" }),
    ).toBe("highway");
    expect(
      classifyCaldwellCadAttributes({
        CLASS: "STREET_COUNTY ROAD_GRAVEL",
        SURFACE: "GRVL",
      }),
    ).toBe("gravel");
    expect(
      classifyCaldwellCadAttributes({
        CLASS: "STREET_COUNTY ROAD_PAVED",
        SURFACE: "PAVD",
      }),
    ).toBe("residential");
  });

  it("emits authoritative only when SURFACE defined (SCHEMA≠DATA)", () => {
    const descriptor = caldwellCadRoadIntakeDescriptor();
    const extractedAt = "2026-07-27T12:00:00.000Z";
    const authObs = parseCaldwellCadRoadFeature(
      {
        objectId: 42,
        attributes: {
          OBJECTID: 42,
          ROADNAME: "CR 101",
          CLASS: "STREET_COUNTY ROAD_PAVED",
          SURFACE: "PAVD",
        },
        centerline: [
          [-97.7, 29.88],
          [-97.69, 29.88],
        ],
      },
      extractedAt,
    );
    expect(authObs).not.toBeNull();
    expect(caldwellCadIsAuthoritative(authObs!.attributes)).toBe(true);
    const authAtom = emitCaldwellCadRoadNode(descriptor, authObs!);
    expect(authAtom.row.provenance.kind).toBe("county-roadway-authoritative");
    expect(authAtom.roadNodeId).toBe(`48055:road:${caldwellCadSyntheticWayId(42)}`);

    const undefObs = parseCaldwellCadRoadFeature(
      {
        objectId: 99,
        attributes: {
          OBJECTID: 99,
          CLASS: "STREET_COUNTY ROAD_PAVED",
          SURFACE: "",
        },
        centerline: [
          [-97.7, 29.88],
          [-97.69, 29.88],
        ],
      },
      extractedAt,
    );
    expect(caldwellCadIsAuthoritative(undefObs!.attributes)).toBe(false);
    const undefAtom = emitCaldwellCadRoadNode(descriptor, undefObs!);
    expect(undefAtom.row.provenance.kind).toBe("county-roadway-undefined");
  });
});
