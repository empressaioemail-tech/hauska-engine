// The statewide THREE-LAYER audit.
//
// The serving sweep answers "what does Smart Site SERVE a human". This answers
// the two questions either side of it — "what is WRITTEN in the store" and
// "what is SCORED in the ledger" — and reports the three side by side, because
// the divergences between them ARE the defect list and each divergence names a
// different remediation.
//
// `types.ts` is a BYTE-FOR-BYTE copy of the record at
// `doc_repo/_catalog/parcel_fact_sheet_contract/three-layer-audit.ts`, with the
// single edit being the import specifier for the frozen serving-sweep record.
// Do not edit it here. An invariant is disputed by stopping and reporting.

export * from "./types.js";
export * from "./classify.js";
