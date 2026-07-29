/**
 * Forbidden-string gate (2026-07-28): the fixture OSM way id 123456789
 * ("Spring Street", the pilot fixture road that was once seeded into the
 * PRODUCTION store and poisoned frontage/front-edge anchors) must never
 * appear in non-test, non-fixture source. Fixtures and tests may use it;
 * production code paths, scripts, and service source may not.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const FORBIDDEN = "123456789";
/** Standalone way id only — not a digit run inside a longer token (e.g. the
 * Crockford base32 alphabet literal "0123456789ABC…"). */
const FORBIDDEN_RE = /(?<![0-9A-Za-z])123456789(?![0-9A-Za-z])/;

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".py"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage", "artifacts"]);

/** Fixture/test locations where the fixture way id is allowed. */
function isAllowedPath(path: string): boolean {
  const p = path.split(sep).join("/");
  return (
    /__tests__|__fixtures__|__snapshots__/.test(p) ||
    /\/fixtures\//.test(p) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(p)
  );
}

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("repo root (pnpm-workspace.yaml) not found");
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (st.isFile()) {
      const dot = entry.lastIndexOf(".");
      const ext = dot >= 0 ? entry.slice(dot) : "";
      if (SOURCE_EXTENSIONS.has(ext)) yield full;
    }
  }
}

describe("fixture way id 123456789 never leaks outside fixtures/tests", () => {
  it("scans packages/*/src, packages/engine-core/scripts, services/*/src, tools", () => {
    const root = repoRoot();
    const scanRoots = [
      join(root, "packages"),
      join(root, "services"),
      join(root, "tools"),
    ].filter((p) => existsSync(p));

    const offenders: string[] = [];
    for (const scanRoot of scanRoots) {
      for (const file of walk(scanRoot)) {
        if (isAllowedPath(file)) continue;
        const text = readFileSync(file, "utf8");
        if (FORBIDDEN_RE.test(text)) {
          offenders.push(file);
        }
      }
    }
    expect(offenders, `fixture way id ${FORBIDDEN} found outside fixtures/tests`).toEqual([]);
  });

  it("both Bastrop road ingest scripts carry the non-local fixture-ingest guard", () => {
    const root = repoRoot();
    for (const script of [
      "packages/engine-core/scripts/ingest-bastrop-roads-pilot.mjs",
      "packages/engine-core/scripts/ingest-bastrop-roads-overpass.mjs",
    ]) {
      const text = readFileSync(join(root, script), "utf8");
      expect(text, `${script} must refuse fixture ingest against a non-local DATABASE_URL`).toContain(
        "ALLOW_FIXTURE_INGEST",
      );
      expect(text).toContain("isLocalDatabaseUrl");
    }
  });
});
