#!/usr/bin/env node
/**
 * P-219 retirement instrument. A comment is not a retirement.
 *
 * FAILS when production (non-test, non-fixture) source MINTS a
 * `bastrop-per-parcel/*` atom DID as the provenance of a setback value.
 * Passes on a clean tree.
 *
 * WHY THIS EXISTS. Until 2026-09-15 both PDF products for `48021:34049`
 * (1109 Pecan St, Bastrop, SF-1, a corner lot) printed:
 *
 *     Setbacks  25 / 5 / 25 ft -- source: Setback rule for SF-1 cited to
 *     bastrop-per-parcel/34049/front, cited ... ORDINANCE NO. 2019-51 ...
 *
 * five months after the City of Bastrop repealed Ordinance 2019-51 (Ord.
 * 2026-06, the B3 Code Repeal and Bastrop Development Code Adoption,
 * effective 2026-04-14). Those DIDs are minted from the city's One Click
 * join, which reads the authoritative zoning layer's NEVER-REFRESHED numeric
 * shortcut columns. See `packages/adapters/src/local/setbacks/
 * retired-setback-provenance.ts` for the retirement's full scope and its
 * deliberate exclusions.
 *
 * WHAT IT DOES NOT FORBID. Reading the layer-23 record is still correct and
 * still happens: it resolves the dominant district on a split-zone parcel
 * (R26) and it is the NAMED second source of the P-154 / A-148 conflict row.
 * A disclosure that names a source is not a served value, so a `sourceLabel`,
 * a note, or a comment mentioning the namespace does not fire. Only a mint
 * does: an `atom_did` / `atomDid` assignment under the retired namespace.
 *
 * SCOPE, AND ITS ONE EXCLUSION (DEV_PROCESS 2.0/2.1 — a permanently-red gate
 * is a dead gate, and an instrument's exclusion set is part of its contract
 * and must be stated where its output is read, so this script PRINTS the
 * exclusion on every clean run). Exactly one production file is still allowed
 * to mint these DIDs: the per-parcel record module itself. Its table is the
 * NAMED second source of the conflict row, and it remains the only value
 * author for Bastrop's per-parcel-record-only districts (MU / GC / PDD / PI /
 * IND / P-OS), which the BDC corpus deliberately carries no scalar row for.
 * Those districts are 3,788 of the 16,751 rows on layer 23 (22.6%, counting
 * prop_id grouped by ZoneTypeClass over every row in the layer, read live
 * 2026-09-15). P-219 escalated that remainder rather than flipping it to an
 * absence, because the same live read found GC's and IND's numeric columns
 * AGREE with the authoritative layer's text — retiring them would replace
 * correct values with nothing. When that escalation is resolved, delete the
 * entry from ALLOWED_MINT_FILES and this gate closes completely.
 *
 * What the gate still catches, which is the regression that matters: any
 * CONSUMER re-adopting the namespace as a value provenance.
 *
 * Self-tests BOTH directions before scanning the tree, on the real result.
 * A detector that cannot fail for the right reason is a defect, not a
 * detector (DEV_PROCESS 2.2). A timed-out or skipped self-test is a fail,
 * never a pass.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const RETIRED_PREFIX = "bastrop-per-parcel/";

/**
 * A MINT: an `atom_did` or `atomDid` key assigned a string that begins with
 * the retired namespace, whether a plain literal or a template literal
 * (`bastrop-per-parcel/${record.propId}/front` is exactly how the defect was
 * written). Matched on the assignment, never on the bare word.
 */
const MINT_RE = new RegExp(
  String.raw`atom_?[Dd]id\s*:\s*["'\`]${RETIRED_PREFIX.replace(/[/]/g, "\\/")}`,
);

/**
 * The one production file still permitted to mint, with its reason. Every
 * other file is a regression. Paths are repo-relative and forward-slashed.
 */
const ALLOWED_MINT_FILES = new Map([
  [
    "packages/adapters/src/local/setbacks/bastrop-per-parcel-record.ts",
    "second-source disclosure + the only value author for Bastrop per-parcel-record-only districts (MU/GC/PDD/PI/IND/P-OS) — escalated in the P-219 close, not yet retired",
  ],
]);

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

/** True when `text` mints a setback provenance under the retired namespace. */
export function detectsRetiredSetbackMint(text) {
  return MINT_RE.test(text);
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

export function scanRepoForRetiredMints(root = REPO_ROOT) {
  const files = [];
  walk(root, files);
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (detectsRetiredSetbackMint(text)) {
      const rel = relative(root, file).split(sep).join("/");
      if (ALLOWED_MINT_FILES.has(rel)) continue;
      hits.push(rel);
    }
  }
  return hits;
}

function selfTest() {
  // The exact shape the defect had, as a template literal.
  const poisonTemplate =
    "atom_did: `" + RETIRED_PREFIX + "${record.propId}/front`,";
  // And as a plain literal, which a hand-edit would more likely produce.
  const poisonLiteral = `atomDid: "${RETIRED_PREFIX}34049/side-corner",`;
  // The source that took over.
  const clean = `atom_did: "bastrop_tx/bdc-2026-adopted/14.02.003",`;
  // A disclosure naming the retired source is explicitly still allowed.
  const disclosure = `sourceLabel: "City of Bastrop, TX (Parcels_One_Click layer 23 per-parcel record)",`;
  const commentOnly = `// retired: ${RETIRED_PREFIX}* may not author a setback value`;

  if (!detectsRetiredSetbackMint(poisonTemplate)) {
    throw new Error("self-test FAIL: detector missed a template-literal reintroduction");
  }
  if (!detectsRetiredSetbackMint(poisonLiteral)) {
    throw new Error("self-test FAIL: detector missed a plain-literal reintroduction");
  }
  if (detectsRetiredSetbackMint(clean)) {
    throw new Error("self-test FAIL: detector fired on the ordinance-backed provenance");
  }
  if (detectsRetiredSetbackMint(disclosure)) {
    throw new Error("self-test FAIL: detector fired on a second-source disclosure");
  }
  if (detectsRetiredSetbackMint(commentOnly)) {
    throw new Error("self-test FAIL: detector fired on a comment mention");
  }
}

function main() {
  selfTest();
  const hits = scanRepoForRetiredMints();
  if (hits.length > 0) {
    console.error(
      `FATAL: retired setback provenance ${RETIRED_PREFIX}* reintroduced as a mint in:\n` +
        hits.map((h) => `  ${h}`).join("\n") +
        "\nOrdinance 2026-06 repealed the values behind that namespace on 2026-04-14 (P-219).",
    );
    process.exit(1);
  }
  const exclusions = [...ALLOWED_MINT_FILES.entries()]
    .map(([file, why]) => `  EXCLUDED ${file}\n    because: ${why}`)
    .join("\n");
  console.log(
    `retire-bastrop-per-parcel-setback-authorship: clean (self-test 5 cases both directions; ` +
      `0 unexcluded production mints of ${RETIRED_PREFIX}*).\n` +
      `Exclusion set, which is part of this instrument's contract:\n${exclusions}`,
  );
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) {
  main();
}
