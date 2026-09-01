#!/usr/bin/env node
/**
 * Derived Bastrop estimate from CAD-SERVE aggregates — NOT a substitute for live proof.
 * BUG THIS CORRECTS: never scale unincorporated counts from geometry total onto cad roll.
 */

import { readFileSync, writeFileSync } from "node:fs";

import {
  PARCEL_RECORD_RAIL_COUNT,
  RAILS_ADDED_BEYOND_SEED,
  UNINCORPORATED_NOT_APPLICABLE_RAIL_KEYS,
} from "../src/parcel-record/index.ts";

const table = JSON.parse(
  readFileSync("P:/doc_repo/_inbox/2026-09-01_cad-serve-reconcile_table.json", "utf8"),
);
const row = table.cad_property.rows.find((r) => r.fips === "48021");
/** Measured containment — do NOT scale to n_parcels. */
const measuredUnincorporated = 50_264;

const n = row.n_parcels;
const rails = PARCEL_RECORD_RAIL_COUNT;
const naRails = UNINCORPORATED_NOT_APPLICABLE_RAIL_KEYS.length;
const totalCells = n * rails;

/** CAD scalar cells movable from aggregate rates (upper bound). */
let cadCellsMovedEstimate = 0;
cadCellsMovedEstimate += n; // apn
cadCellsMovedEstimate += row.situs_p + row.city_p + row.zip_p + row.legal_p;
cadCellsMovedEstimate += row.exempt_nn + row.use_p * 2 + row.land_nn + row.imp_nn;
cadCellsMovedEstimate += row.mkt_nn + row.ass_nn + row.yb_p + row.la_pos_p + row.ac_p * 2;

/** Correct not-applicable: measured unincorporated × rails only (if all cad parcels had incorporation measured). */
const notApplicableIfAllCadHadIncorpMeasure = measuredUnincorporated * naRails;

/** Prior bug: scaled unincorporated to full cad roll. */
const scaledUninc = Math.round((measuredUnincorporated / 62_256) * n);
const priorBugNotApplicable = scaledUninc * 17;

const payload = {
  kind: "parcel-record-derived-estimate-only",
  at: new Date().toISOString(),
  warning: "Aggregate derivation — compare to live prove-parcel-record-county.mjs output",
  countyFips: "48021",
  parcelCountCad: n,
  measuredUnincorporatedParcels: measuredUnincorporated,
  notApplicableRailCount: naRails,
  derivedCadCellsMovedEstimate: cadCellsMovedEstimate,
  derivedNotApplicableCorrect: notApplicableIfAllCadHadIncorpMeasure,
  priorBug: {
    scaledUnincorporatedParcels: scaledUninc,
    notApplicableCells: priorBugNotApplicable,
    error: "Scaled 50264/62256 onto 77799 cad roll — invented ~12.5k unincorporated stamps",
  },
  railsAddedBeyondSeed: RAILS_ADDED_BEYOND_SEED,
};

const out =
  process.argv[2] ?? "P:/doc_repo/_inbox/2026-09-01_parcel-record_bastrop_derived.json";
writeFileSync(out, JSON.stringify(payload, null, 2));
console.log(JSON.stringify({ out, derivedCadCellsMovedEstimate: cadCellsMovedEstimate }, null, 2));
