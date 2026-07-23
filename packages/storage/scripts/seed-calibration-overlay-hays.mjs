#!/usr/bin/env node
/**
 * seed-calibration-overlay-hays.mjs — Gate C I-E proof seed.
 *
 * Upserts one migration-0037 `atom_calibration_overlay` row keyed on the
 * Hays gold parcel node so retrieval READ can show calibratedConfidence
 * distinct from write-time asserted 0.88.
 *
 * Overlay home: cortex Neon (neondb) — NOT hauska_mcp substrate.
 *
 *   OVERLAY_DATABASE_URL='postgres://...neon.tech/neondb?sslmode=require' \
 *     node packages/storage/scripts/seed-calibration-overlay-hays.mjs
 *
 * Also accepts CORTEX_DATABASE_URL / DEPLOYMENT_DATABASE_URL.
 */

import postgres from "postgres";

const HAYS_PARCEL = "48209:156346";
const TENANT = "hays_tx_proof";
/** Distinguishable from asserted 0.88 on the envelope proof atom. */
const CALIBRATED = 0.71;
const ASSERTED = 0.88;
const SIGNAL_COUNT = 3;
/** Stashed in atom_class so PgCalibrationOverlayPort maps provenance correctly. */
const PROVENANCE = "backtest";

const url =
  process.env.OVERLAY_DATABASE_URL ??
  process.env.CORTEX_DATABASE_URL ??
  process.env.DEPLOYMENT_DATABASE_URL;

if (!url) {
  console.error(
    "FATAL: set OVERLAY_DATABASE_URL, CORTEX_DATABASE_URL, or DEPLOYMENT_DATABASE_URL (cortex Neon / neondb).",
  );
  process.exit(1);
}

const ssl =
  url.includes("sslmode=require") || url.includes("neon.tech")
    ? "require"
    : false;
const sql = postgres(url, { ssl, max: 1 });

try {
  const reg = await sql`select to_regclass('public.atom_calibration_overlay') as reg`;
  if (!reg[0]?.reg) {
    console.error(
      "FATAL: atom_calibration_overlay not found on this database. Use cortex Neon (migration 0037), not hauska_mcp.",
    );
    process.exit(1);
  }

  await sql`
    INSERT INTO atom_calibration_overlay (
      atom_id,
      jurisdiction_tenant,
      partition_kind,
      access_policy,
      asserted_confidence,
      calibrated_confidence,
      code_ref,
      edition,
      source_set_version,
      calibration_stale,
      calibration_grain,
      atom_class,
      signal_count,
      updated_at
    ) VALUES (
      ${HAYS_PARCEL},
      ${TENANT},
      'public',
      'public-free',
      ${ASSERTED},
      ${CALIBRATED},
      ${"gate-c-ie-seed:buildable-envelope"},
      ${"gate-c-proof"},
      1,
      false,
      'atom',
      ${PROVENANCE},
      ${SIGNAL_COUNT},
      now()
    )
    ON CONFLICT (atom_id, jurisdiction_tenant) DO UPDATE SET
      asserted_confidence = EXCLUDED.asserted_confidence,
      calibrated_confidence = EXCLUDED.calibrated_confidence,
      code_ref = EXCLUDED.code_ref,
      edition = EXCLUDED.edition,
      calibration_stale = EXCLUDED.calibration_stale,
      atom_class = EXCLUDED.atom_class,
      signal_count = EXCLUDED.signal_count,
      updated_at = now()
  `;

  const rows = await sql`
    SELECT
      atom_id,
      jurisdiction_tenant,
      asserted_confidence,
      calibrated_confidence,
      atom_class,
      signal_count,
      code_ref,
      calibration_stale
    FROM atom_calibration_overlay
    WHERE atom_id = ${HAYS_PARCEL}
      AND jurisdiction_tenant = ${TENANT}
  `;

  console.log(
    JSON.stringify(
      {
        ok: true,
        home: "cortex Neon atom_calibration_overlay (migration 0037)",
        seed: rows[0],
      },
      null,
      2,
    ),
  );
} finally {
  await sql.end({ timeout: 5 });
}
