// The statewide serving sweep.
//
// The County Manifest answers "did a writer run for this county". This answers
// "what does Smart Site actually SERVE a human, for every parcel in this
// county". The two disagree, and the disagreement is the finding.
//
// `types.ts` is a BYTE-FOR-BYTE copy of the record frozen by the planner at
// `doc_repo/_catalog/parcel_fact_sheet_contract/serving-sweep.ts` on
// 2026-08-18. Do not edit it here. An invariant is disputed by stopping and
// reporting, never by editing the contract inside a lane.
//
// The sweep never samples. Sampling is what certified a broken Bastrop once.

export * from "./types.js";
export * from "./chain-assembly.js";
export * from "./bff-flow.js";
export * from "./project-sheet.js";
export * from "./tally.js";
