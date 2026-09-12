import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Exercised via spawnSync, never a direct import: this script executes a
// top-level `main()` as a module side effect and imports `postgres`, the
// same shape every county writer script in this directory uses. Direct
// import into the vitest/esbuild SSR pipeline reproducibly misattributed a
// "SyntaxError: Invalid or unexpected token" to the IMPORTING test file's
// own import statement (confirmed not a real syntax error: node --check
// and direct esbuild 0.21.5/0.28.0 transformSync both accept the file in
// isolation) -- this is the pre-existing pattern (writer-apply-lease.test.mjs)
// for exactly this reason.

const here = path.dirname(fileURLToPath(import.meta.url));
const tsxCli = path.join(here, "../node_modules/tsx/dist/cli.mjs");
const script = path.join(here, "retag-building-footprint-county.mjs");

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

describe("retag-building-footprint-county.mjs CLI", () => {
  it("refuses PATH_GUARD when RETAG_BUILDING_FOOTPRINT_COUNTY_PATH is unset", () => {
    const r = spawnSync(process.execPath, [tsxCli, script, "--county=48021"], {
      env: spawnEnv({}),
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("PATH_GUARD");
  });

  it("a laptop --apply refuses LAPTOP_WRITE_FROZEN before any store connection opens (falsifier: an --apply that instead fails on a missing CORTEX_DATABASE_URL would mean the gate runs too late)", () => {
    const r = spawnSync(
      process.execPath,
      [tsxCli, script, "--apply", "--county=48021"],
      { env: spawnEnv({ RETAG_BUILDING_FOOTPRINT_COUNTY_PATH: "1" }), encoding: "utf8" },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("LAPTOP_WRITE_FROZEN");
    expect(r.stderr).not.toContain("CORTEX_URL_REQUIRED");
  });

  it("an unknown --target refuses TARGET_UNKNOWN naming the target, never falling back to the legacy CORTEX_DATABASE_URL path", () => {
    const r = spawnSync(
      process.execPath,
      [tsxCli, script, "--target=prod", "--county=48021"],
      {
        env: spawnEnv({
          RETAG_BUILDING_FOOTPRINT_COUNTY_PATH: "1",
          CORTEX_DATABASE_URL: "postgres://should-not-be-used/db",
        }),
        encoding: "utf8",
      },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("TARGET_UNKNOWN");
  });

  it("a known --target with the variable missing refuses TARGET_ENV_MISSING naming the variable, never silently using CORTEX_DATABASE_URL", () => {
    const r = spawnSync(
      process.execPath,
      [tsxCli, script, "--target=staging", "--county=48021"],
      {
        env: spawnEnv({
          RETAG_BUILDING_FOOTPRINT_COUNTY_PATH: "1",
          CORTEX_DATABASE_URL: "postgres://should-not-be-used/db",
        }),
        encoding: "utf8",
      },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("TARGET_ENV_MISSING");
    expect(r.stderr).toContain("STAGING_NEONDB_URL");
  });
});
