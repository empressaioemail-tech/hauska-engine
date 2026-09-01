import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  applyWriterPathEnv,
  parseWriterJobFlags,
  requireWriterEnv,
  resolveWriterJob,
  resolveWriterSelection,
  WRITER_ALLOWLIST,
  WRITER_NOT_ALLOWLISTED,
  WRITER_REQUIRED,
  COUNTY_REQUIRED,
} from "../../scripts/atoms-writer-allowlist.mjs";

const JOB = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/atoms-writer-job.mjs",
);

function runJob(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [JOB, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env, WRITER_NAME: env.WRITER_NAME ?? "" },
  });
}

describe("atoms-writer-job env", () => {
  it("refuses a pooler host", () => {
    try {
      requireWriterEnv({
        SUBSTRATE_DATABASE_URL:
          "postgres://u@ep-lucky-truth-pooler.c-7.us-east-1.aws.neon.tech/hauska_mcp",
        CORTEX_DATABASE_URL: "postgres://u@ep-source.example/cortex",
      });
      expect.fail("expected POOLER_HOST_REFUSED");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("POOLER_HOST_REFUSED");
    }
  });

  it("refuses a missing atoms URL", () => {
    try {
      requireWriterEnv({
        CORTEX_DATABASE_URL: "postgres://u@ep-source.example/cortex",
      });
      expect.fail("expected MISSING_ENV");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("MISSING_ENV");
    }
  });
});

describe("atoms-writer-job allowlist selection", () => {
  it("allowlist names the five writers and does not default a script", () => {
    expect(Object.keys(WRITER_ALLOWLIST).sort()).toEqual(
      [
        "building-footprint",
        "cad-parcel-roll",
        "setback",
        "utility-easement",
        "well-fact",
      ].sort(),
    );
    expect(WRITER_ALLOWLIST["cad-parcel-roll"]?.pathEnv).toBe("CAD_PARCEL_ROLL_PATH");
    expect(WRITER_ALLOWLIST.setback?.script).toBe("scripts/write-setback-city.mjs");
    expect(WRITER_ALLOWLIST.setback?.planRow).toBe("F-11");
  });

  it("absent writer name throws WRITER_REQUIRED (falsifier: CAD default would pass)", () => {
    expect(() => resolveWriterSelection(null)).toThrowError(/WRITER_REQUIRED/);
    expect(() => resolveWriterSelection("")).toThrowError(/WRITER_REQUIRED/);
    try {
      resolveWriterJob([]);
      expect.fail("expected WRITER_REQUIRED");
    } catch (err) {
      expect((err as { code?: string }).code).toBe(WRITER_REQUIRED);
    }
  });

  it("unknown writer throws WRITER_NOT_ALLOWLISTED (falsifier: fallthrough to CAD would pass)", () => {
    try {
      resolveWriterSelection("not-a-writer");
      expect.fail("expected WRITER_NOT_ALLOWLISTED");
    } catch (err) {
      expect((err as { code?: string }).code).toBe(WRITER_NOT_ALLOWLISTED);
    }
  });

  it("cad-parcel-roll without county throws COUNTY_REQUIRED (falsifier: spawn without county would pass)", () => {
    try {
      resolveWriterJob(["--writer=cad-parcel-roll"]);
      expect.fail("expected COUNTY_REQUIRED");
    } catch (err) {
      expect((err as { code?: string }).code).toBe(COUNTY_REQUIRED);
    }
  });

  it("equals-form --county=48021 resolves 48021 (falsifier: ignored equals-form would be null)", () => {
    const flags = parseWriterJobFlags(["--writer=cad-parcel-roll", "--county=48021"]);
    expect(flags.county).toBe("48021");
    const resolved = resolveWriterJob(["--writer=cad-parcel-roll", "--county=48021"]);
    expect(resolved.county).toBe("48021");
    expect(resolved.runScope).toEqual({
      writer: "cad-parcel-roll",
      county: "48021",
      script: "scripts/write-cad-parcel-roll-county.mjs",
      pathEnv: "CAD_PARCEL_ROLL_PATH",
    });
  });

  it("spaced --county 48021 also resolves 48021", () => {
    const flags = parseWriterJobFlags(["--writer", "well-fact", "--county", "48021"]);
    expect(flags.writer).toBe("well-fact");
    expect(flags.county).toBe("48021");
  });

  it("WRITER_NAME is an explicit allowlist key, not a CAD default", () => {
    const resolved = resolveWriterJob(["--county=48021"], { WRITER_NAME: "setback" });
    expect(resolved.writer.id).toBe("setback");
    expect(resolved.runScope.script).toBe("scripts/write-setback-city.mjs");
  });

  it("selecting well-fact does not set CAD_PARCEL_ROLL_PATH=1 (falsifier: leftover CAD env)", () => {
    const env = applyWriterPathEnv({}, WRITER_ALLOWLIST["well-fact"]);
    expect(env.WELL_FACT_PATH).toBe("1");
    expect(env.CAD_PARCEL_ROLL_PATH).toBeUndefined();
    expect(env.SETBACK_PATH).toBeUndefined();
  });

  it("selecting cad-parcel-roll sets only that writer's env (falsifier: all PATH=1)", () => {
    const env = applyWriterPathEnv(
      { WELL_FACT_PATH: "1", CAD_PARCEL_ROLL_PATH: "1" },
      WRITER_ALLOWLIST["cad-parcel-roll"],
    );
    expect(env.CAD_PARCEL_ROLL_PATH).toBe("1");
    expect(env.WELL_FACT_PATH).toBeUndefined();
    expect(env.BUILDING_FOOTPRINT_PATH).toBeUndefined();
    expect(env.UTILITY_EASEMENT_PATH).toBeUndefined();
    expect(env.SETBACK_PATH).toBeUndefined();
  });
});

describe("atoms-writer-job process refusals", () => {
  it("no --writer exits non-zero WRITER_REQUIRED (falsifier: CAD child runs)", () => {
    const result = runJob([]);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain(WRITER_REQUIRED);
    expect(`${result.stderr}${result.stdout}`).not.toContain("write-cad-parcel-roll-county");
  });

  it("--writer=not-a-writer exits non-zero WRITER_NOT_ALLOWLISTED", () => {
    const result = runJob(["--writer=not-a-writer"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain(WRITER_NOT_ALLOWLISTED);
  });

  it("--writer=cad-parcel-roll without --county exits non-zero COUNTY_REQUIRED", () => {
    const result = runJob(["--writer=cad-parcel-roll"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain(COUNTY_REQUIRED);
  });

  it("POSITIVE admit: --writer=cad-parcel-roll selects the CAD child and sets CAD_PARCEL_ROLL_PATH (falsifier: WRITER_REQUIRED or a non-CAD script)", () => {
    const resolved = resolveWriterJob(["--writer=cad-parcel-roll", "--county=48021"]);
    expect(resolved.writer.id).toBe("cad-parcel-roll");
    expect(resolved.runScope.script).toBe("scripts/write-cad-parcel-roll-county.mjs");
    expect(resolved.runScope.pathEnv).toBe("CAD_PARCEL_ROLL_PATH");
    const env = applyWriterPathEnv({}, resolved.writer);
    expect(env.CAD_PARCEL_ROLL_PATH).toBe("1");
    expect(env.WELL_FACT_PATH).toBeUndefined();
    const result = runJob(["--writer=cad-parcel-roll", "--county=48021"]);
    const text = `${result.stderr}${result.stdout}`;
    expect(text).toContain("atoms-writer.run-scope");
    expect(text).toContain("write-cad-parcel-roll-county.mjs");
    expect(text).toContain('"writer":"cad-parcel-roll"');
    expect(text).not.toContain(WRITER_REQUIRED);
    expect(text).not.toContain(WRITER_NOT_ALLOWLISTED);
  });
});

/**
 * gcloud `run jobs deploy --args=[ARG,...]` is comma-separated. The first "="
 * after --args starts the list; remaining "=" stay in the token. Verified
 * against `gcloud run jobs deploy --help` 2026-08-31 and the Factory
 * precedent `--args=f10-cad-loop,--apply` (A-019).
 */
function gcloudArgsFlag(flag: string): string[] {
  const eq = flag.indexOf("=");
  if (eq < 0) return [];
  const list = flag.slice(eq + 1);
  return list === "" ? [] : list.split(",");
}

describe("cloudbuild.atoms-writer --args form", () => {
  it("EQUALS form --args=--writer=cad-parcel-roll is one token the entrypoint admits (falsifier: split on the second = or drop the flag)", () => {
    const tokens = gcloudArgsFlag("--args=--writer=cad-parcel-roll");
    expect(tokens).toEqual(["--writer=cad-parcel-roll"]);
    const resolved = resolveWriterJob([...tokens, "--county=48021"]);
    expect(resolved.writer.id).toBe("cad-parcel-roll");
    expect(resolved.runScope.script).toBe("scripts/write-cad-parcel-roll-county.mjs");
  });

  it("yaml does not bake a county and does not stamp CAD_PARCEL_ROLL_PATH (falsifier: --county= or CAD_PARCEL_ROLL_PATH=1 in deploy env)", () => {
    const yaml = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../cloudbuild.atoms-writer.yaml"),
      "utf8",
    );
    expect(yaml).toContain("--args=--writer=cad-parcel-roll");
    expect(yaml).not.toMatch(/--set-env-vars=[^\n]*CAD_PARCEL_ROLL_PATH=1/);
    expect(yaml).not.toMatch(/--args=[^\n]*--county=/);
  });
});
