#!/usr/bin/env tsx
/** F2 coverage — parse consequence inputs across a corpus snapshot. */
import fs from "node:fs";

import { parseConsequenceInputsFromProse } from "@hauska-engine/corpus/consequence";

const path = process.argv[2] ?? "services/retrieval-api/corpus/snapshot.json";
const snap = JSON.parse(fs.readFileSync(path, "utf8"));
const sections = snap.atoms.filter(
  (a: { entityType: string }) => a.entityType === "code-section",
);

let asce = 0;
let ibcOcc = 0;
let ibcImp = 0;
let any = 0;
const samples: unknown[] = [];

for (const s of sections) {
  const inputs = parseConsequenceInputsFromProse(s.bodyText ?? "");
  if (!inputs) continue;
  any++;
  if (inputs.asce7RiskCategories?.length) asce++;
  if (inputs.ibcOccupancyGroups?.length) ibcOcc++;
  if (inputs.ibcImportanceFactors?.length) ibcImp++;
  if (samples.length < 3) {
    samples.push({
      entityId: s.entityId,
      sectionNumber: s.sectionNumber,
      consequenceInputs: inputs,
    });
  }
}

console.log(
  JSON.stringify(
    {
      totalSections: sections.length,
      sectionsWithConsequenceInputs: any,
      withAsce7RiskCategory: asce,
      withIbcOccupancyGroup: ibcOcc,
      withIbcImportanceFactor: ibcImp,
      coveragePct: Number(((any / sections.length) * 100).toFixed(2)),
      samples,
    },
    null,
    2,
  ),
);
