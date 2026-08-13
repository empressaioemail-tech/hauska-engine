#!/usr/bin/env node
/**
 * atoms-writer-lease.mjs — take / heartbeat / release / status the
 * database-enforced bulk-writer lease (OPS-16 A-012).
 *
 *   DATABASE_URL=... node packages/storage/scripts/atoms-writer-lease.mjs take --holder=L16
 *   DATABASE_URL=... node packages/storage/scripts/atoms-writer-lease.mjs heartbeat --holder=L16
 *   DATABASE_URL=... node packages/storage/scripts/atoms-writer-lease.mjs release --holder=L16
 *   DATABASE_URL=... node packages/storage/scripts/atoms-writer-lease.mjs status
 */

import postgres from "postgres";

import {
  assertAndHeartbeatWriterLease,
  readWriterLease,
  releaseWriterLease,
  takeWriterLease,
} from "../src/atoms-writer-lease.ts";

function parseArgs(argv) {
  const out = { cmd: null, holder: null, ttlSec: 3600 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--holder") out.holder = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--holder=")) out.holder = a.slice("--holder=".length).trim() || null;
    else if (a === "--ttl-sec") out.ttlSec = Number(argv[++i] || 3600);
    else if (a.startsWith("--ttl-sec=")) out.ttlSec = Number(a.slice("--ttl-sec=".length));
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

const holder = args.holder || process.env.ATOMS_WRITER_LEASE_HOLDER?.trim() || null;
const ttlMs = Math.max(1, Math.floor(args.ttlSec * 1000));

try {
  let result;
  if (args.cmd === "take") {
    if (!holder) {
      console.error("FATAL: --holder or ATOMS_WRITER_LEASE_HOLDER required for take.");
      process.exitCode = 1;
    } else {
      result = await takeWriterLease(sql, { holder, ttlMs });
      console.log(JSON.stringify({ event: "atoms-writer-lease.taken", ...result }, null, 2));
    }
  } else if (args.cmd === "heartbeat") {
    if (!holder) {
      console.error("FATAL: --holder or ATOMS_WRITER_LEASE_HOLDER required for heartbeat.");
      process.exitCode = 1;
    } else {
      result = await assertAndHeartbeatWriterLease(sql, { holder, ttlMs });
      console.log(JSON.stringify({ event: "atoms-writer-lease.heartbeat", ...result }, null, 2));
    }
  } else if (args.cmd === "release") {
    if (!holder) {
      console.error("FATAL: --holder or ATOMS_WRITER_LEASE_HOLDER required for release.");
      process.exitCode = 1;
    } else {
      result = await releaseWriterLease(sql, { holder });
      console.log(JSON.stringify({ event: "atoms-writer-lease.released", ...result }, null, 2));
    }
  } else if (args.cmd === "status") {
    result = await readWriterLease(sql);
    console.log(
      JSON.stringify(
        { event: "atoms-writer-lease.status", lease: result, now: new Date().toISOString() },
        null,
        2,
      ),
    );
  } else {
    console.error("FATAL: command must be take|heartbeat|release|status.");
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
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}
