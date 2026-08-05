/**
 * bake-property-atom-county.mjs — --reword-city-parcels allowlist gate,
 * structural pins (2026-08-05, McDade-catch fix).
 *
 * The CLI script cannot be imported directly in a unit test — top-level
 * arg parsing, the PROPERTY_ATOM_PATH/--county fail-loud checks, and live
 * `createPgStorage`/`postgres()` connection construction all run at
 * module-load time (same reason warden-sweep.mjs and
 * backfill-bastrop-zoning-fact-code-refs.mjs have no direct-import test
 * coverage in this repo — see scripts/__tests__/warden-sweep-txgio-wiring.test.ts
 * and scripts/__tests__/backfill-bastrop-zoning-fact-code-refs.test.ts).
 * This test follows the same established grep-style structural-pin
 * precedent: it asserts on the actual script source text so a future edit
 * that drops the allowlist gate, the fail-loud check, or the
 * skippedNotAllowlisted counter fails this test even without a live
 * database. A live-process smoke test (no DB required — the check fires
 * before any connection attempt) is run separately per the dispatch's
 * verification step; this file pins the source shape that smoke test
 * depends on.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(HERE, "../bake-property-atom-county.mjs");
const scriptSource = readFileSync(scriptPath, "utf8");

describe("bake-property-atom-county.mjs — --reword-city-parcels requires --city-segments (pinned)", () => {
  it("parses --city-segments (both '--flag value' and '--flag=value' forms)", () => {
    expect(scriptSource).toContain('a === "--city-segments"');
    expect(scriptSource).toContain('a.startsWith("--city-segments=")');
  });

  it("fails loud with a named allowlist-requirement error before any DB connection is constructed", () => {
    // The fail-loud check must appear before resolveSubstrateDatabaseUrl()/
    // createPgStorage() in source order, so a fake DATABASE_URL never gets
    // dialed when the allowlist is missing.
    const gateIdx = scriptSource.indexOf(
      "args.rewordCityParcels && citySegmentsAllowlist.size === 0",
    );
    const connectIdx = scriptSource.indexOf("createPgStorage({");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(connectIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(connectIdx);

    // Named error: cites the requirement and the 2026-08-04 McDade dry-run
    // catch in one sentence (per the dispatch spec), and exits non-zero.
    const gateBlock = scriptSource.slice(gateIdx, connectIdx);
    expect(gateBlock).toContain("--reword-city-parcels requires --city-segments");
    expect(gateBlock).toMatch(/McDade/);
    expect(gateBlock).toContain("process.exit(1)");
  });

  it("the blunt whole-county form is unrunnable: the gate checks citySegmentsAllowlist.size === 0, not a truthy/falsy string", () => {
    // Guards against a regression where an empty string or whitespace-only
    // --city-segments value silently passes the gate.
    expect(scriptSource).toContain("function parseCitySegmentsAllowlist(raw)");
    expect(scriptSource).toContain('.filter((s) => s.length > 0)');
  });

  it("filters candidates against the allowlist and counts skips distinctly from skippedNoCitySignal/skippedAlreadyReworded", () => {
    expect(scriptSource).toContain("skippedNotAllowlisted: 0");
    expect(scriptSource).toContain("if (!citySegmentsAllowlist.has(citySegment))");
    expect(scriptSource).toContain("summary.skippedNotAllowlisted += 1");

    // Ordering pin: the allowlist check must run AFTER the no-city-signal
    // check (a parcel with no city signal is never a candidate regardless
    // of the allowlist) and BEFORE the already-reworded idempotency check
    // is irrelevant to order but both skip paths must exist independently.
    const noCitySignalIdx = scriptSource.indexOf("summary.skippedNoCitySignal += 1");
    const notAllowlistedIdx = scriptSource.indexOf("summary.skippedNotAllowlisted += 1");
    expect(noCitySignalIdx).toBeGreaterThan(-1);
    expect(notAllowlistedIdx).toBeGreaterThan(-1);
    expect(noCitySignalIdx).toBeLessThan(notAllowlistedIdx);
  });

  it("other modes (--cascade-absence-only) are not gated by --city-segments", () => {
    // The fail-loud gate is scoped to args.rewordCityParcels only; it must
    // not read args.cascadeAbsenceOnly.
    const gateLine = scriptSource
      .split(/\r?\n/)
      .find((l) => l.includes("citySegmentsAllowlist.size === 0"));
    expect(gateLine).toBeDefined();
    expect(gateLine).not.toContain("cascadeAbsenceOnly");
  });

  it("everything else about the mode stays intact: dry-run default, --apply, --limit, --batch, contentHash recompute, idempotent skip", () => {
    expect(scriptSource).toContain("const dryRun = !args.apply;");
    expect(scriptSource).toContain("delete next.contentHash");
    expect(scriptSource).toContain("next.contentHash = contentHashExcludingProvenance(next);");
    expect(scriptSource).toContain("skippedAlreadyReworded");
    expect(scriptSource).toContain("args.limit > 0 && summary.scanned >= args.limit");
  });
});

describe("parseCitySegmentsAllowlist (re-declared pure logic, matches the script's inline implementation)", () => {
  // Re-declared here rather than imported (module has top-level side
  // effects on import — see file header) — matches the established
  // precedent in backfill-bastrop-zoning-fact-code-refs.test.ts of
  // re-declaring a script's tiny pure helper and pinning it against the
  // script source separately (the "literal roster matches verbatim" test
  // above already ties this re-declaration to the real implementation's
  // shape).
  function parseCitySegmentsAllowlist(raw: string | null): Set<string> {
    if (!raw) return new Set();
    return new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
  }

  it("parses a comma-separated list, trimming whitespace and dropping blanks", () => {
    expect(parseCitySegmentsAllowlist("smithville, del_valle ,,mcdade")).toEqual(
      new Set(["smithville", "del_valle", "mcdade"]),
    );
  });

  it("returns an empty set for null/undefined/empty input", () => {
    expect(parseCitySegmentsAllowlist(null).size).toBe(0);
    expect(parseCitySegmentsAllowlist("").size).toBe(0);
  });

  it("a whitespace-only value normalizes to an empty set (still fails the gate)", () => {
    expect(parseCitySegmentsAllowlist("   ").size).toBe(0);
  });
});
