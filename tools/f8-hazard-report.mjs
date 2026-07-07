#!/usr/bin/env node
/** F8 hazard report — compute edition-bump hazard rates from code-amendment atoms. */
import fs from "node:fs";

const path = process.argv[2] ?? "services/retrieval-api/corpus/snapshot.json";
const snap = JSON.parse(fs.readFileSync(path, "utf8"));

const amendments = snap.atoms.filter(
  (a) => a.entityType === "code-amendment" && a.amendmentScope === "temporal"
);
const editions = snap.atoms.filter((a) => a.entityType === "code-edition");

const editionById = new Map();
for (const ed of editions) {
  editionById.set(ed.entityId, ed);
}

const amendmentGroups = new Map();

for (const amendment of amendments) {
  const edition = Array.from(editionById.values()).find((ed) =>
    ed.amendmentIds.includes(amendment.entityId)
  );
  
  if (!edition) continue;

  let modelCodeBase = "unknown";
  const lowerLabel = edition.editionLabel.toLowerCase();
  const lowerEntityId = edition.entityId.toLowerCase();
  
  if (lowerLabel.includes("ibc") || lowerEntityId.includes("-ibc-")) {
    modelCodeBase = "IBC";
  } else if (lowerLabel.includes("irc") || lowerEntityId.includes("-irc-")) {
    modelCodeBase = "IRC";
  } else if (lowerLabel.includes("bdc") || lowerEntityId.includes("-bdc-")) {
    modelCodeBase = "BDC";
  } else if (lowerLabel.includes("land development code") || lowerLabel.includes("ldc")) {
    modelCodeBase = "LDC";
  }

  const groupKey = `${amendment.jurisdictionTenant}:${modelCodeBase}`;
  if (!amendmentGroups.has(groupKey)) {
    amendmentGroups.set(groupKey, {
      jurisdictionTenant: amendment.jurisdictionTenant,
      modelCodeBase,
      amendments: [],
      editionIds: new Set(),
    });
  }
  
  const group = amendmentGroups.get(groupKey);
  group.amendments.push(amendment);
  group.editionIds.add(edition.entityId);
}

function yearsBetween(startIso, endIso) {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 1;
  return Math.max(1, (end - start) / (365.25 * 24 * 60 * 60 * 1000));
}

function computeHazardRate(amendments, asOf = new Date().toISOString()) {
  const COLD_START_PRIOR = 0.02;
  
  if (amendments.length === 0) {
    return {
      rate: COLD_START_PRIOR,
      source: "cold-start-prior",
      amendmentCount: 0,
      observationYears: null,
    };
  }

  const dates = amendments
    .map((a) => a.effectiveDate)
    .filter((d) => typeof d === "string" && d.length > 0)
    .sort();
  const earliest = dates[0] ?? asOf;
  const observationYears = yearsBetween(earliest, asOf);
  const rawRate = amendments.length / observationYears;
  const rate = Math.max(COLD_START_PRIOR, rawRate);

  return {
    rate,
    source: "amendment-history",
    amendmentCount: amendments.length,
    observationYears: Number(observationYears.toFixed(2)),
  };
}

const results = [];
const asOf = new Date().toISOString();

for (const [groupKey, group] of amendmentGroups.entries()) {
  const hazard = computeHazardRate(group.amendments, asOf);
  results.push({
    group: groupKey,
    jurisdictionTenant: group.jurisdictionTenant,
    modelCodeBase: group.modelCodeBase,
    amendmentCount: hazard.amendmentCount,
    observationYears: hazard.observationYears,
    rate: Number(hazard.rate.toFixed(4)),
    source: hazard.source,
    editionIds: Array.from(group.editionIds).sort(),
  });
}

results.sort((a, b) => {
  const tenantCmp = a.jurisdictionTenant.localeCompare(b.jurisdictionTenant);
  if (tenantCmp !== 0) return tenantCmp;
  return a.modelCodeBase.localeCompare(b.modelCodeBase);
});

const report = {
  asOf,
  snapshotPath: path,
  totalAmendments: amendments.length,
  jurisdictionCodeBaseGroups: results,
  sectionScopedLambda: {
    rate: 0.02,
    source: "cold-start-prior",
    reason: "no ordinance-to-section mapping in Wave-4 fuel",
  },
};

console.log(JSON.stringify(report, null, 2));
