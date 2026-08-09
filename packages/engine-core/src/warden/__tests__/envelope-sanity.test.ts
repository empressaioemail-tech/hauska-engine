import { describe, it, expect } from "vitest";

import {
  PARCEL_34073_BCAD,
  PARCEL_34073_SF1_LAYER23,
} from "../../boundary-primitive/fixtures/bastropDowntownDrill.js";
import { insetPerEdge, type Ring } from "../../depth-warm/geometry.js";
import {
  classifyEnvelopeSanity,
  classifyEnvelopeSanityForParcel,
  extractEnvelopeRingFromGeojson,
  isHonestEnvelopeDecline,
} from "../envelope-sanity.js";

const COUNTY_FIPS = "48021";
const PARCEL_NODE = `${COUNTY_FIPS}:34073`;
const FIXED_NOW = () => new Date("2026-08-05T00:00:00.000Z");

function buildGeojsonBody(ring: Ring) {
  return {
    outcome: { kind: "buildable", areaSqFt: 1000 },
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [ring] },
          properties: { kind: "buildable-envelope" },
        },
      ],
    },
  };
}

function perEdgeSetbacksFor34073(): number[] {
  const n = PARCEL_34073_BCAD.length - 1;
  return Array.from({ length: n }, () => PARCEL_34073_SF1_LAYER23.side);
}

describe("extractEnvelopeRingFromGeojson", () => {
  it("reads the first feature polygon exterior ring", () => {
    const ring = extractEnvelopeRingFromGeojson(buildGeojsonBody(PARCEL_34073_BCAD).geojson);
    expect(ring).not.toBeNull();
    expect(ring!.length).toBeGreaterThanOrEqual(3);
  });
});

describe("isHonestEnvelopeDecline", () => {
  it("treats warmVerifyDecline as honest absence", () => {
    expect(isHonestEnvelopeDecline({ warmVerifyDecline: "front-orientation" })).toBe(true);
  });

  it("treats contract absence as honest absence", () => {
    expect(
      isHonestEnvelopeDecline({
        absence: { kind: "front-orientation", reason: "verify failed" },
      }),
    ).toBe(true);
  });

  it("treats no-buildable-area outcome as honest absence", () => {
    expect(isHonestEnvelopeDecline({ outcome: { kind: "no-buildable-area", reason: "x" } })).toBe(true);
  });
});

describe("classifyEnvelopeSanityForParcel", () => {
  it("passes a uniform inset envelope inside the parcel with plausible area ratio and parallel edges", () => {
    const inset = insetPerEdge(PARCEL_34073_BCAD, perEdgeSetbacksFor34073());
    expect(inset.empty).toBe(false);
    expect(inset.ring).not.toBeNull();

    const result = classifyEnvelopeSanityForParcel({
      parcelNodeId: PARCEL_NODE,
      district: "SF-1",
      envelopeBody: buildGeojsonBody(inset.ring!),
      parcelRing: PARCEL_34073_BCAD,
    });
    expect(result).toBeNull();
  });

  it("flags envelope vertices outside the parcel ring", () => {
    const inset = insetPerEdge(PARCEL_34073_BCAD, perEdgeSetbacksFor34073());
    const shifted: Ring = inset.ring!.map(([lng, lat]) => [lng + 0.001, lat + 0.001] as [number, number]);
    shifted.push([shifted[0]![0], shifted[0]![1]]);

    const result = classifyEnvelopeSanityForParcel({
      parcelNodeId: PARCEL_NODE,
      district: "SF-1",
      envelopeBody: buildGeojsonBody(shifted),
      parcelRing: PARCEL_34073_BCAD,
    });
    expect(result?.anomalies).toContain("envelope-outside-parcel");
  });

  it("flags a full-lot mis-inset (area ratio ~1.0)", () => {
    const result = classifyEnvelopeSanityForParcel({
      parcelNodeId: PARCEL_NODE,
      district: "SF-1",
      envelopeBody: buildGeojsonBody(PARCEL_34073_BCAD),
      parcelRing: PARCEL_34073_BCAD,
    });
    expect(result?.anomalies).toContain("area-ratio-full-lot");
    expect(result?.evidence.areaRatio).toBeCloseTo(1, 2);
  });

  it("flags a degenerate sliver envelope", () => {
    const [lng0, lat0] = PARCEL_34073_BCAD[0]!;
    const sliver: Ring = [
      [lng0, lat0],
      [lng0 + 1e-7, lat0],
      [lng0 + 1e-7, lat0 + 1e-7],
      [lng0, lat0 + 1e-7],
      [lng0, lat0],
    ];
    const result = classifyEnvelopeSanityForParcel({
      parcelNodeId: PARCEL_NODE,
      district: "SF-1",
      envelopeBody: buildGeojsonBody(sliver),
      parcelRing: PARCEL_34073_BCAD,
    });
    expect(result?.anomalies).toContain("area-ratio-sliver");
  });

  it("flags non-parallel inset edges (rotated envelope inside parcel)", () => {
    const inset = insetPerEdge(PARCEL_34073_BCAD, perEdgeSetbacksFor34073());
    expect(inset.ring).not.toBeNull();
    const cx =
      inset.ring!.reduce((s, [lng]) => s + lng, 0) / (inset.ring!.length - 1);
    const cy =
      inset.ring!.reduce((s, [, lat]) => s + lat, 0) / (inset.ring!.length - 1);
    const rotated: Ring = inset.ring!.map(([lng, lat]) => {
      const dx = lng - cx;
      const dy = lat - cy;
      const rad = (25 * Math.PI) / 180;
      const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
      const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
      return [cx + rx, cy + ry] as [number, number];
    });
    rotated.push([rotated[0]![0], rotated[0]![1]]);

    const result = classifyEnvelopeSanityForParcel({
      parcelNodeId: PARCEL_NODE,
      district: "SF-1",
      envelopeBody: buildGeojsonBody(rotated),
      parcelRing: PARCEL_34073_BCAD,
    });
    expect(result?.anomalies).toContain("inset-edge-not-parallel");
  });

  it("skips honest warm-verify declines without flagging", () => {
    const result = classifyEnvelopeSanityForParcel({
      parcelNodeId: PARCEL_NODE,
      district: "SF-1",
      envelopeBody: { warmVerifyDeclineCode: "front-orientation" },
      parcelRing: PARCEL_34073_BCAD,
    });
    expect(result).toBeNull();
  });
});

describe("classifyEnvelopeSanity", () => {
  it("emits one WardenFindingEvent per flagged parcel with ENVELOPE-SHAPE-ANOMALY", () => {
    const findings = classifyEnvelopeSanity({
      sweepId: "test-sweep",
      fips: COUNTY_FIPS,
      rowId: "Bastrop",
      now: FIXED_NOW,
      parcels: [
        {
          parcelNodeId: PARCEL_NODE,
          district: "SF-1",
          envelopeBody: buildGeojsonBody(PARCEL_34073_BCAD),
          parcelRing: PARCEL_34073_BCAD,
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.checkId).toBe("envelopeSanity");
    expect(findings[0]!.defectClass).toBe("ENVELOPE-SHAPE-ANOMALY");
    expect(findings[0]!.severity).toBe("flag");
    expect(findings[0]!.parcelNodeId).toBe(PARCEL_NODE);
    expect(findings[0]!.artifactRef).toBe("warden-sweep:test-sweep:envelopeSanity");
    expect(findings[0]!.evidence.anomalies).toEqual(
      expect.arrayContaining(["area-ratio-full-lot"]),
    );
  });
});
