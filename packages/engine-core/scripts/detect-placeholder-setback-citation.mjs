#!/usr/bin/env node
/**
 * F-11 detector. A comment is not a quarantine.
 *
 * FAILS when production (non-test, non-fixture) source assigns
 * storage-port-proof/phase-1a as a setback-rule citation write
 * (atomDid / provenance / sourceCitation / atomCitation).
 *
 * Does NOT fire on the code-section proof atom (Gate A /
 * write-storage-port-proof / storage-port-proof.ts). That DID must
 * keep serving. Scope is citing setback-rule rows, not the cited
 * code-section.
 *
 * A source-text scan does not cover the runbook remint of the
 * code-section. Reminting the proof atom does not remint the citing
 * setback-rule rows. That gap is declared, not closed by weakening Gate A.
 *
 * Self-tests both directions before scanning the tree. A timed-out or
 * skipped self-test is a fail, never a pass.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PLACEHOLDER = "storage-port-proof/phase-1a";
const WRITE_RE = new RegExp(
  String.raw`(?:atomDid|provenance|sourceCitation|atomCitation)\s*:\s*["'\`][^"'\`]*${PLACEHOLDER}[^"'\`]*["'\`]`,
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
 * True when `text` contains a writer assignment of the placeholder DID
 * as a setback-rule citation. Const definitions of the code-section DID
 * and comment mentions do not fire.
 */
export function detectsPlaceholderSetbackCitation(text) {
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

export function scanRepoForPlaceholderSetbackCitations(root = REPO_ROOT) {
  const files = [];
  walk(root, files);
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (detectsPlaceholderSetbackCitation(text)) {
      hits.push(relative(root, file).split(sep).join("/"));
    }
  }
  return hits;
}

function selfTest() {
  const poison = `sourceCodeAtomRef: { atomDid: "did:hauska:code-section:${PLACEHOLDER}" }`;
  const clean = `sourceCodeAtomRef: { atomDid: "did:hauska:code-section:bdc:14.02.003" }`;
  const commentOnly = `// do not cite ${PLACEHOLDER} on a setback-rule`;
  const allowedProof = `export const STORAGE_PORT_PROOF_ATOM_DID = "did:hauska:code-section:${PLACEHOLDER}";`;
  if (!detectsPlaceholderSetbackCitation(poison)) {
    throw new Error("self-test FAIL: detector missed a deliberate setback-rule citation");
  }
  if (detectsPlaceholderSetbackCitation(clean)) {
    throw new Error("self-test FAIL: detector fired on a layer-23 Bastrop DID");
  }
  if (detectsPlaceholderSetbackCitation(commentOnly)) {
    throw new Error("self-test FAIL: detector fired on a comment mention");
  }
  if (detectsPlaceholderSetbackCitation(allowedProof)) {
    throw new Error("self-test FAIL: detector fired on the Gate A code-section const");
  }
}

function main() {
  selfTest();
  const hits = scanRepoForPlaceholderSetbackCitations();
  if (hits.length > 0) {
    console.error(
      `FATAL: placeholder ${PLACEHOLDER} reintroduced as a setback-rule citation write in:\n` +
        hits.map((h) => `  ${h}`).join("\n"),
    );
    process.exit(1);
  }
  console.log(
    `detect-placeholder-setback-citation: clean (self-test both directions; 0 production setback-rule citations of ${PLACEHOLDER})`,
  );
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) {
  main();
}
