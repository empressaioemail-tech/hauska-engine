/**
 * Audit corpus snapshot atoms against @hauska/atom-contract@1.5.0 conformance.
 *
 * Usage: pnpm --filter @hauska-engine/corpus run audit:snapshot [path]
 */

import fs from "node:fs";
import { validateAtomConformance } from "@hauska/atom-contract/conformance";

const CORPUS_FAMILIES = [
  "code-section",
  "code-cross-reference",
  "code-edition",
  "code-amendment",
  "code-definition",
  "jurisdiction-corpus",
];

const path =
  process.argv[2] ?? "../../services/retrieval-api/corpus/snapshot.json";
const snap = JSON.parse(fs.readFileSync(path, "utf8"));

const matrix = {};
for (const family of CORPUS_FAMILIES) {
  matrix[family] = {
    count: 0,
    readContract: 0,
    accessPolicy: 0,
    signedHistory: 0,
    verifyChainOk: 0,
    consequenceInputs: 0,
    conformant: 0,
    sampleErrors: [],
  };
}

for (const atom of snap.atoms) {
  const row = matrix[atom.entityType];
  if (!row) continue;
  row.count += 1;
  if (atom.readContract) row.readContract += 1;
  if (atom.accessPolicy) row.accessPolicy += 1;
  if (atom.signedHistory) row.signedHistory += 1;
  if (atom.signedHistory?.verifyChain?.ok) row.verifyChainOk += 1;
  if (atom.consequenceInputs) row.consequenceInputs += 1;

  const result = validateAtomConformance({
    tier: "data",
    readContract: atom.readContract,
    accessPolicy: atom.accessPolicy ?? "public-free",
    signedHistory: atom.signedHistory,
  });
  if (result.ok) {
    row.conformant += 1;
  } else if (row.sampleErrors.length < 3) {
    row.sampleErrors.push({
      entityId: atom.entityId,
      errors: result.errors.map((e) => e.code),
    });
  }
}

console.log(
  JSON.stringify(
    {
      snapshot: path,
      generatedAt: snap.generatedAt,
      atomCount: snap.atoms.length,
      conformanceMatrix: matrix,
      allConformant: Object.values(matrix).every(
        (r) => r.count === 0 || r.conformant === r.count,
      ),
    },
    null,
    2,
  ),
);
