/**
 * cert-grade-and-report.mjs, pure payload-builder tests.
 *
 * Imports the script module directly for its exported
 * buildCertGradeIngestPayload / buildQuarantineIngestPayload functions. The
 * script's top-level main() is gated on a direct-run check (process.argv[1]
 * === this file), so importing it here never spawns block13-cert-grade.mjs
 * or performs any network call, no live DB/network required. The module
 * does statically import BLOCK13_QUARANTINE from
 * bastrop-dominant-district-roster.mjs, which is already proven import-safe
 * without a live DB by src/property-reasoning/__tests__/cascade-unzoned-envelope-decline.test.ts
 * (that module's DB calls are all inside functions, never at module scope).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// @ts-expect-error, .mjs has no type declarations; the exported function shapes are asserted at the call sites below.
import { buildCertGradeIngestPayload, buildQuarantineIngestPayload, stripLeadingArgSeparator } from "../cert-grade-and-report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_SOURCE = readFileSync(join(HERE, "../cert-grade-and-report.mjs"), "utf8");

describe("cert-grade-and-report.mjs, stripLeadingArgSeparator", () => {
  it("drops a single leading bare '--'", () => {
    expect(stripLeadingArgSeparator(["--", "--preflight-row-id=Bastrop"])).toEqual(["--preflight-row-id=Bastrop"]);
  });

  it("is a no-op when there is no leading '--'", () => {
    expect(stripLeadingArgSeparator(["--preflight-row-id=Bastrop"])).toEqual(["--preflight-row-id=Bastrop"]);
  });

  it("does not touch a '--' that is not the first element", () => {
    expect(stripLeadingArgSeparator(["--preflight-row-id=Bastrop", "--", "extra"])).toEqual([
      "--preflight-row-id=Bastrop",
      "--",
      "extra",
    ]);
  });

  it("handles an empty argv", () => {
    expect(stripLeadingArgSeparator([])).toEqual([]);
  });
});

describe("cert-grade-and-report.mjs, spawn invocation shape (Windows EINVAL fix, grep-pinned)", () => {
  it("never spawns a .cmd/.bat package-manager shim (the source of the Windows spawn EINVAL)", () => {
    // The old buggy invocation shape: spawn("pnpm.cmd" on win32, ...). The
    // fix comment above documents that string in prose, so this checks for
    // the executable CODE pattern (spawn( followed by a platform ternary
    // choosing a pnpm shim), not a bare substring match.
    expect(SCRIPT_SOURCE).not.toMatch(/spawn\(\s*\n?\s*process\.platform === "win32" \? "pnpm/);
  });

  it("spawns process.execPath directly with a resolved tsx/cli path (no shell)", () => {
    expect(SCRIPT_SOURCE).toMatch(/createRequire\(import\.meta\.url\)/);
    expect(SCRIPT_SOURCE).toMatch(/\.resolve\("tsx\/cli"\)/);
    expect(SCRIPT_SOURCE).toMatch(/spawn\(process\.execPath,/);
    expect(SCRIPT_SOURCE).toMatch(/shell:\s*false/);
  });

  it("strips a leading bare '--' before building the target script's argv", () => {
    expect(SCRIPT_SOURCE).toMatch(/stripLeadingArgSeparator\(/);
  });
});

/** Fixture shaped like block13-cert-grade.mjs's stdout report. */
const FIXTURE_BLOCK13_PASS = {
  when: "2026-08-03T00:00:00.000Z",
  cert: "BLOCK-13 CERT-RESTORE mechanical grade",
  score: { pass: 7, fail: 0, honestDecline: 0, staleResidue: 0, total: 7, label: "7/7" },
  blockPass: true,
  certRestore: "7/7, CERT-RESTORE ELIGIBLE",
};

const FIXTURE_WITH_SCOPE_ANNOTATIONS = {
  when: "2026-08-03T00:00:00.000Z",
  cert: "Bastrop dominant-district mechanical grade (SF-1)",
  score: { pass: 40, fail: 0, honestDecline: 2, staleResidue: 0, total: 42, label: "40/42" },
  blockPass: true,
  scopeAnnotations: [
    { rail: "zoningSourceReachableOrUnzoned", declineReason: "source unreachable, needs adapter: zoning source not yet wired", defectClass: "ADAPTER-NEEDED" },
  ],
};

describe("cert-grade-and-report.mjs, buildCertGradeIngestPayload", () => {
  it("derives a certSummary carrying label, blockPass, and gradedAt from the captured report", () => {
    const { certSummary } = buildCertGradeIngestPayload(FIXTURE_BLOCK13_PASS, { rowId: "Bastrop", fips: "48021" });
    expect(certSummary).toMatchObject({
      rowId: "Bastrop",
      fips: "48021",
      label: "7/7",
      blockPass: true,
      gradedAt: "2026-08-03T00:00:00.000Z",
    });
    expect(certSummary).not.toHaveProperty("scopeAnnotations");
  });

  it("carries scopeAnnotations through when present on the captured report", () => {
    const { certSummary } = buildCertGradeIngestPayload(FIXTURE_WITH_SCOPE_ANNOTATIONS, { rowId: "Bastrop", fips: "48021" });
    expect(certSummary.scopeAnnotations).toEqual(FIXTURE_WITH_SCOPE_ANNOTATIONS.scopeAnnotations);
  });

  it("falls back to blockPass:false and label:'unknown' for a malformed/empty captured report", () => {
    const { certSummary } = buildCertGradeIngestPayload({}, { rowId: "Bastrop", fips: "48021" });
    expect(certSummary.label).toBe("unknown");
    expect(certSummary.blockPass).toBe(false);
  });
});

describe("cert-grade-and-report.mjs, buildQuarantineIngestPayload", () => {
  const row = {
    rowId: "Bastrop",
    fips: "48021",
    countyName: "Bastrop",
    status: "active",
    zoningRegime: "euclidean-zoned",
  };
  const quarantineIds = new Set(["48021:34145", "48021:34121", "48021:34153"]);
  const nowIso = "2026-08-03T00:00:00.000Z";

  it("produces one event per quarantined parcelNodeId, sorted, with defectClass BLOCK13-QUARANTINE", () => {
    const { events } = buildQuarantineIngestPayload(row, quarantineIds, nowIso);
    expect(events).toHaveLength(3);
    expect(events.map((e: { parcelNodeId: string }) => e.parcelNodeId)).toEqual([
      "48021:34121",
      "48021:34145",
      "48021:34153",
    ]);
    expect(events.every((e: { defectClass: string; ts: string; fips: string; rowId: string }) =>
      e.defectClass === "BLOCK13-QUARANTINE" && e.ts === nowIso && e.fips === "48021" && e.rowId === "Bastrop",
    )).toBe(true);
  });

  it("produces a single-row rowMirror matching the passed registry row", () => {
    const { rowMirror } = buildQuarantineIngestPayload(row, quarantineIds, nowIso);
    expect(rowMirror).toEqual([
      { rowId: "Bastrop", fips: "48021", countyName: "Bastrop", status: "active", zoningRegime: "euclidean-zoned" },
    ]);
  });

  it("degrades gracefully (Bastrop/48021 defaults) when no row is resolved", () => {
    const { rowMirror, events } = buildQuarantineIngestPayload(null, quarantineIds, nowIso);
    expect(rowMirror).toEqual([]);
    expect(events).toHaveLength(3);
    expect(events.every((e: { fips: string; rowId: string }) => e.fips === "48021" && e.rowId === "Bastrop")).toBe(true);
  });
});
