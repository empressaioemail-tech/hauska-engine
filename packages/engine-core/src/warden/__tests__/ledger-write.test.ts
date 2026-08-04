import { describe, it, expect, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSweepReport, writeFindingsToJsonArtifact, postFindingsToLedger } from "../ledger-write.js";
import type { WardenFindingEvent } from "../types.js";

const FIXED_NOW = () => new Date("2026-08-04T00:00:00.000Z");

const SAMPLE_FLAG: WardenFindingEvent = {
  ts: FIXED_NOW().toISOString(),
  sweepId: "test-sweep",
  rowId: "Bastrop",
  fips: "48021",
  parcelNodeId: "48021:34073",
  checkId: "neighborConsistency",
  defectClass: "MIXED-VINTAGE-NEIGHBOR",
  evidence: { note: "test" },
  severity: "flag",
  artifactRef: "warden-sweep:test-sweep:neighborConsistency",
};

describe("buildSweepReport", () => {
  it("a clean run (no flags) still produces exactly one severity:info clean-sweep event", () => {
    const report = buildSweepReport({
      sweepId: "test-sweep",
      rowId: "Bastrop",
      fips: "48021",
      checksRun: ["neighborConsistency", "servePathTruth"],
      findings: [],
      now: FIXED_NOW,
    });
    expect(report.clean).toBe(true);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.severity).toBe("info");
    expect(report.findings[0]!.evidence.clean).toBe(true);
    // The clean-sweep event must carry the dedicated "CLEAN" literal, never
    // a real WardenDefectClass value — a ledger consumer grouping findings
    // by defectClass must not count this as a phantom finding of an actual
    // defect class (e.g. MIXED-VINTAGE-NEIGHBOR).
    expect(report.findings[0]!.defectClass).toBe("CLEAN");
  });

  it("a run with a flag finding is not clean and does not synthesize a clean-sweep event", () => {
    const report = buildSweepReport({
      sweepId: "test-sweep",
      rowId: "Bastrop",
      fips: "48021",
      checksRun: ["neighborConsistency"],
      findings: [SAMPLE_FLAG],
      now: FIXED_NOW,
    });
    expect(report.clean).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.severity).toBe("flag");
  });
});

describe("writeFindingsToJsonArtifact", () => {
  it("always writes the report to disk", async () => {
    const path = join(tmpdir(), `warden-test-artifact-${Date.now()}.json`);
    const report = buildSweepReport({
      sweepId: "test-sweep",
      rowId: "Bastrop",
      fips: "48021",
      checksRun: ["neighborConsistency"],
      findings: [],
      now: FIXED_NOW,
    });
    await writeFindingsToJsonArtifact(path, report);
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.sweepId).toBe("test-sweep");
    expect(parsed.clean).toBe(true);
    await rm(path, { force: true });
  });
});

describe("postFindingsToLedger — pinned contract", () => {
  it("no-ops when url/key are not configured", async () => {
    const report = buildSweepReport({
      sweepId: "test-sweep",
      rowId: "Bastrop",
      fips: "48021",
      checksRun: ["neighborConsistency"],
      findings: [],
      now: FIXED_NOW,
    });
    const fetchImpl = vi.fn();
    const result = await postFindingsToLedger(null, null, report, fetchImpl as unknown as typeof fetch);
    expect(result.posted).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs to {base}/api/onboarding-ledger/ingest with the pinned body shape and Bearer auth", async () => {
    const report = buildSweepReport({
      sweepId: "test-sweep",
      rowId: "Bastrop",
      fips: "48021",
      checksRun: ["neighborConsistency"],
      findings: [SAMPLE_FLAG],
      now: FIXED_NOW,
    });
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return { ok: true, status: 200 } as Response;
    });
    const result = await postFindingsToLedger(
      "https://cortex.example/",
      "test-ledger-key",
      report,
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.posted).toBe(true);
    expect(capturedUrl).toBe("https://cortex.example/api/onboarding-ledger/ingest");
    expect(capturedInit?.method).toBe("POST");
    expect((capturedInit?.headers as Record<string, string>).Authorization).toBe("Bearer test-ledger-key");
    const body = JSON.parse(capturedInit!.body as string);
    expect(body.sourceKind).toBe("warden-sweep");
    expect(body.gateSummary).toBeUndefined();
    expect(body.certSummary).toBeUndefined();
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events).toEqual(report.findings);
  });

  it("a non-ok response reports posted:false with the HTTP status", async () => {
    const report = buildSweepReport({
      sweepId: "test-sweep",
      rowId: "Bastrop",
      fips: "48021",
      checksRun: ["neighborConsistency"],
      findings: [],
      now: FIXED_NOW,
    });
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
    const result = await postFindingsToLedger(
      "https://cortex.example",
      "test-ledger-key",
      report,
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.posted).toBe(false);
    expect(result.httpStatus).toBe(500);
  });
});
