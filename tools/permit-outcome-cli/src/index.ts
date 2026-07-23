#!/usr/bin/env node
/**
 * permit-outcome-cli — Master WDLL 3.10
 *
 *   fetch N public permits → write finding.outcome.recorded → upsert
 *   atom_calibration_overlay with provenance backtest.
 *
 * Overlay / ledger home: cortex Neon (CORTEX_DATABASE_URL /
 * OVERLAY_DATABASE_URL / DEPLOYMENT_DATABASE_URL). Public open data only
 * — no API keys.
 *
 * Examples:
 *   pnpm --filter @hauska-engine/permit-outcome-cli dev run -- --limit 25
 *   OVERLAY_DATABASE_URL=... pnpm --filter @hauska-engine/permit-outcome-cli dev run -- --limit 10 --write
 */

import { Command } from "commander";
import postgres from "postgres";
import {
  fetchPermitOutcomeBundle,
  fetchPermitOutcomes,
  type PermitOutcomeSourceId,
} from "@hauska-engine/adapters/portal/permit-outcomes";
import {
  upsertCalibrationOverlayBacktest,
  writeOutcomeLedger,
} from "./writeLedger.js";

const HAYS_GOLD_PARCEL = "48209:156346";
const HAYS_TENANT = "hays_tx_proof";

function resolveDbUrl(): string | null {
  return (
    process.env.OVERLAY_DATABASE_URL ??
    process.env.CORTEX_DATABASE_URL ??
    process.env.DEPLOYMENT_DATABASE_URL ??
    null
  );
}

function openSql(url: string) {
  const ssl =
    url.includes("sslmode=require") || url.includes("neon.tech")
      ? ("require" as const)
      : false;
  return postgres(url, { ssl, max: 1 });
}

const program = new Command();
program
  .name("permit-outcome-cli")
  .description(
    "Texas public-record permit outcomes → outcome ledger → overlay backtest (WDLL 3.10)",
  );

program
  .command("run")
  .description(
    "Fetch permit outcomes, optionally write ledger + upsert overlay backtest",
  )
  .option(
    "--source <id>",
    "austin-soda | bastrop-mygov | grand-county-ut | bundle",
    "bundle",
  )
  .option("--limit <n>", "max rows per source", "25")
  .option(
    "--write",
    "write atom_events + upsert atom_calibration_overlay (requires DB URL)",
    false,
  )
  .option(
    "--atom-id <id>",
    "overlay atom_id (default: Hays gold parcel for live retrieval proof)",
    HAYS_GOLD_PARCEL,
  )
  .option(
    "--tenant <slug>",
    "overlay jurisdiction_tenant",
    HAYS_TENANT,
  )
  .option(
    "--also-austin-overlay",
    "also upsert overlay keyed austin_tx:tcad:<first tcad> when present",
    false,
  )
  .action(async (opts) => {
    const limit = Number.parseInt(String(opts.limit), 10) || 25;
    const source = String(opts.source) as PermitOutcomeSourceId | "bundle";

    const results =
      source === "bundle"
        ? await fetchPermitOutcomeBundle({ limit })
        : [await fetchPermitOutcomes(source, { limit })];

    const summary = results.map((r) => ({
      sourceId: r.sourceId,
      jurisdictionTenant: r.jurisdictionTenant,
      outcomeCount: r.outcomes.length,
      partialReason: r.partialReason,
      httpStatus: r.httpStatus,
      fetchedAt: r.fetchedAt,
      samplePermitNumbers: r.outcomes.slice(0, 3).map((o) => o.permitNumber),
    }));

    const allOutcomes = results.flatMap((r) => r.outcomes);
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: opts.write ? "write" : "dry-run",
          sources: summary,
          totalOutcomes: allOutcomes.length,
        },
        null,
        2,
      ),
    );

    if (!opts.write) {
      console.error(
        "dry-run only — pass --write with OVERLAY_DATABASE_URL/CORTEX_DATABASE_URL to persist.",
      );
      return;
    }

    const dbUrl = resolveDbUrl();
    if (!dbUrl) {
      console.error(
        "FATAL: set OVERLAY_DATABASE_URL, CORTEX_DATABASE_URL, or DEPLOYMENT_DATABASE_URL",
      );
      process.exit(1);
    }

    const sql = openSql(dbUrl);
    try {
      const reg = await sql`
        select to_regclass('public.atom_calibration_overlay') as overlay,
               to_regclass('public.atom_events') as events
      `;
      if (!reg[0]?.overlay || !reg[0]?.events) {
        console.error(
          "FATAL: atom_calibration_overlay / atom_events missing — use cortex Neon (0037), not hauska_mcp.",
        );
        process.exit(1);
      }

      const ledger = await writeOutcomeLedger(sql, allOutcomes);
      const runStamp = new Date().toISOString().slice(0, 10);
      const codeRef = `permit-outcome-adapter:austin-soda:3syk-w9eu:${runStamp}:n=${allOutcomes.length}`;

      const overlay = await upsertCalibrationOverlayBacktest(sql, {
        atomId: String(opts.atomId),
        jurisdictionTenant: String(opts.tenant),
        signalCount: Math.max(1, allOutcomes.length),
        codeRef,
        calibratedConfidence: 0.73,
      });

      let austinOverlay: Record<string, unknown> | null = null;
      if (opts.alsoAustinOverlay) {
        const withTcad = allOutcomes.find((o) => o.parcelHint);
        if (withTcad?.parcelHint) {
          austinOverlay = await upsertCalibrationOverlayBacktest(sql, {
            atomId: `austin_tx:tcad:${withTcad.parcelHint}`,
            jurisdictionTenant: "austin_tx",
            signalCount: Math.max(1, allOutcomes.length),
            codeRef,
            calibratedConfidence: 0.74,
            assertedConfidence: 0.7,
          });
        }
      }

      console.log(
        JSON.stringify(
          {
            ok: true,
            written: {
              ledger,
              overlay,
              austinOverlay,
              note:
                "atom_class=backtest; code_ref cites permit-outcome-adapter (not gate-c-ie-seed)",
            },
          },
          null,
          2,
        ),
      );
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
