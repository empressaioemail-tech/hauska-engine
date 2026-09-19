import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FLOOD_PLAN_NDJSON_FORMAT,
  buildFloodPlanPayload,
  digestFloodPlan,
  drainFloodPlanPayload,
  readFloodPlanPayload,
  writeFloodPlanPayload,
  type FloodPlanPayload,
} from "../flood-hazard-fact/plan-payload.js";
import type { CountyFloodHazardPlan } from "../flood-hazard-fact/plan-county-flood-hazard.js";

const PLAN: CountyFloodHazardPlan = {
  countyFips: "48261",
  zonesIndexed: 3,
  parcelsRead: 3,
  emptyZoneIndex: false,
  planned: [
    {
      outcome: "present",
      parcelKey: "1",
      inSpecialFloodHazardArea: true,
      floodZone: "AE",
      zoneSubtype: null,
      baseFloodElevation: 12.5,
      samplePoint: [-97.5, 30.5],
      samplePointDerivation: "ring-centroid",
      samplePointContainment: "contained",
    },
    {
      outcome: "absent",
      parcelKey: "2",
      absenceKind: "no-flood-coverage",
      reason: "no usable centroid",
      samplePoint: [-97.6, 30.6],
      samplePointDerivation: "ring-centroid",
      samplePointContainment: "contained",
    },
  ],
  refused: [
    {
      outcome: "refused",
      parcelKey: "3",
      reasonCode: "sample-point-outside-parcel",
      reason: "48261:3 — REFUSED: query point falls outside the parcel ring it answers for",
      samplePoint: [-97.7, 30.7],
      samplePointDerivation: "ring-centroid",
      samplePointContainment: "not-contained",
    },
  ],
  containment: {
    contained: 2,
    notContained: 1,
    unmeasurable: 0,
    byDerivation: {
      "ring-centroid": 3,
      "point-geometry": 0,
      "bbox-centre": 0,
      declared: 0,
      none: 0,
    },
    emitted: 2,
    refused: 1,
    byReasonCode: { contained: 2, "sample-point-outside-parcel": 1 },
    countingRule: "test fixture",
  },
  counts: {
    present: 1,
    presentInSfha: 1,
    presentOutside: 0,
    absent: 1,
    refused: 1,
    skippedUnusableKey: 0,
  },
};

describe("flood-hazard-fact --from-plan NDJSON", () => {
  it("round-trips NDJSON without a planned[] array on the header line", () => {
    const dir = mkdtempSync(join(tmpdir(), "flood-plan-ndjson-"));
    const path = join(dir, "48261.plan.ndjson");
    try {
      const payload = buildFloodPlanPayload(PLAN, {
        plannedAt: "2026-08-13T00:00:00.000Z",
        planBackend: "postgis",
      });
      writeFloodPlanPayload(path, payload);
      const head = readFileSync(path, "utf8").split("\n")[0]!;
      expect(head).toContain(FLOOD_PLAN_NDJSON_FORMAT);
      expect(head).not.toContain('"planned":[');
      const back = readFloodPlanPayload(path);
      expect(back.format).toBe(FLOOD_PLAN_NDJSON_FORMAT);
      expect(back.planned).toHaveLength(2);
      expect(back.planned[0]?.parcelKey).toBe("1");
      expect(back.planDigest.sha256).toBe(digestFloodPlan(PLAN).sha256);
      const drained = drainFloodPlanPayload(back, { countyFips: "48261" });
      expect(drained.plan.counts.present).toBe(1);
      expect(drained.planDigest.sha256).toBe(back.planDigest.sha256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when --county does not match the plan header", () => {
    const payload: FloodPlanPayload = buildFloodPlanPayload(PLAN);
    expect(() =>
      drainFloodPlanPayload(payload, { countyFips: "48201" }),
    ).toThrow(/FAIL CLOSED/);
  });

  it("fails closed when --expect-digest does not match", () => {
    const payload = buildFloodPlanPayload(PLAN);
    expect(() =>
      drainFloodPlanPayload(payload, {
        countyFips: "48261",
        expectDigest: "deadbeef",
      }),
    ).toThrow(/FAIL CLOSED/);
  });

  it("fails closed on a pre-containment artifact that carries no refused[]", () => {
    const payload = buildFloodPlanPayload(PLAN);
    const legacy = { ...payload } as Record<string, unknown>;
    delete legacy.refused;
    expect(() =>
      drainFloodPlanPayload(legacy as unknown as FloodPlanPayload, {
        countyFips: "48261",
      }),
    ).toThrow(/predates the sample-point containment gate/);
  });

  it("digests the refusal set, so a plan that stops refusing gets a different hash", () => {
    const withRefusal = digestFloodPlan(PLAN).sha256;
    const withoutRefusal = digestFloodPlan({
      planned: PLAN.planned,
      refused: [],
    }).sha256;
    expect(withRefusal).not.toBe(withoutRefusal);
    expect(digestFloodPlan(PLAN).refusedRecords).toBe(1);
    expect(digestFloodPlan(PLAN).byRefusalReason).toEqual({
      "sample-point-outside-parcel": 1,
    });
  });

  it("carries the sampling stamp through the NDJSON round trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "flood-plan-stamp-"));
    const path = join(dir, "48261.plan.ndjson");
    try {
      writeFloodPlanPayload(path, buildFloodPlanPayload(PLAN));
      const back = readFloodPlanPayload(path);
      expect(back.planned[0]?.samplePoint).toEqual([-97.5, 30.5]);
      expect(back.planned[0]?.samplePointContainment).toBe("contained");
      expect(back.refused).toHaveLength(1);
      expect(back.refused[0]?.reasonCode).toBe("sample-point-outside-parcel");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
