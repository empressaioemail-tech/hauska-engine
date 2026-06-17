/**
 * Arrow-two Phase 3 — calibration overlay integration tests (migration 0037 fixture).
 * Behavior-parity with legacy-design-tools lib/engine-core (a431e8e no-pool fixtures).
 */

import { describe, expect, it } from "vitest";
import { PUBLIC_CALIBRATION_TENANT } from "../dbShim.js";
import { InMemoryCalibrationRepository } from "../inMemoryPorts.js";
import { canonicalOverlayKeyFromCodeToken } from "../overlayAtomKey.js";
import {
  ensureCorpusOverlayRow,
  recomputeCalibrationOverlay,
  resolveOverlayCalibration,
  resolveOverlayKeyFromStructuredRef,
  seedReasoningOverlayFromAtom,
  effectiveConfidence,
  invalidateStaleCalibrationForAtom,
} from "../overlay.js";
import { computeAttributionCoverage } from "../attribution.js";
import { stampsMatch, stampFromFields } from "../stamp.js";

const REASONING_REF = "[[CODE:reasoning:fbc-2023:fbc-m601-6]]";
const REASONING_ID = "reasoning:fbc-2023:fbc-m601-6";

async function seedEngagementFinding(
  repo: InMemoryCalibrationRepository,
  args: {
    tenant: string;
    findingAtomId: string;
    citedAtomId: string;
    confidence?: string;
  },
) {
  repo.findingCitations.push({
    citations: [{ kind: "code-section", atomId: args.citedAtomId }],
  });
  for (let i = 0; i < 3; i++) {
    repo.adjudicationRows.push({
      eventType: "finding.accepted",
      citations: [{ kind: "code-section", atomId: args.citedAtomId }],
      confidence: args.confidence ?? "0.85",
      cortexJurisdictionKey: args.tenant,
      jurisdictionCity: null,
      jurisdictionState: null,
      jurisdiction: "Test",
      address: null,
    });
  }
  return { tenant: args.tenant, findingAtomId: args.findingAtomId };
}

describe("structured-ref overlay resolution", () => {
  it("resolves [[CODE:reasoning:...]] to canonical overlay key", () => {
    expect(resolveOverlayKeyFromStructuredRef(REASONING_REF)).toBe(REASONING_ID);
    expect(canonicalOverlayKeyFromCodeToken(REASONING_REF)).toBe(REASONING_ID);
  });
});

describe("overlay covers reasoning + corpus atoms", () => {
  it("resolves calibration for both atom kinds without corpus mutation", async () => {
    const repo = new InMemoryCalibrationRepository();

    repo.reasoningAtoms.set(REASONING_ID, {
      id: REASONING_ID,
      accessPolicy: "platform-internal",
      codeRef: "FBC-M601.6",
      edition: "FBC 2023",
      sourceSetVersion: 1,
      assertedConfidence: "0.8",
      calibratedConfidence: null,
      calibrationStale: false,
    });
    await seedReasoningOverlayFromAtom(repo, { reasoningAtomId: REASONING_ID });

    const corpusId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    repo.corpusAtoms.set(corpusId, {
      id: corpusId,
      sectionNumber: "R301.2",
      edition: "2021",
      sourceType: "pdf",
    });
    await ensureCorpusOverlayRow(repo, {
      atomId: corpusId,
      sourceType: "pdf",
      codeRef: "R301.2",
      edition: "2021",
    });

    const reasoningRow = await resolveOverlayCalibration(repo, {
      atomId: REASONING_ID,
      jurisdictionTenant: PUBLIC_CALIBRATION_TENANT,
    });
    const corpusRow = await resolveOverlayCalibration(repo, {
      atomId: corpusId,
      jurisdictionTenant: PUBLIC_CALIBRATION_TENANT,
    });

    expect(reasoningRow?.atomId).toBe(REASONING_ID);
    expect(corpusRow?.atomId).toBe(corpusId);
    expect(Number(corpusRow?.assertedConfidence)).toBeGreaterThan(0.7);
  });
});

describe("cold-start fallback", () => {
  it("reads assertedConfidence when no calibration signal — never zero", () => {
    const eff = effectiveConfidence({
      assertedConfidence: 0.72,
      calibratedConfidence: null,
      calibrationStale: false,
    });
    expect(eff.value).toBeCloseTo(0.72, 3);
    expect(eff.grade).toBe("asserted");
    expect(eff.value).toBeGreaterThan(0);
  });
});

describe("tenant sovereignty — two-tenant no leakage", () => {
  it("public grade pools anonymous only; tenant overlays stay isolated", async () => {
    const repo = new InMemoryCalibrationRepository();
    const sharedAtom = REASONING_ID;

    await repo.upsertOverlayRow({
      atomId: sharedAtom,
      jurisdictionTenant: PUBLIC_CALIBRATION_TENANT,
      partitionKind: "public",
      accessPolicy: "public-free",
      assertedConfidence: "0.75",
      calibratedConfidence: "0.91",
      codeRef: "FBC-M601.6",
      edition: "FBC 2023",
      sourceSetVersion: 1,
      calibrationStale: false,
      calibrationGrain: "atom",
      atomClass: null,
      signalCount: 5,
    });
    await repo.upsertOverlayRow({
      atomId: sharedAtom,
      jurisdictionTenant: "bastrop_tx",
      partitionKind: "tenant-private",
      accessPolicy: "tenant-private",
      assertedConfidence: "0.75",
      calibratedConfidence: "0.55",
      codeRef: "FBC-M601.6",
      edition: "FBC 2023",
      sourceSetVersion: 1,
      calibrationStale: false,
      calibrationGrain: "atom",
      atomClass: null,
      signalCount: 4,
    });
    await repo.upsertOverlayRow({
      atomId: sharedAtom,
      jurisdictionTenant: "elgin_tx",
      partitionKind: "tenant-private",
      accessPolicy: "tenant-private",
      assertedConfidence: "0.75",
      calibratedConfidence: "0.62",
      codeRef: "FBC-M601.6",
      edition: "FBC 2023",
      sourceSetVersion: 1,
      calibrationStale: false,
      calibrationGrain: "atom",
      atomClass: null,
      signalCount: 4,
    });

    const publicRow = await resolveOverlayCalibration(repo, {
      atomId: sharedAtom,
      jurisdictionTenant: PUBLIC_CALIBRATION_TENANT,
    });
    const bastropRow = await resolveOverlayCalibration(repo, {
      atomId: sharedAtom,
      jurisdictionTenant: "bastrop_tx",
    });
    const elginRow = await resolveOverlayCalibration(repo, {
      atomId: sharedAtom,
      jurisdictionTenant: "elgin_tx",
    });

    expect(publicRow?.calibratedConfidence).toBeCloseTo(0.91, 2);
    expect(bastropRow?.calibratedConfidence).toBeCloseTo(0.55, 2);
    expect(elginRow?.calibratedConfidence).toBeCloseTo(0.62, 2);
    expect(bastropRow?.calibratedConfidence).not.toBe(publicRow?.calibratedConfidence);
    expect(elginRow?.calibratedConfidence).not.toBe(bastropRow?.calibratedConfidence);
  });
});

describe("tenant-shared no-pool into public", () => {
  it("tenant-shared partition never writes to __public__", async () => {
    const repo = new InMemoryCalibrationRepository();
    const atomId = "reasoning:fbc-2023:shared-sec";
    const sharedWith = ["mox_living", "partner_a"];

    await repo.upsertOverlayRow({
      atomId,
      jurisdictionTenant: `__shared__:${sharedWith.slice().sort().join(",")}`,
      partitionKind: "tenant-shared",
      accessPolicy: "tenant-shared",
      sharedWithTenants: sharedWith,
      assertedConfidence: "0.7",
      calibratedConfidence: "0.88",
      codeRef: null,
      edition: null,
      sourceSetVersion: 1,
      calibrationStale: false,
      calibrationGrain: "atom",
      atomClass: null,
      signalCount: 6,
    });

    const publicRows = (await repo.listOverlayRows()).filter(
      (r) => r.jurisdictionTenant === PUBLIC_CALIBRATION_TENANT,
    );
    expect(publicRows).toHaveLength(0);

    const sharedRow = await resolveOverlayCalibration(repo, {
      atomId,
      jurisdictionTenant: "mox_living",
    });
    expect(sharedRow).toBeNull();

    const direct = await repo.findOverlayRow(
      atomId,
      `__shared__:${sharedWith.slice().sort().join(",")}`,
    );
    expect(direct?.calibratedConfidence).toBe("0.88");
    expect(direct?.partitionKind).toBe("tenant-shared");
  });
});

describe("source-set drift invalidation", () => {
  it("bumps sourceSetVersion invalidates stale calibration (all three stamp fields)", async () => {
    const repo = new InMemoryCalibrationRepository();
    const atomId = REASONING_ID;
    await repo.upsertOverlayRow({
      atomId,
      jurisdictionTenant: PUBLIC_CALIBRATION_TENANT,
      partitionKind: "public",
      accessPolicy: "public-free",
      assertedConfidence: "0.8",
      calibratedConfidence: "0.95",
      codeRef: "FBC-M601.6",
      edition: "FBC 2023",
      sourceSetVersion: 1,
      calibrationStale: false,
      calibrationGrain: "atom",
      atomClass: null,
      signalCount: 5,
    });

    const oldStamp = stampFromFields({
      codeRef: "FBC-M601.6",
      edition: "FBC 2023",
      sourceSetVersion: 1,
    });
    const newStamp = stampFromFields({
      codeRef: "FBC-M601.6",
      edition: "FBC 2023",
      sourceSetVersion: 2,
    });
    expect(stampsMatch(oldStamp, newStamp)).toBe(false);

    await invalidateStaleCalibrationForAtom(repo, {
      atomId,
      codeRef: "FBC-M601.6",
      edition: "FBC 2023",
      sourceSetVersion: 2,
    });

    const row = await repo.findOverlayRow(atomId, PUBLIC_CALIBRATION_TENANT);
    expect(row?.calibrationStale).toBe(true);
    expect(row?.calibratedConfidence).toBeNull();
    expect(row?.sourceSetVersion).toBe(2);

    const resolved = await resolveOverlayCalibration(repo, {
      atomId,
      jurisdictionTenant: PUBLIC_CALIBRATION_TENANT,
    });
    expect(resolved?.calibrationGrade).toBe("stale");
    expect(resolved?.effectiveConfidence).toBeCloseTo(0.8, 2);
  });
});

describe("recompute from adjudication lineage", () => {
  it("writes overlay rows from finding citations + accept events", async () => {
    const repo = new InMemoryCalibrationRepository();
    repo.reasoningAtoms.set(REASONING_ID, {
      id: REASONING_ID,
      accessPolicy: "platform-internal",
      codeRef: "FBC-M601.6",
      edition: "FBC 2023",
      sourceSetVersion: 1,
      assertedConfidence: "0.8",
      calibratedConfidence: null,
      calibrationStale: false,
    });

    const { tenant } = await seedEngagementFinding(repo, {
      tenant: "bastrop_tx",
      findingAtomId: "finding:cal:001",
      citedAtomId: REASONING_ID,
    });

    const { rowsWritten } = await recomputeCalibrationOverlay(repo);
    expect(rowsWritten).toBeGreaterThan(0);

    const tenantRow = await resolveOverlayCalibration(repo, {
      atomId: REASONING_ID,
      jurisdictionTenant: "bastrop_tx",
    });
    expect(tenantRow?.signalCount).toBeGreaterThanOrEqual(3);
    expect(tenantRow?.partitionKind).toBe("tenant-private");
    expect(tenant).toBe("bastrop_tx");
  });
});

describe("attribution coverage", () => {
  it("measures write-time overlay hit rate for cited atoms", async () => {
    const repo = new InMemoryCalibrationRepository();
    repo.findingCitations.push({
      citations: [{ kind: "code-section", atomId: REASONING_ID }],
    });
    await repo.upsertOverlayRow({
      atomId: REASONING_ID,
      jurisdictionTenant: PUBLIC_CALIBRATION_TENANT,
      partitionKind: "public",
      accessPolicy: "public-free",
      assertedConfidence: "0.7",
      calibratedConfidence: null,
      codeRef: null,
      edition: null,
      sourceSetVersion: 1,
      calibrationStale: false,
      calibrationGrain: "atom",
      atomClass: null,
      signalCount: 0,
    });

    const health = await computeAttributionCoverage(repo, {
      jurisdictionTenant: "bastrop_tx",
    });
    expect(health.citationsResolved).toBe(1);
    expect(health.overlayHits).toBe(1);
    expect(health.attributionCoverageRate).toBe(1);
  });
});
