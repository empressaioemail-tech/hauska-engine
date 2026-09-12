/**
 * atoms_writer_lease_history integration tests (P-173).
 *
 * These run against a REAL Postgres and exercise the migration's trigger,
 * not a mock -- the mock-based tests in atoms-writer-lease.test.ts can prove
 * this repo's JS issues the right statements, but only a live database can
 * prove the append-only guarantee actually holds under a violation.
 *
 * Gated on LEASE_HISTORY_IT_DATABASE_URL. Unset -> the whole suite is
 * skipped (describe.skipIf), matching DEV_PROCESS 0's own instruction: if a
 * check cannot be mechanized in this environment, say so explicitly rather
 * than pretend it ran. There is no Postgres service wired into this
 * package's `vitest run` in this repo's CI today (see close's leave_behind);
 * the trigger's actual violation proof for THIS lane's close came from a
 * live run against the STAGING atoms store (STAGING_HAUSKA_MCP_URL), pasted
 * verbatim into the close artifact, not from this file. This file exists so
 * a future CI wiring (or a local docker Postgres, per
 * 90_runbooks/cc_agent_local_test_db.md's pattern) gets the same coverage
 * mechanically instead of by re-deriving it by hand every time.
 *
 * Deliberately never points at a Neon host: same guardrail
 * cc_agent_local_test_db.md states for legacy-design-tools, restated here
 * because this file runs real DDL (a migration) plus real DML violations
 * against whatever LEASE_HISTORY_IT_DATABASE_URL names.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { releaseScopedLease, takeScopedLease } from "../atoms-writer-lease.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_URL = process.env.LEASE_HISTORY_IT_DATABASE_URL ?? "";
const isNeon = /neon\.tech/i.test(DB_URL);
const canRun = DB_URL.trim() !== "" && !isNeon;

if (DB_URL.trim() !== "" && isNeon) {
  // Fail loud, not silent: a Neon URL here is the exact mistake
  // cc_agent_local_test_db.md exists to prevent, one migration further.
  throw new Error(
    "LEASE_HISTORY_IT_DATABASE_URL resolves to a neon.tech host -- refusing to run destructive " +
      "trigger-violation tests against it. Point this at a local, disposable Postgres.",
  );
}

describe.skipIf(!canRun)("atoms_writer_lease_history trigger (live Postgres, P-173)", () => {
  const sql = canRun ? postgres(DB_URL, { max: 1 }) : (null as unknown as postgres.Sql);

  beforeAll(async () => {
    if (!canRun) return;
    const migrationPath = join(__dirname, "..", "..", "migrations", "015_atoms_writer_lease_history.sql");
    const migrationSql = await readFile(migrationPath, "utf8");
    // 011 is a prerequisite (atoms_writer_lease_v2 must exist for a real
    // take/release cycle); apply it too so this file is self-contained
    // against a bare disposable database.
    const prereqPath = join(__dirname, "..", "..", "migrations", "011_atoms_writer_lease_v2.sql");
    await sql.unsafe(await readFile(prereqPath, "utf8"));
    await sql.unsafe(migrationSql);
    // Clean slate: these tests own this table exclusively in a disposable DB.
    await sql`DELETE FROM atoms_writer_lease_v2`;
    await sql`DELETE FROM atoms_writer_lease_history`;
  });

  afterAll(async () => {
    if (canRun) await sql.end({ timeout: 5 }).catch(() => {});
  });

  it("a take followed by a release leaves exactly one history row with both timestamps", async () => {
    const scope = { scope_type: "write" as const, entity_type: "cad-parcel-roll", county_fips: "48029" };
    const runId = `it-${randomUUID()}`;
    const lease = await takeScopedLease(sql, { scope, holder_label: "it-runner", run_id: runId });
    await releaseScopedLease(sql, lease);

    const rows = await sql`
      SELECT taken_at, released_at, released_by, release_reason
        FROM atoms_writer_lease_history
       WHERE run_id = ${runId}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.taken_at).not.toBeNull();
    expect(rows[0]!.released_at).not.toBeNull();
    expect(rows[0]!.release_reason).toBe("normal");
  });

  it("a take followed by an expiry (stolen by a later take) leaves a row marked expired", async () => {
    const scope = { scope_type: "write" as const, entity_type: "cad-parcel-roll", county_fips: "48201" };
    const firstRunId = `it-expiring-${randomUUID()}`;
    const past = new Date(Date.now() - 60_000);
    await takeScopedLease(sql, {
      scope,
      holder_label: "it-runner-expiring",
      run_id: firstRunId,
      now: past,
      ttlMs: 1, // expires almost immediately relative to `past`
    });

    const secondRunId = `it-stealer-${randomUUID()}`;
    const stolen = await takeScopedLease(sql, {
      scope,
      holder_label: "it-runner-stealer",
      run_id: secondRunId,
    });
    expect(stolen.stolen_from).toBe("it-runner-expiring");

    const expiredRow = await sql`
      SELECT released_at, release_reason FROM atoms_writer_lease_history WHERE run_id = ${firstRunId}
    `;
    expect(expiredRow.length).toBe(1);
    expect(expiredRow[0]!.release_reason).toBe("expired");
    expect(expiredRow[0]!.released_at).not.toBeNull();

    // clean up the still-open second lease so it doesn't leak into other tests
    await releaseScopedLease(sql, stolen);
  });

  it("a DELETE against the history table is refused", async () => {
    const scope = { scope_type: "write" as const, entity_type: "cad-parcel-roll", county_fips: "48453" };
    const runId = `it-delete-refused-${randomUUID()}`;
    const lease = await takeScopedLease(sql, { scope, holder_label: "it-runner", run_id: runId });
    await releaseScopedLease(sql, lease);

    await expect(sql`DELETE FROM atoms_writer_lease_history WHERE run_id = ${runId}`).rejects.toThrow(
      /append-only/i,
    );

    const stillThere = await sql`SELECT 1 FROM atoms_writer_lease_history WHERE run_id = ${runId}`;
    expect(stillThere.length).toBe(1);
  });

  it("a second UPDATE against an already-released row is refused (no rewriting history)", async () => {
    const scope = { scope_type: "write" as const, entity_type: "cad-parcel-roll", county_fips: "48491" };
    const runId = `it-rewrite-refused-${randomUUID()}`;
    const lease = await takeScopedLease(sql, { scope, holder_label: "it-runner", run_id: runId });
    await releaseScopedLease(sql, lease);

    await expect(
      sql`
        UPDATE atoms_writer_lease_history
           SET released_by = 'tampered'
         WHERE run_id = ${runId}
      `,
    ).rejects.toThrow(/append-only/i);
  });

  it("a run id round-trips through the audit-style query (by run_id, and by scope+window)", async () => {
    const scope = { scope_type: "write" as const, entity_type: "utility-easement", county_fips: "48209" };
    const runId = `it-roundtrip-${randomUUID()}`;
    const before = new Date();
    const lease = await takeScopedLease(sql, { scope, holder_label: "it-runner", run_id: runId });
    await releaseScopedLease(sql, lease);
    const after = new Date();

    const byRunId = await sql`
      SELECT scope_type, scope_id, holder_label, run_id, taken_at, released_at, release_reason
        FROM atoms_writer_lease_history
       WHERE run_id = ${runId}
    `;
    expect(byRunId.length).toBe(1);
    expect(byRunId[0]!.run_id).toBe(runId);

    const byScopeWindow = await sql`
      SELECT run_id
        FROM atoms_writer_lease_history
       WHERE scope_type = ${scope.scope_type}
         AND scope_id = ${`${scope.entity_type}:${scope.county_fips}`}
         AND taken_at BETWEEN ${before.toISOString()}::timestamptz AND ${after.toISOString()}::timestamptz
    `;
    expect(byScopeWindow.some((r) => r.run_id === runId)).toBe(true);
  });
});
