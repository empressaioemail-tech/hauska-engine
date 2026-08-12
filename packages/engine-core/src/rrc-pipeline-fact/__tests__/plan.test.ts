import { describe, expect, it } from "vitest";

import {
  countDedupedPipelines,
  pipelineDedupeKey,
  planCountyRrcPipeline,
} from "../plan-county-rrc-pipeline.js";
import {
  minEdgeToLineDistanceMeters,
  ringsFromGeoJson,
} from "../../rail-corridor-fact/geo.js";
import type { PipelineSegmentFeature } from "../plan-county-rrc-pipeline.js";

describe("rrc-pipeline dedupe", () => {
  it("keys on t4permit|p5_num never operator", () => {
    expect(
      pipelineDedupeKey({ t4permit: "T4-1", p5Num: "12345" }),
    ).toBe("T4-1|12345");
    expect(
      pipelineDedupeKey({ t4permit: null, p5Num: "9" }),
    ).toBe("|9");
  });

  it("counts unique physical pipelines across county-split rows", () => {
    const segs: PipelineSegmentFeature[] = [
      {
        pipelineRowId: "1",
        t4permit: "A",
        p5Num: "1",
        operatorName: "OP1",
        systemName: null,
        commodity: null,
        commodityDescription: null,
        systemType: null,
        status: null,
        diameter: null,
        interstate: null,
        geometry: { type: "LineString", coordinates: [[-102, 32], [-101.9, 32]] },
        westLng: -102,
        eastLng: -101.9,
        southLat: 32,
        northLat: 32,
      },
      {
        pipelineRowId: "2",
        t4permit: "A",
        p5Num: "1",
        operatorName: "OP1-OTHER-NAME",
        systemName: null,
        commodity: null,
        commodityDescription: null,
        systemType: null,
        status: null,
        diameter: null,
        interstate: null,
        geometry: { type: "LineString", coordinates: [[-101.9, 32], [-101.8, 32]] },
        westLng: -101.9,
        eastLng: -101.8,
        southLat: 32,
        northLat: 32,
      },
      {
        pipelineRowId: "3",
        t4permit: "B",
        p5Num: "2",
        operatorName: "OP2",
        systemName: null,
        commodity: null,
        commodityDescription: null,
        systemType: null,
        status: null,
        diameter: null,
        interstate: null,
        geometry: { type: "LineString", coordinates: [[-101, 31], [-100.9, 31]] },
        westLng: -101,
        eastLng: -100.9,
        southLat: 31,
        northLat: 31,
      },
    ];
    expect(countDedupedPipelines(segs)).toBe(2);
  });
});

describe("planCountyRrcPipeline", () => {
  const nearSeg: PipelineSegmentFeature = {
    pipelineRowId: "10",
    t4permit: "T4-NEAR",
    p5Num: "555",
    operatorName: "ACME PIPE",
    systemName: "Permian Main",
    commodity: "CRUDE",
    commodityDescription: "Crude Oil",
    systemType: "Gathering",
    status: "In Service",
    diameter: 12,
    interstate: false,
    geometry: {
      type: "LineString",
      coordinates: [
        [-102.0805, 31.997],
        [-102.0795, 31.997],
      ],
    },
    westLng: -102.0805,
    eastLng: -102.0795,
    southLat: 31.997,
    northLat: 31.997,
  };

  const dupSeg: PipelineSegmentFeature = {
    ...nearSeg,
    pipelineRowId: "11",
    operatorName: "ACME PIPE LLC",
    geometry: {
      type: "LineString",
      coordinates: [
        [-102.0795, 31.997],
        [-102.0785, 31.997],
      ],
    },
    westLng: -102.0795,
    eastLng: -102.0785,
  };

  it("plans present-near with bufferMeters and dedupe fields", () => {
    const plan = planCountyRrcPipeline(
      [
        {
          parcelKey: "1001",
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [-102.0802, 31.9965],
                [-102.0798, 31.9965],
                [-102.0798, 31.9975],
                [-102.0802, 31.9975],
                [-102.0802, 31.9965],
              ],
            ],
          },
        },
      ],
      [nearSeg, dupSeg],
      { countyFips: "48329" },
    );
    expect(plan.bufferMeters).toBe(152.4);
    expect(plan.counts.presentNear).toBe(1);
    expect(plan.pipelinesDeduped).toBe(1);
    const row = plan.planned[0];
    expect(row?.outcome).toBe("present");
    if (row?.outcome === "present") {
      expect(row.nearPipeline).toBe(true);
      expect(row.t4permit).toBe("T4-NEAR");
      expect(row.p5Num).toBe("555");
      expect(row.bufferMeters).toBe(152.4);
    }
  });

  it("plans present-outside when pipeline is far away", () => {
    const plan = planCountyRrcPipeline(
      [
        {
          parcelKey: "99999",
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [-100.0, 30.0],
                [-99.999, 30.0],
                [-99.999, 30.001],
                [-100.0, 30.001],
                [-100.0, 30.0],
              ],
            ],
          },
        },
      ],
      [nearSeg],
      { countyFips: "48329" },
    );
    expect(plan.counts.presentOutside).toBe(1);
    expect(plan.planned[0]).toMatchObject({
      outcome: "present",
      nearPipeline: false,
    });
  });

  it("empty pipeline index after successful read → present outside, not absence", () => {
    const plan = planCountyRrcPipeline(
      [
        {
          parcelKey: "1",
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [-103, 30],
                [-102.999, 30],
                [-102.999, 30.001],
                [-103, 30.001],
                [-103, 30],
              ],
            ],
          },
        },
      ],
      [],
      { countyFips: "48043", sourceReadFailed: false },
    );
    expect(plan.counts.absent).toBe(0);
    expect(plan.counts.presentOutside).toBe(1);
  });

  it("typed absence when geometry missing", () => {
    const plan = planCountyRrcPipeline(
      [{ parcelKey: "88888", geometry: null }],
      [nearSeg],
      { countyFips: "48329" },
    );
    expect(plan.counts.absent).toBe(1);
    expect(plan.planned[0]?.outcome).toBe("absent");
  });

  it("source read failure → no-pipeline-coverage absence", () => {
    const plan = planCountyRrcPipeline(
      [
        {
          parcelKey: "1",
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [-102.08, 31.996],
                [-102.079, 31.996],
                [-102.079, 31.997],
                [-102.08, 31.997],
                [-102.08, 31.996],
              ],
            ],
          },
        },
      ],
      [],
      { countyFips: "48329", sourceReadFailed: true },
    );
    expect(plan.counts.absent).toBe(1);
    if (plan.planned[0]?.outcome === "absent") {
      expect(plan.planned[0].absenceKind).toBe("no-pipeline-coverage");
    }
  });

  it("edge-to-line distance helper works for pipeline lines", () => {
    const rings = ringsFromGeoJson({
      type: "Polygon",
      coordinates: [
        [
          [-102.0802, 31.9965],
          [-102.0798, 31.9965],
          [-102.0798, 31.9975],
          [-102.0802, 31.9975],
          [-102.0802, 31.9965],
        ],
      ],
    });
    const dist = minEdgeToLineDistanceMeters(rings, [
      [
        [-102.0805, 31.997],
        [-102.0795, 31.997],
      ],
    ]);
    expect(dist).toBeLessThan(152.4);
  });
});
