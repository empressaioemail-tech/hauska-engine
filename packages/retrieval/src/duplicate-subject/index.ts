// The duplicate-subject reconciliation programme — lane SS-W11, PLAN-ROW P-45.
//
// A duplicate subject is one fact about one entity held in more than one
// store. This module detects them, classifies each divergence by CAUSE, and
// leaves only a residue for adjudication against ground truth.
//
// The subject registry is the ONLY hand-authored part. Everything else is
// derived from the live stores, and `--inventory --check-registry` exits 1
// when the derivation and the registry disagree.

export * from "./types.js";
export * from "./subject-registry.js";
export * from "./classify.js";
