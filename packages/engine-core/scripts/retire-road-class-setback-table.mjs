#!/usr/bin/env node
/**
 * F-11 retirement instrument. A comment is not a retirement.
 *
 * FAILS when production (non-test, non-fixture) source assigns
 * provenance "road-class-setback-table" as a write. Passes on a clean tree.
 *
 * Self-tests both directions before scanning the tree. A timed-out or
 * skipped self-test is a fail, never a pass.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const RETIRED = "road-class-setback-table";
const WRITE_RE = new RegExp(
  String.raw`provenance\s*:\s*["'\`]${RETIRED}["'\`]`,
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "coverage",
  "__tests__",
  "__fixtures__",
  "fixtures",
]);

const SKIP_FILE_RE =
  /(\.test\.|\.spec\.|__tests__|__fixtures__|\/fixtures\/|\\fixtures\\)/i;

/**
 * True when `text` contains a writer assignment of the retired provenance.
 * Mentions in comments that are not assignments do not fire — retirement is
 * the assignment, not the word.
 */
export function detectsRetiredSetbackWrite(text) {
  return WRITE_RE.test(text);
}

function shouldSkipPath(relPath) {
  const parts = relPath.split(/[/\\]/);
  if (parts.some((p) => SKIP_DIR_NAMES.has(p))) return true;
  if (SKIP_FILE_RE.test(relPath)) return true;
  if (relPath.endsWith(".json")) return true;
  if (relPath.endsWith(".md")) return true;
  return false;
}

function walk(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    const rel = relative(REPO_ROOT, full);
    if (st.isDirectory()) {
      if (SKIP_DIR_NAMES.has(name)) continue;
      if (shouldSkipPath(rel)) continue;
      walk(full, acc);
      continue;
    }
    if (!/\.(ts|js|mjs|cts|mts)$/.test(name)) continue;
    if (shouldSkipPath(rel)) continue;
    acc.push(full);
  }
}

export function scanRepoForRetiredWrites(root = REPO_ROOT) {
  const files = [];
  walk(root, files);
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (detectsRetiredSetbackWrite(text)) {
      hits.push(relative(root, file).split(sep).join("/"));
    }
  }
  return hits;
}

function selfTest() {
  const poison = `const setback = { feet: 15, provenance: "${RETIRED}" };`;
  const clean = `const setback = { feet: 15, provenance: "district-setback-table" };`;
  const commentOnly = `// retired path: ${RETIRED} must not be stamped`;
  if (!detectsRetiredSetbackWrite(poison)) {
    throw new Error("self-test FAIL: detector missed a deliberate reintroduction");
  }
  if (detectsRetiredSetbackWrite(clean)) {
    throw new Error("self-test FAIL: detector fired on a clean district stamp");
  }
  if (detectsRetiredSetbackWrite(commentOnly)) {
    throw new Error("self-test FAIL: detector fired on a comment mention");
  }
}

function main() {
  selfTest();
  const hits = scanRepoForRetiredWrites();
  if (hits.length > 0) {
    console.error(
      `FATAL: retired provenance ${RETIRED} reintroduced as a write in:\n` +
        hits.map((h) => `  ${h}`).join("\n"),
    );
    process.exit(1);
  }
  console.log(
    `retire-road-class-setback-table: clean (self-test both directions; 0 production writes of ${RETIRED})`,
  );
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) {
  main();
}
