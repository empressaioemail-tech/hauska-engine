/**
 * Re-mint a committed corpus snapshot through the conformance mint path.
 *
 * Applies the same `stampCorpusAtomConformance` used at atomization time so
 * atoms are born-correct without in-place DB migration. Preserves atom
 * identity and content hashes from the prior snapshot; replaces the
 * conformance envelope (readContract, accessPolicy, signedHistory).
 *
 * Usage: pnpm --filter @hauska-engine/corpus run remint:snapshot [in] [out]
 */

import fs from "node:fs";

import type { AccessPolicy, CodeAtomInstance } from "@hauska-engine/atoms";
import { CORPUS_SNAPSHOT_FORMAT } from "@hauska-engine/storage";

import { stampCorpusAtomConformance } from "../src/conformance/mint.js";

const inputPath =
  process.argv[2] ?? "../../services/retrieval-api/corpus/snapshot.json";
const outputPath =
  process.argv[3] ?? "../../services/retrieval-api/corpus/snapshot.json";

const snap = JSON.parse(fs.readFileSync(inputPath, "utf8"));

const policyByTenant = new Map<string, AccessPolicy>();
for (const row of snap.jurisdictionStatus ?? []) {
  policyByTenant.set(
    row.jurisdictionTenant,
    row.accessPolicy ?? "public-free",
  );
}

function policyFor(atom: CodeAtomInstance): AccessPolicy {
  if (atom.accessPolicy) return atom.accessPolicy;
  return policyByTenant.get(atom.jurisdictionTenant) ?? "public-free";
}

const remintedAtoms = snap.atoms.map((atom: CodeAtomInstance) => {
  const stripped = { ...atom };
  delete (stripped as { readContract?: unknown }).readContract;
  delete (stripped as { signedHistory?: unknown }).signedHistory;
  return stampCorpusAtomConformance(stripped, policyFor(atom));
});

const reminted = {
  format: CORPUS_SNAPSHOT_FORMAT,
  generatedAt: new Date().toISOString(),
  provenance: [
    ...(snap.provenance ?? []),
    `remint-conformance:${snap.generatedAt}`,
  ],
  atoms: remintedAtoms,
  links: snap.links,
  jurisdictionStatus: (snap.jurisdictionStatus ?? []).map(
    (row: { jurisdictionTenant: string; accessPolicy?: AccessPolicy }) => ({
      ...row,
      accessPolicy: row.accessPolicy ?? policyByTenant.get(row.jurisdictionTenant) ?? "public-free",
      lastRefreshedAt: new Date().toISOString(),
    }),
  ),
};

fs.writeFileSync(outputPath, JSON.stringify(reminted));
console.log(
  JSON.stringify(
    {
      input: inputPath,
      output: outputPath,
      priorGeneratedAt: snap.generatedAt,
      remintedAt: reminted.generatedAt,
      atomCount: reminted.atoms.length,
    },
    null,
    2,
  ),
);
