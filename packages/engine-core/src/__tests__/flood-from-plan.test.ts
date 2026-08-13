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
  parcelsRead: 2,
  emptyZoneIndex: false,
  planned: [
    {
      outcome: "present",
      parcelKey: "1",
      inSpecialFloodHazardArea: true,
      floodZone: "AE",
      zoneSubtype: null,
      baseFloodElevation: 12.5,
    },
    {
      outcome: "absent",
      parcelKey: "2",
      absenceKind: "no-flood-coverage",
      reason: "no usable centroid",
    },
  ],
  counts: {
    present: 1,
    presentInSfha: 1,
    presentOutside: 0,
    absent: 1,
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
});
