/**
 * Restores the five write-setback-city.mjs CLI tests as process spawns.
 * Importing that shebang file from vitest SyntaxError'd in this clone.
 * Falsifier: SETBACK_APPLY_HELD unarmed, or county/city parse dropped.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, "../..");
const script = path.join(here, "../write-setback-city.mjs");

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

function run(argv) {
  return spawnSync("pnpm", ["exec", "tsx", script, ...argv], {
    cwd: pkgRoot,
    env: spawnEnv({ SETBACK_PATH: "1" }),
    encoding: "utf8",
    shell: true,
  });
}

describe("write-setback-city CLI (restored; spawn, not import)", () => {
  it("parses --county=48021 and --city=elgin-tx (falsifier: equals-form dropped)", () => {
    const r = run(["--county=48021", "--city=elgin-tx"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("PARCEL_SOURCE_REQUIRED");
    expect(r.stderr).not.toContain("COUNTY_REQUIRED");
    expect(r.stderr).not.toContain("CITY_REQUIRED");
  });

  it("parses spaced --county and --city", () => {
    const r = run(["--county", "48021", "--city", "elgin-tx"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("PARCEL_SOURCE_REQUIRED");
    expect(r.stderr).not.toContain("COUNTY_REQUIRED");
    expect(r.stderr).not.toContain("CITY_REQUIRED");
  });

  it("--apply with --run-id still refuses SETBACK_APPLY_HELD (quarantine)", () => {
    const r = run([
      "--county=48021",
      "--city=elgin-tx",
      "--apply",
      "--run-id=row-1",
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("SETBACK_APPLY_HELD");
    expect(r.stdout).not.toMatch(/setback-city\.dry-run|atomsBuilt/);
  });

  it("CLI missing county refuses COUNTY_REQUIRED before fixture", () => {
    const r = run(["--city=elgin-tx"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("COUNTY_REQUIRED");
  });

  it("CLI missing city refuses CITY_REQUIRED before fixture", () => {
    const r = run(["--county=48021"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("CITY_REQUIRED");
  });
});
