/**
 * Hard-kill checkpoint tests — commitment #3 enforcement.
 */

import { describe, expect, it } from "vitest";

import {
  evaluateHardKill,
  HARD_KILL_CHECKPOINT_COUNTIES,
  InMemoryCostPort,
  TARGET_COMPUTE_DOLLARS,
  TARGET_HUMAN_REVIEW_MINUTES,
} from "../index.js";

describe("hard-kill checkpoint", () => {
  it("does not trigger before 3 counties evaluated", async () => {
    const port = new InMemoryCostPort();
    await port.upsert({
      recordId: "r1",
      jurisdictionTenant: "a",
      runDate: "2026-05-18",
      llmTokensCostCents: 100_00,
      ocrCostCents: 0,
      embeddingCostCents: 0,
      infrastructureCostCents: 0,
      humanReviewMinutes: 30,
      notes: null,
      flaggedOverTarget: false,
      createdAt: new Date().toISOString(),
    });
    const report = await evaluateHardKill(port);
    expect(report.triggered).toBe(false);
    expect(report.countiesEvaluated).toBe(1);
  });

  it("does not trigger when average is within target", async () => {
    const port = new InMemoryCostPort();
    for (let i = 0; i < HARD_KILL_CHECKPOINT_COUNTIES; i++) {
      await port.upsert({
        recordId: `r${i}`,
        jurisdictionTenant: `j${i}`,
        runDate: "2026-05-18",
        llmTokensCostCents: 50_00,
        ocrCostCents: 0,
        embeddingCostCents: 0,
        infrastructureCostCents: 50_00,
        humanReviewMinutes: 30,
        notes: null,
        flaggedOverTarget: false,
        createdAt: new Date().toISOString(),
      });
    }
    const report = await evaluateHardKill(port);
    expect(report.triggered).toBe(false);
  });

  it("triggers when average compute exceeds target", async () => {
    const port = new InMemoryCostPort();
    for (let i = 0; i < HARD_KILL_CHECKPOINT_COUNTIES; i++) {
      await port.upsert({
        recordId: `r${i}`,
        jurisdictionTenant: `j${i}`,
        runDate: "2026-05-18",
        llmTokensCostCents: TARGET_COMPUTE_DOLLARS * 200,
        ocrCostCents: 0,
        embeddingCostCents: 0,
        infrastructureCostCents: 0,
        humanReviewMinutes: 30,
        notes: null,
        flaggedOverTarget: true,
        createdAt: new Date().toISOString(),
      });
    }
    const report = await evaluateHardKill(port);
    expect(report.triggered).toBe(true);
    expect(report.message).toContain("HARD-KILL");
  });

  it("triggers when human-review-minutes average exceeds target", async () => {
    const port = new InMemoryCostPort();
    for (let i = 0; i < HARD_KILL_CHECKPOINT_COUNTIES; i++) {
      await port.upsert({
        recordId: `r${i}`,
        jurisdictionTenant: `j${i}`,
        runDate: "2026-05-18",
        llmTokensCostCents: 0,
        ocrCostCents: 0,
        embeddingCostCents: 0,
        infrastructureCostCents: 0,
        humanReviewMinutes: TARGET_HUMAN_REVIEW_MINUTES * 2,
        notes: null,
        flaggedOverTarget: true,
        createdAt: new Date().toISOString(),
      });
    }
    const report = await evaluateHardKill(port);
    expect(report.triggered).toBe(true);
  });
});
