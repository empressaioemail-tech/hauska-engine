#!/usr/bin/env node
/**
 * write-setback-city.mjs — city-scoped `setback` writer (F-11).
 *
 * Counties do not zone unincorporated land. The chain is edges from
 * setback-rule from zoning district from the city layer from the
 * incorporated city. Apply is held on this card (SETBACK_APPLY_HELD).
 *
 *   SETBACK_PATH=1 \
 *     pnpm --filter @hauska-engine/engine-core run write-setback-city -- \
 *       --county=48021 --city=elgin-tx [--fixture=parcels.json] [--run-id=...]
 *
 * Dry-run / plan is the only path this card may take.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  PARCEL_SOURCE_REQUIRED,
  SETBACK_APPLY_HELD,
  SetbackWriterRefuseError,
  planCitySetback,
  planConformantChunks,
  resolveSetbackCityBinding,
} from "../src/setback-writer/index.ts";
import { APPLY_LEASE_MESSAGE } from "./writer-apply-lease.mjs";

export const SETBACK_PATH_REQUIRED = "SETBACK_PATH_REQUIRED";

export function parseSetbackWriterArgs(argv) {
  const out = {
    county: null,
    city: null,
    apply: false,
    fixture: null,
    out: null,
    runId: null,
    chunkSize: 500,
    limit: 0,
    tableProbed: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--county") out.county = String(argv[++i] ?? "").trim() || null;
    else if (a.startsWith("--county=")) out.county = a.slice("--county=".length).trim() || null;
    else if (a === "--city") out.city = String(argv[++i] ?? "").trim() || null;
    else if (a.startsWith("--city=")) out.city = a.slice("--city=".length).trim() || null;
    else if (a === "--apply") out.apply = true;
    else if (a === "--probed") out.tableProbed = true;
    else if (a === "--fixture") out.fixture = String(argv[++i] ?? "").trim() || null;
    else if (a.startsWith("--fixture=")) out.fixture = a.slice("--fixture=".length).trim() || null;
    else if (a === "--out") out.out = String(argv[++i] ?? "").trim() || null;
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length).trim() || null;
    else if (a === "--run-id") out.runId = String(argv[++i] ?? "").trim() || null;
    else if (a.startsWith("--run-id=")) out.runId = a.slice("--run-id=".length).trim() || null;
    else if (a === "--chunk-size") out.chunkSize = Number(argv[++i] || 500);
    else if (a.startsWith("--chunk-size=")) out.chunkSize = Number(a.slice("--chunk-size=".length));
    else if (a === "--limit") out.limit = Number(argv[++i] || 0);
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length));
  }
  return out;
}

export function requireSetbackPath(env = process.env) {
  if (env.SETBACK_PATH !== "1") {
    const err = new SetbackWriterRefuseError(SETBACK_PATH_REQUIRED, {
      reason: "SETBACK_PATH=1 required (guards against an accidental invocation)",
    });
    throw err;
  }
}

function loadFixtureParcels(fixturePath, limit) {
  const raw = JSON.parse(readFileSync(fixturePath, "utf8"));
  const parcels = Array.isArray(raw) ? raw : raw.parcels;
  if (!Array.isArray(parcels)) {
    throw new SetbackWriterRefuseError(PARCEL_SOURCE_REQUIRED, {
      reason: "fixture must be an array or { parcels: [] }",
    });
  }
  return limit > 0 ? parcels.slice(0, limit) : parcels;
}

export function runSetbackWriter(argv, env = process.env) {
  requireSetbackPath(env);
  const args = parseSetbackWriterArgs(argv);
  if (args.apply && !args.runId) {
    throw new SetbackWriterRefuseError("LEASE_REQUIRED", {
      message: APPLY_LEASE_MESSAGE,
    });
  }
  if (args.apply) {
    throw new SetbackWriterRefuseError(SETBACK_APPLY_HELD, {
      reason: "F-11 apply is held; dry-run / plan / refuse only",
    });
  }
  resolveSetbackCityBinding(args.city, args.county);
  if (!args.fixture) {
    throw new SetbackWriterRefuseError(PARCEL_SOURCE_REQUIRED, {
      reason: "dry-run requires --fixture (live parcel load not invoked on this card)",
    });
  }
  const parcels = loadFixtureParcels(args.fixture, args.limit);
  const plan = planCitySetback({
    countyFips: args.county,
    cityKey: args.city,
    parcels,
    tableProbed: args.tableProbed,
  });
  const chunks = planConformantChunks(plan, {
    chunkSize: args.chunkSize,
    runId: args.runId,
  });
  return {
    event: "setback-city.dry-run",
    mode: "dry-run",
    county: plan.countyFips,
    cityKey: plan.cityKey,
    binding: {
      cityKey: plan.binding.cityKey,
      counties: plan.binding.counties,
      tableLanded: plan.binding.tableLanded,
      namedSource: plan.binding.namedSource,
      derivations: plan.binding.derivations,
    },
    plan: {
      parcelsRead: plan.planned.length,
      ...plan.counts,
    },
    chunks: chunks.map((c) => ({
      index: c.index,
      rows: c.runEvent.rows,
      runEvent: c.runEvent,
      links: c.links.length,
      leaseLock: c.leaseLock,
    })),
    sample: plan.planned.slice(0, 5),
  };
}

function printRefuse(err) {
  const code = err.code || err.message;
  console.error(
    JSON.stringify({
      event: "setback-city.refused",
      code,
      ...(err.details ?? {}),
    }),
  );
}

async function main() {
  try {
    const argv = process.argv.slice(2);
    const summary = runSetbackWriter(argv, process.env);
    console.log(JSON.stringify(summary, null, 2));
    const args = parseSetbackWriterArgs(argv);
    if (args.out) writeFileSync(args.out, JSON.stringify(summary, null, 2));
  } catch (err) {
    printRefuse(err);
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
