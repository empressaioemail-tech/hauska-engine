/**
 * P-167 (OPS-23 R-6) — the local buildable/setback display vocabulary copy
 * stays retired in engine-core.
 *
 * Before this row, `buildable-display-vocab.ts` was one of five byte-
 * identical hand-synced copies of this vocabulary (hauska-map, and a second
 * copy in this repo's own retrieval/serving-sweep vendor tree), locked
 * together by a parity fixture + lock file this directory also carried. All
 * of that is deleted; the vocabulary now lives once, in
 * `@empressaio/atom-contract/display` (`site-model.ts` and `index.ts`
 * import `mapBuildableDisplay` from there). This test fails if any of those
 * shapes reappears under this directory.
 *
 * POSITIVE CONTROL: a scan that only ever reports "not found" cannot be
 * told apart from one whose directory read went blind. This test also
 * asserts the directory holds other files and that both known importers
 * actually import from the package — if either assertion cannot be made,
 * the test fails loudly rather than reporting a false pass.
 *
 * Self-test in both directions: this suite runs against the real tree
 * (expects clean) and against a synthetic tree that reintroduces the
 * retired module (expects a named failure), so the guard is proven able to
 * fire, not just able to pass.
 */
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SITE_PLAN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_IMPORT = "@empressaio/atom-contract/display";
const RETIRED_NAME_PATTERN = /^buildable-display-vocab(\..*)?\.[cm]?[jt]sx?$/;
const LIVE_IMPORTERS = ["site-model.ts", "index.ts"];

/** @returns violation strings; empty means clean. */
function checkRetired(siteDir: string): string[] {
  const violations: string[] = [];

  if (!existsSync(siteDir)) {
    return [`POSITIVE CONTROL FAILED: ${siteDir} does not exist.`];
  }
  const files = readdirSync(siteDir);
  const otherFiles = files.filter((f) => !RETIRED_NAME_PATTERN.test(f));
  if (otherFiles.length === 0) {
    violations.push(
      "POSITIVE CONTROL FAILED: the site-plan directory holds no file other than ones matching the retired pattern.",
    );
  }
  for (const f of files) {
    if (RETIRED_NAME_PATTERN.test(f)) {
      violations.push(`RETIRED VOCAB COPY REINTRODUCED: ${f} exists in ${siteDir}.`);
    }
  }

  const fixturesDir = join(siteDir, "__fixtures__");
  if (existsSync(fixturesDir)) {
    for (const f of readdirSync(fixturesDir)) {
      if (/^buildable-display-vocab\.(peer\.fixture|parity\.lock\.json)$/.test(f)) {
        violations.push(`RETIRED PARITY ARTEFACT REINTRODUCED: __fixtures__/${f} exists in ${siteDir}.`);
      }
    }
  }

  for (const importer of LIVE_IMPORTERS) {
    const p = join(siteDir, importer);
    if (!existsSync(p)) {
      violations.push(`POSITIVE CONTROL FAILED: ${importer} does not exist in ${siteDir}.`);
      continue;
    }
    const src = readFileSync(p, "utf8");
    const importsPackage = src.includes(PACKAGE_IMPORT);
    const importsLocalCopy = /from\s+["']\.\/buildable-display-vocab\.js["']/.test(src);
    if (importsLocalCopy) {
      violations.push(`RETIRED IMPORT REINTRODUCED: ${importer} imports from "./buildable-display-vocab.js".`);
    } else if (!importsPackage) {
      violations.push(
        `POSITIVE CONTROL FAILED: ${importer} imports mapBuildableDisplay from neither the retired local copy nor ${PACKAGE_IMPORT}.`,
      );
    }
  }

  return violations;
}

const made: string[] = [];
afterEach(() => {
  while (made.length) {
    try {
      rmSync(made.pop()!, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe("buildable-display-vocab retired (P-167)", () => {
  it("the real site-plan tree is clean", () => {
    expect(checkRetired(SITE_PLAN_DIR)).toEqual([]);
  });

  it("FIRES: a synthetic tree with the module reintroduced is caught", () => {
    const dir = mkdtempSync(join(tmpdir(), "p167-engine-guard-"));
    made.push(dir);
    writeFileSync(join(dir, "site-model.ts"), `import { mapBuildableDisplay } from "${PACKAGE_IMPORT}";\n`);
    writeFileSync(join(dir, "index.ts"), `export { mapBuildableDisplay } from "${PACKAGE_IMPORT}";\n`);
    writeFileSync(join(dir, "buildable-display-vocab.ts"), "export {};\n");
    const violations = checkRetired(dir);
    expect(violations.join("\n")).toMatch(/RETIRED VOCAB COPY REINTRODUCED/);
    expect(violations.join("\n")).toMatch(/buildable-display-vocab\.ts/);
  });

  it("FIRES: a synthetic tree with the parity lock reintroduced is caught", () => {
    const dir = mkdtempSync(join(tmpdir(), "p167-engine-guard-"));
    made.push(dir);
    writeFileSync(join(dir, "site-model.ts"), `import { mapBuildableDisplay } from "${PACKAGE_IMPORT}";\n`);
    writeFileSync(join(dir, "index.ts"), `export { mapBuildableDisplay } from "${PACKAGE_IMPORT}";\n`);
    mkdirSync(join(dir, "__fixtures__"));
    writeFileSync(join(dir, "__fixtures__", "buildable-display-vocab.parity.lock.json"), "{}\n");
    const violations = checkRetired(dir);
    expect(violations.join("\n")).toMatch(/RETIRED PARITY ARTEFACT REINTRODUCED/);
  });

  it("FIRES: an importer reverted to the local relative import is caught", () => {
    const dir = mkdtempSync(join(tmpdir(), "p167-engine-guard-"));
    made.push(dir);
    writeFileSync(join(dir, "site-model.ts"), `import { mapBuildableDisplay } from "./buildable-display-vocab.js";\n`);
    writeFileSync(join(dir, "index.ts"), `export { mapBuildableDisplay } from "${PACKAGE_IMPORT}";\n`);
    const violations = checkRetired(dir);
    expect(violations.join("\n")).toMatch(/RETIRED IMPORT REINTRODUCED/);
    expect(violations.join("\n")).toMatch(/site-model\.ts/);
  });

  it("its own positive control fails loudly on an empty directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "p167-engine-guard-bare-"));
    made.push(dir);
    const violations = checkRetired(dir);
    expect(violations.join("\n")).toMatch(/POSITIVE CONTROL FAILED/);
  });
});
