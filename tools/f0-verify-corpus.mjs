import fs from "node:fs";

const path = process.argv[2] ?? "services/retrieval-api/corpus/snapshot.json";
const raw = fs.readFileSync(path, "utf8");
const snap = JSON.parse(raw);

console.log("=== SNAPSHOT METADATA ===");
console.log(
  JSON.stringify(
    {
      format: snap.format,
      generatedAt: snap.generatedAt,
      provenance: snap.provenance,
      atomCount: snap.atoms.length,
      linkCount: snap.links.length,
      jurisdictionCount: snap.jurisdictionStatus.length,
    },
    null,
    2,
  ),
);

const byType = {};
for (const a of snap.atoms) {
  byType[a.entityType] = (byType[a.entityType] ?? 0) + 1;
}
console.log("\n=== ATOM FAMILIES (entityType counts) ===");
console.log(JSON.stringify(byType, null, 2));

const jStats = snap.jurisdictionStatus.map((j) => ({
  tenant: j.jurisdictionTenant,
  name: j.jurisdictionName,
  atomCount: j.atomCount,
  qualityBar: j.qualityBar,
  top3: j.top3Score,
  sectionNum: j.sectionNumScore,
  crossRef: j.crossRefScore,
  drift: j.driftStatus,
  currentEdition: j.currentEditionDid,
  accessPolicy: j.accessPolicy,
}));
console.log(`\n=== JURISDICTION STATUS (${jStats.length}) ===`);
console.log(JSON.stringify(jStats, null, 2));

const consequenceKeys = [
  "riskCategory",
  "risk_category",
  "occupancyGroup",
  "occupancy",
  "importanceFactor",
  "importance",
  "seismicDesignCategory",
  "consequenceClass",
  "consequence",
];
let atomsWithTypedConsequence = 0;
const sampleHits = [];
for (const a of snap.atoms) {
  const present = consequenceKeys.filter((k) => a[k] !== undefined);
  if (present.length > 0) {
    atomsWithTypedConsequence++;
    if (sampleHits.length < 5) {
      sampleHits.push({
        entityType: a.entityType,
        entityId: a.entityId,
        keys: present,
      });
    }
  }
}
console.log("\n=== F2 CONSEQUENCE METADATA SCAN (typed fields) ===");
console.log(
  JSON.stringify(
    {
      atomsWithTypedConsequenceFields: atomsWithTypedConsequence,
      sampleHits,
      scannedKeys: consequenceKeys,
    },
    null,
    2,
  ),
);

const editions = snap.atoms.filter((a) => a.entityType === "code-edition");
const amendments = snap.atoms.filter((a) => a.entityType === "code-amendment");
const temporalAmend = amendments.filter((a) => a.amendmentScope === "temporal");
const overlayAmend = amendments.filter(
  (a) => a.amendmentScope === "jurisdictional-overlay",
);
const editionsByJ = {};
for (const e of editions) {
  editionsByJ[e.jurisdictionTenant] = (editionsByJ[e.jurisdictionTenant] ?? 0) + 1;
}
const amendByJ = {};
for (const a of amendments) {
  amendByJ[a.jurisdictionTenant] = (amendByJ[a.jurisdictionTenant] ?? 0) + 1;
}
console.log("\n=== EDITION HISTORY + AMENDMENT DEPTH ===");
console.log(
  JSON.stringify(
    {
      totalEditions: editions.length,
      totalAmendments: amendments.length,
      temporalAmendments: temporalAmend.length,
      jurisdictionalOverlays: overlayAmend.length,
      editionsPerJurisdiction: editionsByJ,
      amendmentsPerJurisdiction: amendByJ,
      editionSample: editions.slice(0, 3).map((e) => ({
        entityId: e.entityId,
        jurisdictionTenant: e.jurisdictionTenant,
        editionLabel: e.editionLabel,
        effectiveFrom: e.effectiveFrom,
        effectiveTo: e.effectiveTo,
        sectionCount: e.sectionIds?.length ?? 0,
        amendmentCount: e.amendmentIds?.length ?? 0,
      })),
      amendmentSample: amendments.slice(0, 3).map((a) => ({
        entityId: a.entityId,
        amendmentScope: a.amendmentScope,
        affectedSectionCount: a.affectedSectionIds?.length ?? 0,
        effectiveDate: a.effectiveDate,
      })),
    },
    null,
    2,
  ),
);

const linkTypes = {};
for (const l of snap.links) {
  linkTypes[l.linkType] = (linkTypes[l.linkType] ?? 0) + 1;
}
console.log("\n=== LINK TYPE DISTRIBUTION ===");
console.log(JSON.stringify(linkTypes, null, 2));

let asceMentions = 0;
let ibcMentions = 0;
let riskCatMentions = 0;
for (const a of snap.atoms) {
  const text = (
    a.bodyText ??
    a.definitionText ??
    a.amendmentText ??
    ""
  ).toLowerCase();
  if (text.includes("asce")) asceMentions++;
  if (text.includes("ibc") || text.includes("international building code"))
    ibcMentions++;
  if (text.includes("risk category")) riskCatMentions++;
}
console.log("\n=== PROSE MENTIONS (not typed metadata) ===");
console.log(
  JSON.stringify({ asceMentions, ibcMentions, riskCategoryProseMentions: riskCatMentions }, null, 2),
);

// F2 Wave 2 — inline parse coverage (mirrors @hauska-engine/corpus/consequence/parse.ts)
const ASCE7 = /risk\s+categor(?:y|ies)\s*(?:of\s*)?(I{1,3}|IV)\b/gi;
const IBC_OCC = /occupancy\s+group[s]?\s+([A-Z](?:-\d+)?)/gi;
const IBC_IMP = /importance\s+factor[s]?\s*(?:of\s*)?(1\.0|1\.00|1\.25|1\.5|1\.50)\b/gi;
let f2Any = 0;
let f2Asce = 0;
let f2Occ = 0;
let f2Imp = 0;
for (const a of snap.atoms) {
  if (a.entityType !== "code-section") continue;
  const text = a.bodyText ?? "";
  ASCE7.lastIndex = 0;
  IBC_OCC.lastIndex = 0;
  IBC_IMP.lastIndex = 0;
  const hasAsce = ASCE7.test(text);
  const hasOcc = IBC_OCC.test(text);
  const hasImp = IBC_IMP.test(text);
  if (!hasAsce && !hasOcc && !hasImp) continue;
  f2Any++;
  if (hasAsce) f2Asce++;
  if (hasOcc) f2Occ++;
  if (hasImp) f2Imp++;
}
console.log("\n=== F2 PARSE COVERAGE (snapshot prose → typed-field candidates) ===");
console.log(
  JSON.stringify(
    {
      totalSections: snap.atoms.filter((a) => a.entityType === "code-section").length,
      sectionsMatchingParser: f2Any,
      withAsce7RiskCategory: f2Asce,
      withIbcOccupancyGroup: f2Occ,
      withIbcImportanceFactor: f2Imp,
      note: "Committed snapshot lacks consequenceInputs until re-ingest/backfill; counts are parser matches on bodyText",
    },
    null,
    2,
  ),
);
