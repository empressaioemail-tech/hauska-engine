import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(HERE, "../../../scripts");

/**
 * Fixture-scoped pilots that warm named parcels directly (not registry cohort
 * batch). Exempt from gateWarmCohort in-script; cohort gating lives in
 * depth-warm-city-batch.mjs for production batch paths.
 */
const PILOT_GATE_EXEMPT = new Set(["depth-warm-bastrop-pilot.mjs"]);

function scriptBasename(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
}

function isRetiredWarmRunnerStub(source: string): boolean {
  const headLines = source.split(/\r?\n/).slice(0, 5).join("\n");
  if (/RETIRED/i.test(headLines)) {
    return true;
  }
  return /RETIRED/i.test(source) && /process\.exit\s*\(\s*2\s*\)/.test(source);
}

function listScripts(matching: RegExp): string[] {
  return readdirSync(SCRIPTS_DIR)
    .filter((name) => matching.test(name))
    .sort()
    .map((name) => join(SCRIPTS_DIR, name));
}

describe("warm runner gate contract — scripts/depth-warm-*-{batch,pilot}.mjs", () => {
  const batchScripts = listScripts(/^depth-warm-.*-batch\.mjs$/);
  const pilotScripts = listScripts(/^depth-warm-.*-pilot\.mjs$/);

  it("sanity: discovers batch and pilot warm runner scripts", () => {
    expect(batchScripts.map(scriptBasename)).toEqual(
      expect.arrayContaining([
        "depth-warm-bastrop-batch.mjs",
        "depth-warm-city-batch.mjs",
        "depth-warm-elgin-batch.mjs",
        "depth-warm-caldwell-batch.mjs",
      ]),
    );
    expect(pilotScripts.map(scriptBasename)).toContain(
      "depth-warm-bastrop-pilot.mjs",
    );
  });

  for (const file of batchScripts) {
    const name = scriptBasename(file);
    it(`${name} — active batch runner imports gateWarmCohort (retired stubs exempt)`, () => {
      const source = readFileSync(file, "utf8");
      if (isRetiredWarmRunnerStub(source)) {
        return;
      }
      expect(
        source.includes("gateWarmCohort"),
        `${name} is not a retired stub and must call gateWarmCohort`,
      ).toBe(true);
    });
  }

  for (const file of pilotScripts) {
    const name = scriptBasename(file);
    it(`${name} — pilot exempt or gated like batch runners`, () => {
      const source = readFileSync(file, "utf8");
      if (isRetiredWarmRunnerStub(source) || PILOT_GATE_EXEMPT.has(name)) {
        return;
      }
      expect(
        source.includes("gateWarmCohort"),
        `${name} is not exempt and must call gateWarmCohort`,
      ).toBe(true);
    });
  }

  it("depth-warm-bastrop-downtown-drill.mjs must not spawn retired bastrop-batch", () => {
    const drillPath = join(SCRIPTS_DIR, "depth-warm-bastrop-downtown-drill.mjs");
    const source = readFileSync(drillPath, "utf8");
    expect(source.includes("depth-warm-bastrop-batch.mjs")).toBe(false);
    expect(source.includes("depth-warm-city-batch.mjs")).toBe(true);
  });
});
