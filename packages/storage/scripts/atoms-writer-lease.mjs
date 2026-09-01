#!/usr/bin/env node
/**
 * atoms-writer-lease.mjs — v2 scoped take / release / lock-check.
 *
 * v1 take|heartbeat|release|status with --holder is retired and exits 2.
 *
 *   DATABASE_URL=... node packages/storage/scripts/atoms-writer-lease.mjs \
 *     take --entity-type=cad-parcel-roll --county=48029 --label=loader --run-id=UUID
 *   DATABASE_URL=... node packages/storage/scripts/atoms-writer-lease.mjs \
 *     release --token=UUID
 */

import postgres from "postgres";

import {
  ATOMS_WRITER_LEASE_V1_RETIRED,
  releaseScopedLease,
  takeScopedLease,
  takeWriterLease,
} from "../src/atoms-writer-lease.ts";

function parseArgs(argv) {
  const out = {
    cmd: null,
    entityType: null,
    county: null,
    label: null,
    runId: null,
    token: null,
    scopeType: "write",
    database: null,
    ttlSec: 900,
    v1Holder: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--entity-type") out.entityType = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--entity-type=")) out.entityType = a.slice("--entity-type=".length).trim() || null;
    else if (a === "--county") out.county = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--county=")) out.county = a.slice("--county=".length).trim() || null;
    else if (a === "--label") out.label = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--label=")) out.label = a.slice("--label=".length).trim() || null;
    else if (a === "--run-id") out.runId = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--run-id=")) out.runId = a.slice("--run-id=".length).trim() || null;
    else if (a === "--token") out.token = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--token=")) out.token = a.slice("--token=".length).trim() || null;
    else if (a === "--scope-type") out.scopeType = String(argv[++i] || "write").trim();
    else if (a.startsWith("--scope-type=")) out.scopeType = a.slice("--scope-type=".length).trim();
    else if (a === "--database") out.database = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--database=")) out.database = a.slice("--database=".length).trim() || null;
    else if (a === "--ttl-sec") out.ttlSec = Number(argv[++i] || 900);
    else if (a.startsWith("--ttl-sec=")) out.ttlSec = Number(a.slice("--ttl-sec=".length));
    else if (a === "--holder" || a.startsWith("--holder=")) out.v1Holder = true;
    else rest.push(a);
  }
  out.cmd = rest[0] ?? null;
  return out;
}

const args = parseArgs(process.argv.slice(2));
const url = process.env.DATABASE_URL ?? process.env.SUBSTRATE_DATABASE_URL;
if (!url) {
  console.error("FATAL: DATABASE_URL / SUBSTRATE_DATABASE_URL required.");
  process.exit(1);
}

const ssl =
  url.includes("sslmode=require") || url.includes("neon.tech") ? "require" : false;
const sql = postgres(url, { ssl, max: 1 });
const ttlMs = Math.max(1, Math.floor(args.ttlSec * 1000));

try {
  if (args.v1Holder || args.cmd === "heartbeat" || args.cmd === "status") {
    await takeWriterLease();
  } else if (args.cmd === "take" && !args.entityType && !args.runId) {
    await takeWriterLease();
  } else if (args.cmd === "take") {
    const scope =
      args.scopeType === "heavy-scan"
        ? { scope_type: "heavy-scan", database: args.database ?? "hauska_mcp" }
        : {
            scope_type: "write",
            entity_type: args.entityType,
            county_fips: args.county,
          };
    const result = await takeScopedLease(sql, {
      scope,
      holder_label: args.label ?? "atoms-writer",
      run_id: args.runId,
      ttlMs,
    });
    console.log(JSON.stringify({ event: "atoms-writer-lease.taken", ...result }, null, 2));
  } else if (args.cmd === "release") {
    if (!args.token) {
      console.error("FATAL: --token required for v2 release.");
      process.exitCode = 1;
    } else {
      await releaseScopedLease(sql, {
        holder_token: args.token,
        holder_label: args.label ?? "",
        run_id: args.runId ?? "",
        scope: {
          scope_type: "write",
          entity_type: args.entityType ?? "unknown",
          county_fips: args.county ?? "00000",
        },
        expires: new Date().toISOString(),
        stolen_from: null,
      });
      console.log(JSON.stringify({ event: "atoms-writer-lease.released", token: args.token }));
    }
  } else if (args.cmd === "heartbeat" || args.cmd === "status") {
    const err = new Error("v1 writer lease is retired");
    err.code = ATOMS_WRITER_LEASE_V1_RETIRED;
    throw err;
  } else {
    console.error("FATAL: command must be take|release.");
    process.exitCode = 1;
  }
} catch (err) {
  console.error(
    JSON.stringify({
      event: "atoms-writer-lease.error",
      code: err && typeof err === "object" && "code" in err ? err.code : undefined,
      message: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exitCode = err && typeof err === "object" && err.code === ATOMS_WRITER_LEASE_V1_RETIRED ? 2 : 1;
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}
