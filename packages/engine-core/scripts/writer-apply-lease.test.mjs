import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  APPLY_LEASE_MESSAGE,
  consumeRunIdArg,
  LAPTOP_WRITE_FROZEN_MESSAGE,
  persistRailAtoms,
  railLeaseArgs,
  refuseApplyOutsideCloudRunJob,
  refuseApplyWithoutRunId,
} from "./writer-apply-lease.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tsxCli = path.join(here, "../node_modules/tsx/dist/cli.mjs");

/** No store URLs: a late guard after poolUrl dies FATAL exit 1, not LEASE_REQUIRED. */
function spawnEnv(extra) {
  return {
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    COMSPEC: process.env.COMSPEC,
    ...extra,
  };
}

function isEarlyRefuse(r) {
  return (
    r.status === 2 &&
    r.stderr.includes("LEASE_REQUIRED") &&
    r.stderr.includes(APPLY_LEASE_MESSAGE) &&
    !/dry-run-prediction|\.plan\b|atomsBuilt|PLANNING_STARTED/.test(r.stdout)
  );
}

function parseWithConsume(argv) {
  const out = { runId: null };
  for (let i = 0; i < argv.length; i++) {
    const next = consumeRunIdArg(argv[i], argv, i, out);
    if (next !== null) i = next;
  }
  return out;
}

describe("writer-apply-lease helpers", () => {
  it("parses spaced and --run-id= forms", () => {
    expect(parseWithConsume(["--run-id", "abc"]).runId).toBe("abc");
    expect(parseWithConsume(["--run-id=def"]).runId).toBe("def");
    expect(parseWithConsume(["--county=48021"]).runId).toBeNull();
  });

  it("refuses apply without run-id and does not refuse the other arm", () => {
    expect(refuseApplyWithoutRunId("well-fact-county.refused", true, null)).toBe(true);
    expect(refuseApplyWithoutRunId("well-fact-county.refused", true, "row-1")).toBe(false);
    expect(refuseApplyWithoutRunId("well-fact-county.refused", false, null)).toBe(false);
  });

  it("scopes a rail to its own entity_type, never cad-parcel-roll", () => {
    const args = railLeaseArgs({
      entityType: "well-fact",
      countyFips: "48021",
      runId: "row-1",
      holderFallback: "well-fact-writer",
    });
    expect(args.scope).toEqual({
      scope_type: "write",
      entity_type: "well-fact",
      county_fips: "48021",
    });
    expect(args.run_id).toBe("row-1");
    expect(() =>
      railLeaseArgs({
        entityType: "cad-parcel-roll",
        countyFips: "48021",
        runId: "row-1",
        holderFallback: "no",
      }),
    ).toThrow(/cad-parcel-roll/);
  });

  it("refuseApplyOutsideCloudRunJob (P-169): refuses only a real apply attempt with CLOUD_RUN_JOB unset", () => {
    expect(refuseApplyOutsideCloudRunJob("x.refused", true, {})).toBe(true);
    expect(refuseApplyOutsideCloudRunJob("x.refused", true, { CLOUD_RUN_JOB: "" })).toBe(true);
    expect(
      refuseApplyOutsideCloudRunJob("x.refused", true, { CLOUD_RUN_JOB: "hauska-engine-atoms-writer" }),
    ).toBe(false);
    // Falsifier: a dry run (apply=false) must never refuse, even with CLOUD_RUN_JOB unset —
    // dry-runs are slot-free and parallel per AGENT_CONTRACT section 3.
    expect(refuseApplyOutsideCloudRunJob("x.refused", false, {})).toBe(false);
  });

  it("persistRailAtoms refuses a missing lease and threads a present one", async () => {
    const calls = [];
    const storage = {
      writePropertyAtomsBatch: async (atoms, lease) => {
        calls.push({ atoms, lease });
      },
    };
    await expect(persistRailAtoms(storage, [{ id: 1 }], null)).rejects.toThrow(
      /HeldLease/,
    );
    const lease = { holder_token: "t", scope: { entity_type: "setback" } };
    await persistRailAtoms(storage, [{ id: 1 }], lease);
    expect(calls).toEqual([{ atoms: [{ id: 1 }], lease }]);
  });
});

describe("four writers: --apply without --run-id is LEASE_REQUIRED before planning", () => {
  const writers = [
    {
      file: "write-well-fact-county.mjs",
      env: { WELL_FACT_PATH: "1" },
    },
    {
      file: "write-building-footprint-county.mjs",
      env: { BUILDING_FOOTPRINT_PATH: "1" },
    },
    {
      file: "write-utility-easement-county.mjs",
      env: { UTILITY_EASEMENT_PATH: "1" },
    },
    {
      file: "write-setback-city.mjs",
      env: { SETBACK_PATH: "1" },
      extraArgs: ["--city=elgin-tx"],
    },
  ];

  for (const w of writers) {
    it(`${w.file} exits 2 at parse with no county plan`, () => {
      const r = spawnSync(
        process.execPath,
        [tsxCli, path.join(here, w.file), "--apply", "--county=48021", ...(w.extraArgs ?? [])],
        {
          env: spawnEnv(w.env),
          encoding: "utf8",
        },
      );
      expect(isEarlyRefuse(r)).toBe(true);
    });
  }

  it("late-guard fixture fails the early-refuse predicate (instrument can fire)", () => {
    const r = spawnSync(
      process.execPath,
      [tsxCli, path.join(here, "writer-apply-lease-late-guard.fixture.mjs"), "--apply", "--county=48021"],
      { env: spawnEnv({}), encoding: "utf8" },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("LEASE_REQUIRED");
    expect(r.stdout).toContain("PLANNING_STARTED");
    expect(isEarlyRefuse(r)).toBe(false);
  });

  it("LEASE_REQUIRED precedes poolUrl / setback planning in source", () => {
    for (const file of [
      "write-well-fact-county.mjs",
      "write-building-footprint-county.mjs",
      "write-utility-easement-county.mjs",
    ]) {
      const src = readFileSync(path.join(here, file), "utf8");
      const refuseAt = src.indexOf("refuseApplyWithoutRunId");
      const poolAt = src.indexOf("const poolUrl");
      expect(refuseAt, file).toBeGreaterThan(-1);
      expect(poolAt, file).toBeGreaterThan(-1);
      expect(refuseAt, file).toBeLessThan(poolAt);
      expect(src).not.toMatch(/entityType:\s*["']cad-parcel-roll["']/);
    }
    const setback = readFileSync(path.join(here, "write-setback-city.mjs"), "utf8");
    const body = setback.slice(setback.indexOf("export function runSetbackWriter"));
    const leaseAt = body.indexOf("LEASE_REQUIRED");
    const holdAt = body.indexOf("SETBACK_APPLY_HELD");
    const planAt = body.indexOf("resolveSetbackCityBinding");
    expect(leaseAt).toBeGreaterThan(-1);
    expect(holdAt).toBeGreaterThan(leaseAt);
    expect(planAt).toBeGreaterThan(holdAt);
  });

  it("LAPTOP_WRITE_FROZEN precedes poolUrl in write-building-footprint-county.mjs source (P-169)", () => {
    const src = readFileSync(path.join(here, "write-building-footprint-county.mjs"), "utf8");
    // Match CALL sites (identifier immediately followed by "("), not the
    // import statement — the import list's alphabetical order otherwise
    // shadows the real call order and this assertion would pass or fail
    // for the wrong reason.
    const runIdRefuseAt = src.indexOf("refuseApplyWithoutRunId(");
    const cloudRunRefuseAt = src.indexOf("refuseApplyOutsideCloudRunJob(");
    const poolAt = src.indexOf("const poolUrl");
    expect(runIdRefuseAt).toBeGreaterThan(-1);
    expect(cloudRunRefuseAt).toBeGreaterThan(-1);
    expect(poolAt).toBeGreaterThan(-1);
    expect(runIdRefuseAt).toBeLessThan(cloudRunRefuseAt);
    expect(cloudRunRefuseAt).toBeLessThan(poolAt);
  });

  it("write-building-footprint-county.mjs: --apply with --run-id but no CLOUD_RUN_JOB refuses LAPTOP_WRITE_FROZEN, not LEASE_REQUIRED (falsifier: a laptop apply with a fabricated --run-id would otherwise pass, exactly the 2026-09-07 / P-171 gap)", () => {
    const r = spawnSync(
      process.execPath,
      [
        tsxCli,
        path.join(here, "write-building-footprint-county.mjs"),
        "--apply",
        "--county=48021",
        "--run-id=row-1",
      ],
      { env: spawnEnv({ BUILDING_FOOTPRINT_PATH: "1" }), encoding: "utf8" },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("LAPTOP_WRITE_FROZEN");
    expect(r.stderr).toContain(LAPTOP_WRITE_FROZEN_MESSAGE);
    expect(r.stderr).not.toContain("LEASE_REQUIRED");
    expect(r.stdout).not.toMatch(/dry-run-prediction|\.plan\b|atomsBuilt/);
  });

  it("write-building-footprint-county.mjs: the SAME call with CLOUD_RUN_JOB set clears both apply gates (falsifier: the new gate over-refusing a legitimate job execution) and fails later, on the missing store connection instead", () => {
    const r = spawnSync(
      process.execPath,
      [
        tsxCli,
        path.join(here, "write-building-footprint-county.mjs"),
        "--apply",
        "--county=48021",
        "--run-id=row-1",
      ],
      {
        env: spawnEnv({ BUILDING_FOOTPRINT_PATH: "1", CLOUD_RUN_JOB: "hauska-engine-atoms-writer" }),
        encoding: "utf8",
      },
    );
    expect(r.stderr).not.toContain("LEASE_REQUIRED");
    expect(r.stderr).not.toContain("LAPTOP_WRITE_FROZEN");
    // Neither apply gate fired; it fails later for an unrelated, expected reason
    // (no CORTEX_DATABASE_URL/TXGIO_DATABASE_URL/DATABASE_URL in this test env).
    expect(r.stderr).toContain("FATAL");
  });

  it("setback --apply with --run-id still refuses SETBACK_APPLY_HELD", () => {
    const r = spawnSync(
      process.execPath,
      [
        tsxCli,
        path.join(here, "write-setback-city.mjs"),
        "--apply",
        "--county=48021",
        "--city=elgin-tx",
        "--run-id=row-1",
      ],
      { env: spawnEnv({ SETBACK_PATH: "1" }), encoding: "utf8" },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("SETBACK_APPLY_HELD");
    expect(r.stderr).not.toContain("LEASE_REQUIRED");
    expect(r.stdout).not.toMatch(/setback-city\.dry-run|atomsBuilt|PLANNING_STARTED/);
  });
});
