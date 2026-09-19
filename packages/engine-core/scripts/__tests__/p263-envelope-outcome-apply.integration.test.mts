/**
 * P-342 — the FIXTURE-STORE proof. This is where the three falsifiers that need real rows are
 * proven, and where the "no record, no write" claim is proven by violation rather than asserted:
 *
 *   1. The apply MOVES the buckets and the journal holds every before-state.
 *   2. A reversal FROM THE RECORD restores the fixture byte-identically (body text AND
 *      content_hash, read back from the table, not from the plan).
 *   3. The guard FIRES on a mislabelled atom written into the fixture by hand — the recurrence
 *      control is exercised in the direction where it must refuse, not only where it reads zero.
 *   4. A re-run of the same run_id refuses and writes nothing (P263_JOURNAL_ALREADY_WRITTEN).
 *   5. A second reversal of the same row is refused by migration 018's trigger.
 *
 * P-365 adds the LEASE falsifiers, in both directions ("Verify by violation" in its dispatch):
 *
 *   6. A run whose lease EXPIRES between two batches refuses the second batch and writes nothing
 *      for it, and the batches already committed stay journalled and reversible.
 *   7. A run whose lease is TAKEN by another holder between two batches refuses the same way, and
 *      the refusal does not release a scope that is no longer ours.
 *   8. A long run whose batches outlast the TTL COMPLETES, with the lease renewed every batch —
 *      the heartbeat count and the moved expiry are the measurement, since the pre-change code
 *      writes the same rows while never renewing.
 *   9. A reversal FAILS CLOSED while another holder holds the county's scope, and writes nothing.
 *  10. A reversal with no `--county` takes ONE SCOPE PER COUNTY the journal names, heartbeats each
 *      per batch, and restores byte-identically.
 *
 * THE PRE-CHANGE DIRECTION is shown by running tests 6-10 against the source at the base commit
 * (`git stash` the writer, keep the tests): every refusal case completes and writes instead, and
 * the run reports no renewal at all. The recorded output is in the lane's CP2.
 *
 * GATING: `P342_IT_DATABASE_URL`, and a Neon host is REFUSED LOUDLY — this file creates and drops
 * schema and issues real DML. Unset means the suite is skipped and says so, per DEV_PROCESS 0:
 * if a check cannot be mechanized in this environment, say so rather than pretending it ran.
 *
 * The schema is created and dropped by this file; it never assumes an empty `public` schema, and
 * it sets `search_path` so the lease tables the core uses resolve inside its own schema.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_LEASE_TTL_MS,
  releaseScopedLease,
  scopeIdOf,
  takeScopedLease,
} from "@hauska-engine/storage";

import {
  applyCountyMovement,
  censusDigestOf,
  guardVerdict,
  planCounty,
  postStateVerdict,
  readCountyAtoms,
  reverseMovementRun,
} from "../p263-envelope-outcome-apply";
import { contentHashExcludingProvenance } from "../../src/property-reasoning/confidence.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_URL = process.env.P342_IT_DATABASE_URL ?? "";
const isNeon = /neon\.tech/i.test(DB_URL);
const canRun = DB_URL.trim() !== "" && !isNeon;

if (DB_URL.trim() !== "" && isNeon) {
  throw new Error(
    "P342_IT_DATABASE_URL resolves to a neon.tech host -- refusing to run schema-creating, " +
      "row-writing integration tests against it. Point this at a local, disposable Postgres.",
  );
}

const SCHEMA = "p342_apply_it";
const COUNTY = "48021";
const MIGRATIONS = join(__dirname, "..", "..", "..", "storage", "migrations");

const UNZONED = "unzoned jurisdiction — no district basis for setbacks or envelope";
const NO_DISTRICT = "no district on record — jurisdiction not yet onboarded";
const TIER1 = "Tier-1 snapshot status no-buildable-area";
const UNCLASSIFIED = "edge 0: R32 0ft != expected 15ft for role front";

function bodyFor(parcelId, outcome) {
  const body = {
    entityType: "buildable-envelope",
    atomDid: `did:hauska:buildable-envelope:${parcelId}`,
    entityId: parcelId,
    parcelNodeId: parcelId,
    status: "active",
    // `contentHash` is NOT in the emitter's PROVENANCE_KEYS, so the emitter empties it before
    // hashing. Do the same here so the fixture bodies are self-consistent with the emitter.
    contentHash: "",
    extractedAt: "2026-07-01T00:00:00.000Z",
    outcome,
  };
  body.contentHash = contentHashExcludingProvenance(body);
  return body;
}

describe.skipIf(!canRun)("P-342 apply on a fixture store", () => {
  const sql = canRun
    ? postgres(DB_URL, { max: 1, ssl: /localhost|127\.0\.0\.1/.test(DB_URL) ? false : "require" })
    : (null as unknown as postgres.Sql);

  beforeAll(async () => {
    if (!canRun) return;
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql.unsafe(`CREATE SCHEMA ${SCHEMA}`);
    await sql.unsafe(`SET search_path TO ${SCHEMA}, public`);
    for (const file of [
      "011_atoms_writer_lease_v2.sql",
      "015_atoms_writer_lease_history.sql",
      "018_envelope_outcome_movement_journal.sql",
    ]) {
      await sql.unsafe(await readFile(join(MIGRATIONS, file), "utf8"));
    }
    // The minimum of `atoms` this lane touches. Deliberately NOT migration 005: the fixture
    // proves THIS writer's contract, and pulling the whole substrate schema in would make the
    // fixture's failures ambiguous between this lane and that table's shape.
    await sql.unsafe(`
      CREATE TABLE atoms (
        atom_did      text PRIMARY KEY,
        entity_type   text NOT NULL,
        content_hash  text NOT NULL DEFAULT '',
        body          jsonb NOT NULL,
        updated_at    timestamptz NOT NULL DEFAULT now()
      )
    `);
    await seed();
  });

  afterAll(async () => {
    if (!canRun) return;
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
  });

  async function seed() {
    await sql.unsafe(`TRUNCATE ${SCHEMA}.atoms`);
    // NOT the journal and NOT the lease history: both are append-only, and both refuse DELETE
    // by trigger. That refusal is part of what these tests prove, so the fixture works WITH it
    // rather than around it: each test uses its own run_id and asserts on that run's rows.

    const fixtures = [
      [`${COUNTY}:1`, bodyFor(`${COUNTY}:1`, { kind: "no-buildable-area", reason: UNZONED })],
      [`${COUNTY}:2`, bodyFor(`${COUNTY}:2`, { kind: "no-buildable-area", reason: UNZONED })],
      [`${COUNTY}:3`, bodyFor(`${COUNTY}:3`, { kind: "no-buildable-area", reason: NO_DISTRICT })],
      [`${COUNTY}:4`, bodyFor(`${COUNTY}:4`, { kind: "no-buildable-area", reason: TIER1 })],
      [`${COUNTY}:5`, bodyFor(`${COUNTY}:5`, { kind: "no-buildable-area", reason: UNCLASSIFIED })],
      // Excluded arms: a real zero proof, and another kind. Neither may ever be touched.
      [
        `${COUNTY}:6`,
        bodyFor(`${COUNTY}:6`, {
          kind: "no-buildable-area",
          reason: "setback inset consumes the ring",
          zero: { method: "setback-inset-consumes-ring", areaSqFt: 0, verifiedBy: `${COUNTY}:6/ring` },
        }),
      ],
      [`${COUNTY}:7`, bodyFor(`${COUNTY}:7`, { kind: "buildable", areaSqFt: 4200 })],
      // Another county, to prove the read and the write are scoped.
      ["48209:1", bodyFor("48209:1", { kind: "no-buildable-area", reason: UNZONED })],
    ];
    for (const [atomDid, body] of fixtures) {
      await sql`
        INSERT INTO atoms (atom_did, entity_type, content_hash, body)
        VALUES (${atomDid}, 'buildable-envelope', ${body.contentHash}, ${sql.json(body)})
      `;
    }
  }

  /** Read the raw stored state, straight from the table — never from the plan. */
  async function storedState() {
    const rows = await sql`
      SELECT atom_did, content_hash, body::text AS body_text, body->'outcome'->>'kind' AS kind,
             body->'outcome'->>'reason' AS reason
        FROM atoms
       WHERE entity_type = 'buildable-envelope'
       ORDER BY atom_did
    `;
    return rows.map((r) => ({
      atom_did: String(r.atom_did),
      content_hash: String(r.content_hash),
      body_text: String(r.body_text),
      kind: r.kind,
      reason: r.reason,
    }));
  }

  /* ------------------------------- P-365: the lease falsifiers ------------------------------- */

  const SCOPE_ID = scopeIdOf({
    scope_type: "write",
    entity_type: "buildable-envelope",
    county_fips: COUNTY,
  });
  const BASE_MS = Date.parse("2026-03-01T00:00:00.000Z");
  const TTL_MS = DEFAULT_LEASE_TTL_MS;

  /**
   * The clock, as data. `applyCountyMovement`/`reverseMovementRun` read it once for the take and
   * once per batch, so a fixture can put batch N inside or outside the TTL without sleeping.
   */
  function clockAt(offsetsMs: number[]) {
    let reads = 0;
    return () => {
      const ms = offsetsMs[Math.min(reads, offsetsMs.length - 1)] as number;
      reads += 1;
      return new Date(BASE_MS + ms);
    };
  }

  /** Readings 0, step, 2*step, ... — a run whose TOTAL span exceeds the TTL. */
  function steppedClock(stepMs: number) {
    return clockAt(Array.from({ length: 16 }, (_, i) => i * stepMs));
  }

  /**
   * FIXTURE RESET, not production behaviour: the scope is one live row per county and the whole
   * suite shares the county, so a test that deliberately strands a lease clears it first. The
   * append-only HISTORY is never touched here — the guards refuse that, on purpose.
   */
  async function resetLeaseScope() {
    await sql`DELETE FROM atoms_writer_lease_v2 WHERE scope_id = ${SCOPE_ID}`;
  }

  /** The MOVED atoms, read from the table: the two honest destination kinds and nothing else. */
  async function movedAtoms() {
    const rows = await sql`
      SELECT atom_did FROM atoms
       WHERE entity_type = 'buildable-envelope'
         AND body->'outcome'->>'kind' IN ('not-applicable', 'provisional-front-edge')
       ORDER BY atom_did
    `;
    return rows.map((r) => String(r.atom_did));
  }

  async function unreversedCount(runId: string) {
    const rows = await sql`
      SELECT count(*)::int AS n FROM envelope_outcome_movement_journal
       WHERE run_id = ${runId} AND reversed_at IS NULL
    `;
    return rows[0].n as number;
  }

  it("a dry run reproduces the county's buckets exactly and writes nothing", async () => {
    const before = await storedState();
    const rows = await readCountyAtoms(sql, COUNTY);
    const plan = planCounty(COUNTY, rows);
    const after = await storedState();
    expect(after).toEqual(before);

    expect(plan.population).toBe(5);
    expect(plan.toNotApplicable).toBe(2);
    expect(plan.toPendingDerivation).toBe(2);
    expect(plan.toPendingByTier1Status).toBe(1);
    expect(plan.cannotClassify).toBe(1);
    expect(plan.alreadyComputedZero).toBe(1);
    expect(plan.notNoBuildableArea).toBe(1);
    expect(plan.moves).toBe(4);
    expect(plan.envelopeAtomsInScope).toBe(7);
  });

  it("the guard FIRES on the fixture's mislabelled atoms, and reads zero mislabelled after the apply", async () => {
    const before = planCounty(COUNTY, await readCountyAtoms(sql, COUNTY));
    expect(guardVerdict(before).fires).toBe(true);
    expect(guardVerdict(before).byBucket.unzoned).toBe(2);

    const runId = `p342-it-${randomUUID()}`;
    const applied = await applyCountyMovement(sql, {
      plan: before,
      rows: await readCountyAtoms(sql, COUNTY),
      runId,
      holderLabel: "p342-it",
    });
    expect(applied.moved).toBe(4);

    const after = planCounty(COUNTY, await readCountyAtoms(sql, COUNTY));
    const verdict = postStateVerdict(before, after);
    expect(verdict.ok).toBe(true);
    // The guard is green in the sense that matters: no movable bucket remains.
    expect(after.toNotApplicable).toBe(0);
    expect(after.toPendingDerivation).toBe(0);
    // And the cohort Ruling 12 withholds is still on record, un-swept.
    expect(after.cannotClassify).toBe(1);
    expect(after.population).toBe(1);

    await reverseMovementRun(sql, { journalRunId: runId, reversalRunId: `p342-it-rev-${runId}` });
  });

  it("moves the buckets, records every before-state, and reverses byte-identically from the record", async () => {
    await seed();
    const beforeState = await storedState();
    const before = planCounty(COUNTY, await readCountyAtoms(sql, COUNTY));
    const runId = `p342-it-${randomUUID()}`;

    const applied = await applyCountyMovement(sql, {
      plan: before,
      rows: await readCountyAtoms(sql, COUNTY),
      runId,
      holderLabel: "p342-it",
    });
    expect(applied.moved).toBe(4);
    expect(applied.journalRows).toBe(4);

    // Every moved atom: the journal holds the BEFORE state, and the store holds the AFTER state.
    const journal = await sql`
      SELECT atom_did, bucket, movement, before_body, before_content_hash, after_body, after_content_hash,
             reversed_at
        FROM envelope_outcome_movement_journal
       WHERE run_id = ${runId}
       ORDER BY atom_did
    `;
    expect(journal.length).toBe(4);
    expect(journal.every((j) => j.reversed_at === null)).toBe(true);

    const beforeByDid = new Map(beforeState.map((r) => [r.atom_did, r]));
    for (const j of journal) {
      const prior = beforeByDid.get(String(j.atom_did));
      expect(prior).toBeTruthy();
      expect(JSON.stringify(j.before_body)).toBe(JSON.stringify(JSON.parse(prior.body_text)));
      expect(String(j.before_content_hash)).toBe(prior.content_hash);
    }

    // The unmovable arms are untouched, and the two exclusions still carry their own shape.
    const mid = await storedState();
    const byDid = new Map(mid.map((r) => [r.atom_did, r]));
    expect(byDid.get(`${COUNTY}:5`).kind).toBe("no-buildable-area");
    expect(byDid.get(`${COUNTY}:5`).reason).toBe(UNCLASSIFIED);
    expect(byDid.get(`${COUNTY}:6`).body_text).toBe(beforeByDid.get(`${COUNTY}:6`).body_text);
    expect(byDid.get(`${COUNTY}:7`).body_text).toBe(beforeByDid.get(`${COUNTY}:7`).body_text);
    expect(byDid.get("48209:1").body_text).toBe(beforeByDid.get("48209:1").body_text);

    // The moved atoms carry the honest outcomes, and the retired literal is GONE from the record.
    expect(byDid.get(`${COUNTY}:1`).kind).toBe("not-applicable");
    expect(byDid.get(`${COUNTY}:1`).reason).toBe(UNZONED);
    expect(byDid.get(`${COUNTY}:3`).kind).toBe("provisional-front-edge");
    expect(byDid.get(`${COUNTY}:4`).kind).toBe("provisional-front-edge");
    expect(byDid.get(`${COUNTY}:4`).reason).not.toBe(TIER1);
    const allText = mid.map((r) => r.body_text).join("\n");
    expect(allText).not.toContain(TIER1);

    // REVERSAL — and the proof is a read of the table, not of the plan.
    const reversed = await reverseMovementRun(sql, {
      journalRunId: runId,
      reversalRunId: `p342-it-rev-${runId}`,
    });
    expect(reversed.reversed).toBe(4);

    const afterState = await storedState();
    expect(afterState).toEqual(beforeState);

    const marked = await sql`
      SELECT count(*)::int AS n FROM envelope_outcome_movement_journal
       WHERE run_id = ${runId} AND reversed_at IS NOT NULL AND reversed_by_run_id = ${`p342-it-rev-${runId}`}
    `;
    expect(marked[0].n).toBe(4);
  });

  it("refuses a re-run of the same run_id and writes nothing", async () => {
    await seed();
    const rowsBefore = await readCountyAtoms(sql, COUNTY);
    const plan = planCounty(COUNTY, rowsBefore);
    const runId = `p342-it-${randomUUID()}`;
    await applyCountyMovement(sql, { plan, rows: rowsBefore, runId, holderLabel: "p342-it" });
    const mid = await storedState();

    // Replay the SAME run_id with the SAME plan and the SAME before-state: the journal already
    // holds these atoms for this run, so it must refuse rather than double-record or double-write.
    await expect(
      applyCountyMovement(sql, { plan, rows: rowsBefore, runId, holderLabel: "p342-it" }),
    ).rejects.toThrow(/P263_JOURNAL_ALREADY_WRITTEN/);

    // The refusal happened INSIDE the transaction, so the store is exactly as it was.
    expect(await storedState()).toEqual(mid);
  });

  it("refuses a second reversal of the same row (migration 018's trigger)", async () => {
    await seed();
    const plan = planCounty(COUNTY, await readCountyAtoms(sql, COUNTY));
    const runId = `p342-it-${randomUUID()}`;
    await applyCountyMovement(sql, {
      plan,
      rows: await readCountyAtoms(sql, COUNTY),
      runId,
      holderLabel: "p342-it",
    });
    await reverseMovementRun(sql, { journalRunId: runId, reversalRunId: "rev-1" });
    // Nothing left un-reversed, so a second pass is a no-op rather than a second write...
    expect((await reverseMovementRun(sql, { journalRunId: runId, reversalRunId: "rev-2" })).reversed).toBe(0);
    // ...and the trigger refuses an attempted second mark on a row directly.
    await expect(
      sql`UPDATE envelope_outcome_movement_journal SET reversed_at = now(), reversed_by_run_id = 'rev-2' WHERE run_id = ${runId}`,
    ).rejects.toThrow(/already reversed/);
  });

  it("the guard fires on a mislabelled atom written BY HAND into the fixture", async () => {
    await seed();
    await applyCountyMovement(sql, {
      plan: planCounty(COUNTY, await readCountyAtoms(sql, COUNTY)),
      rows: await readCountyAtoms(sql, COUNTY),
      runId: `p342-it-${randomUUID()}`,
      holderLabel: "p342-it",
    });
    expect(planCounty(COUNTY, await readCountyAtoms(sql, COUNTY)).population).toBe(1);

    // A raw write outside the writer — the named bypass — putting the retired state back.
    const raw = bodyFor(`${COUNTY}:99`, { kind: "no-buildable-area", reason: UNZONED });
    await sql`
      INSERT INTO atoms (atom_did, entity_type, content_hash, body)
      VALUES (${`${COUNTY}:99`}, 'buildable-envelope', ${raw.contentHash}, ${sql.json(raw)})
    `;

    const plan = planCounty(COUNTY, await readCountyAtoms(sql, COUNTY));
    const verdict = guardVerdict(plan);
    expect(verdict.fires).toBe(true);
    expect(verdict.byBucket.unzoned).toBe(1);
    expect(plan.censusDigest).not.toBe(censusDigestOf({ ...plan, toNotApplicable: 0 }));
  });

  it("keeps the drift pin honest across a store change", async () => {
    await seed();
    const first = planCounty(COUNTY, await readCountyAtoms(sql, COUNTY));
    const raw = bodyFor(`${COUNTY}:98`, { kind: "no-buildable-area", reason: UNZONED });
    await sql`
      INSERT INTO atoms (atom_did, entity_type, content_hash, body)
      VALUES (${`${COUNTY}:98`}, 'buildable-envelope', ${raw.contentHash}, ${sql.json(raw)})
    `;
    const second = planCounty(COUNTY, await readCountyAtoms(sql, COUNTY));
    expect(second.population).toBe(first.population + 1);
    expect(second.censusDigest).not.toBe(first.censusDigest);
  });

  it("does not touch another county's atoms", async () => {
    await seed();
    const other = await storedState();
    const otherBefore = other.find((r) => r.atom_did === "48209:1");
    await applyCountyMovement(sql, {
      plan: planCounty(COUNTY, await readCountyAtoms(sql, COUNTY)),
      rows: await readCountyAtoms(sql, COUNTY),
      runId: `p342-it-${randomUUID()}`,
      holderLabel: "p342-it",
    });
    const after = await storedState();
    expect(after.find((r) => r.atom_did === "48209:1")).toEqual(otherBefore);
  });

  it("the journal is append-only: DELETE and TRUNCATE are refused by migration 018's trigger", async () => {
    // Seed a record the trigger can actually see: a row-level DELETE trigger only fires for
    // rows that exist, and an empty table would pass this test vacuously.
    await seed();
    await applyCountyMovement(sql, {
      plan: planCounty(COUNTY, await readCountyAtoms(sql, COUNTY)),
      rows: await readCountyAtoms(sql, COUNTY),
      runId: `p342-it-${randomUUID()}`,
      holderLabel: "p342-it",
    });
    const before = await sql`SELECT count(*)::int AS n FROM envelope_outcome_movement_journal`;
    expect(before[0].n).toBeGreaterThan(0);

    await expect(sql`DELETE FROM envelope_outcome_movement_journal`).rejects.toThrow(/append-only/);
    await expect(sql.unsafe(`TRUNCATE envelope_outcome_movement_journal`)).rejects.toThrow(
      /append-only/,
    );
    // And the record survives both attempts, unchanged in count.
    const after = await sql`SELECT count(*)::int AS n FROM envelope_outcome_movement_journal`;
    expect(after[0].n).toBe(before[0].n);
  });

  /* --------------------------- P-365: the lease, proven by violation --------------------------- */

  it("P-365 F1: refuses the batch whose lease expired between batches, and writes nothing for it", async () => {
    await seed();
    await resetLeaseScope();
    const runId = `p365-f1-${randomUUID()}`;
    const rows = await readCountyAtoms(sql, COUNTY);
    const plan = planCounty(COUNTY, rows);
    expect(plan.moves).toBe(4);

    /**
     * ONE ATOM PER BATCH. The take and batch 1 land INSIDE the 15-minute TTL; batch 2 lands one
     * second past it. Nothing sleeps — the clock is a value the caller supplies.
     */
    const error = await applyCountyMovement(sql, {
      plan,
      rows,
      runId,
      holderLabel: "p365-it",
      batchSize: 1,
      now: clockAt([0, 0, TTL_MS + 1000, TTL_MS + 2000, TTL_MS + 3000]),
    }).then(
      () => null,
      (e) => e,
    );

    // THE TWO FACTS IN ONE ASSERTION, so that the PRE-CHANGE run's failure message is itself the
    // measurement: the base code writes batch 2, journals it, and reports no refusal at all.
    const journal =
      await sql`SELECT atom_did FROM envelope_outcome_movement_journal WHERE run_id = ${runId}`;
    expect({
      refusedWith: error?.code ?? null,
      movedAtoms: await movedAtoms(),
      journalRows: journal.length,
    }).toEqual({
      refusedWith: "P263_LEASE_LOST",
      movedAtoms: [`${COUNTY}:1`],
      journalRows: 1,
    });

    expect(error?.cause).toBe("LEASE_EXPIRED");
    expect(error?.batchesWritten).toBe(1);
    expect(error?.atomsWrittenBeforeRefusal).toBe(1);
    expect(error?.journalRowsBeforeRefusal).toBe(1);

    // The lease report rides on the refusal: one heartbeat, the refused batch, and a release that
    // is recorded as EXPIRED rather than as a normal release.
    const report = error?.leaseReport;
    expect(report?.heartbeats).toBe(1);
    expect(report?.refusal?.code).toBe("P263_LEASE_LOST");
    expect(report?.refusal?.atomsWrittenBeforeRefusal).toBe(1);
    expect(report?.released).toBe(true);
    expect(report?.releaseReason).toBe("expired");
    const history = await sql`
      SELECT release_reason FROM atoms_writer_lease_history
       WHERE run_id = ${runId} AND released_at IS NOT NULL
    `;
    expect(history.map((h) => h.release_reason)).toEqual(["expired"]);

    // ...and the batch that did commit is still reversible from its record.
    const reversed = await reverseMovementRun(sql, {
      journalRunId: runId,
      reversalRunId: `p365-f1-rev-${runId}`,
      holderLabel: "p365-it",
    });
    expect(reversed.reversed).toBe(1);
    expect(await movedAtoms()).toEqual([]);
  });

  it("P-365 F2: refuses the batch whose lease another holder took between batches", async () => {
    await seed();
    await resetLeaseScope();
    const runId = `p365-f2-${randomUUID()}`;
    const THIEF_TOKEN = "00000000-0000-4000-8000-0000000000ff";

    /**
     * THE STEAL, made deterministic without sleeping: a one-shot fixture trigger on `atoms`, armed
     * for this test only, repoints the scope's lease row to another holder the moment batch 1's
     * write lands — i.e. BETWEEN batches — and closes our history row exactly the way
     * `takeScopedLease`'s own steal branch does. That is the adversary the heartbeat exists for:
     * the scope is now held by a live holder whose token is not ours.
     */
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.p365_steal (armed boolean NOT NULL);
      TRUNCATE ${SCHEMA}.p365_steal;
      INSERT INTO ${SCHEMA}.p365_steal (armed) VALUES (true);
      CREATE OR REPLACE FUNCTION ${SCHEMA}.p365_steal_lease() RETURNS trigger AS $steal$
      BEGIN
        IF (SELECT armed FROM ${SCHEMA}.p365_steal LIMIT 1) THEN
          UPDATE ${SCHEMA}.atoms_writer_lease_history
             SET released_at = now(),
                 released_by = 'stolen-by:p365-it-thief',
                 release_reason = 'expired'
           WHERE scope_type = 'write'
             AND scope_id = 'buildable-envelope:${COUNTY}'
             AND released_at IS NULL;
          UPDATE ${SCHEMA}.atoms_writer_lease_v2
             SET holder_token = '${THIEF_TOKEN}'::uuid,
                 holder_label = 'p365-it-thief',
                 expires = now() + interval '1 hour',
                 heartbeat = now(),
                 stolen_from = 'p365-it'
           WHERE scope_type = 'write' AND scope_id = 'buildable-envelope:${COUNTY}';
          UPDATE ${SCHEMA}.p365_steal SET armed = false;
        END IF;
        RETURN NULL;
      END;
      $steal$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS p365_steal_lease ON ${SCHEMA}.atoms;
      CREATE TRIGGER p365_steal_lease AFTER UPDATE ON ${SCHEMA}.atoms
        FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.p365_steal_lease();
    `);

    try {
      const rows = await readCountyAtoms(sql, COUNTY);
      const plan = planCounty(COUNTY, rows);
      const error = await applyCountyMovement(sql, {
        plan,
        rows,
        runId,
        holderLabel: "p365-it",
        batchSize: 1,
      }).then(
        () => null,
        (e) => e,
      );

      // ONE ASSERTION, BOTH FACTS. On the pre-change code this reads: `refusedWith` is the RELEASE
      // error (the only place the base code ever noticed the steal — after all four batches had
      // already landed), and all four atoms were moved. That is the violation this falsifier exists
      // to name: the old writer kept writing for three batches while another holder held the scope.
      const journal =
        await sql`SELECT atom_did FROM envelope_outcome_movement_journal WHERE run_id = ${runId}`;
      expect({
        refusedWith: error?.code ?? null,
        movedAtoms: await movedAtoms(),
        journalRows: journal.length,
      }).toEqual({
        refusedWith: "P263_LEASE_LOST",
        movedAtoms: [`${COUNTY}:1`],
        journalRows: 1,
      });

      expect(error?.cause).toBe("LEASE_EXPIRED");
      expect(error?.batchesWritten).toBe(1);
      expect(error?.atomsWrittenBeforeRefusal).toBe(1);

      // THE THIEF KEEPS THE SCOPE. A release written by scope would have taken a live holder's
      // lease away; this one deletes by OUR token, so it fails — and says so in the report rather
      // than masking the refusal.
      const held =
        await sql`SELECT holder_label FROM atoms_writer_lease_v2 WHERE scope_id = ${SCOPE_ID}`;
      expect(held.map((r) => r.holder_label)).toEqual(["p365-it-thief"]);
      expect(error?.leaseReport?.released).toBe(false);
      expect(String(error?.leaseReport?.releaseFailure)).toMatch(/ATOMS_WRITER_LEASE_NOT_HELD/);
    } finally {
      // Fixture reset: the trigger off, and the holder this test minted gone.
      await sql.unsafe(`DROP TRIGGER IF EXISTS p365_steal_lease ON ${SCHEMA}.atoms`);
      await sql`DELETE FROM atoms_writer_lease_v2 WHERE scope_id = ${SCOPE_ID}`;
    }
  });

  it("P-365 F3: completes a run whose batches outlast the TTL, renewing the lease every batch", async () => {
    await seed();
    await resetLeaseScope();
    const runId = `p365-f3-${randomUUID()}`;
    const STEP_MS = Math.floor(TTL_MS / 2);
    const rows = await readCountyAtoms(sql, COUNTY);
    const plan = planCounty(COUNTY, rows);

    const result = await applyCountyMovement(sql, {
      plan,
      rows,
      runId,
      holderLabel: "p365-it",
      batchSize: 1,
      now: steppedClock(STEP_MS),
    });

    expect(result.moved).toBe(4);
    expect(result.batches).toBe(4);
    /**
     * THE DISCRIMINATOR. The lease the TAKE granted was already expired at batch 2's own clock
     * reading (two half-TTLs), so this run completed for one reason: every batch re-asserted it.
     * The count and the moved expiry are what say so — the pre-change code writes the SAME rows
     * and reports no renewal at all, which is exactly why the TTL rule was unenforced.
     */
    expect(2 * STEP_MS).toBeGreaterThanOrEqual(TTL_MS);
    expect(result.lease?.heartbeats).toBe(4);
    expect(result.lease?.lastExpires).toBe(new Date(BASE_MS + 4 * STEP_MS + TTL_MS).toISOString());
    expect(result.lease?.released).toBe(true);
    expect(result.lease?.releaseReason).toBe("normal");

    // The record's own last timestamp sits INSIDE the window the last heartbeat extended to.
    const last = await sql`
      SELECT max(applied_at)::text AS last_applied
        FROM envelope_outcome_movement_journal WHERE run_id = ${runId}
    `;
    expect(Date.parse(String(result.lease?.lastExpires))).toBeGreaterThan(
      Date.parse(last[0].last_applied),
    );
    expect(await movedAtoms()).toHaveLength(4);
    const live =
      await sql`SELECT count(*)::int AS n FROM atoms_writer_lease_v2 WHERE scope_id = ${SCOPE_ID}`;
    expect(live[0].n).toBe(0);
  });

  it("P-365 F4a: refuses to reverse while another holder holds the county's scope, and writes nothing", async () => {
    await seed();
    await resetLeaseScope();
    const runId = `p365-f4a-${randomUUID()}`;
    await applyCountyMovement(sql, {
      plan: planCounty(COUNTY, await readCountyAtoms(sql, COUNTY)),
      rows: await readCountyAtoms(sql, COUNTY),
      runId,
      holderLabel: "p365-it",
    });
    const mid = await storedState();

    // Another holder takes the scope through the production take path — the state a reversal used
    // to ignore entirely: before P-365 `reverseMovementRun` held no scope and would have restored
    // under this holder's feet.
    const other = await takeScopedLease(sql, {
      scope: { scope_type: "write", entity_type: "buildable-envelope", county_fips: COUNTY },
      holder_label: "p365-it-other",
      run_id: "p365-it-other",
    });
    try {
      const error = await reverseMovementRun(sql, {
        journalRunId: runId,
        reversalRunId: `p365-f4a-rev-${runId}`,
        holderLabel: "p365-it",
      }).then(
        () => null,
        (e) => e,
      );

      // Both facts in one assertion, so the PRE-CHANGE message is the measurement: the base
      // reversal reports no refusal AND restores every row under the other holder's lease.
      expect({
        refusedWith: error?.code ?? null,
        storedStateUnchanged: JSON.stringify(await storedState()) === JSON.stringify(mid),
        unreversedRows: await unreversedCount(runId),
      }).toEqual({
        refusedWith: "ATOMS_WRITER_LEASE_HELD_BY_OTHER",
        storedStateUnchanged: true,
        unreversedRows: 4,
      });
    } finally {
      await releaseScopedLease(sql, other);
    }
  });

  it("P-365 F5: reverses under a held, heartbeated lease — one scope per county the journal names", async () => {
    await seed();
    await resetLeaseScope();
    const runId = `p365-f5-${randomUUID()}`;
    // The state the reversal must restore, read from the table BEFORE anything moves.
    const before = await storedState();

    /**
     * ONE journal run spanning TWO counties. The JOURNAL is what names the scope set: no
     * `--county` is passed to the reversal, and it must still hold a scope for every county it
     * writes — refusing the run-wide shape was the alternative and would have been a capability
     * regression on the documented undo path.
     */
    await applyCountyMovement(sql, {
      plan: planCounty(COUNTY, await readCountyAtoms(sql, COUNTY)),
      rows: await readCountyAtoms(sql, COUNTY),
      runId,
      holderLabel: "p365-it",
      batchSize: 4,
    });
    await applyCountyMovement(sql, {
      plan: planCounty("48209", await readCountyAtoms(sql, "48209")),
      rows: await readCountyAtoms(sql, "48209"),
      runId,
      holderLabel: "p365-it",
    });

    const result = await reverseMovementRun(sql, {
      journalRunId: runId,
      reversalRunId: `p365-f5-rev-${runId}`,
      holderLabel: "p365-it",
      batchSize: 1,
      now: steppedClock(Math.floor(TTL_MS / 2)),
    });

    expect(result.reversed).toBe(5);
    expect(result.batches).toBe(5);
    expect((result.leases ?? []).map((l) => l.scope.scopeId)).toEqual([
      "buildable-envelope:48021",
      "buildable-envelope:48209",
    ]);
    expect((result.leases ?? []).map((l) => l.heartbeats)).toEqual([4, 1]);
    expect((result.leases ?? []).every((l) => l.released && l.releaseReason === "normal")).toBe(
      true,
    );
    expect((result.leases ?? []).every((l) => l.holderLabel === "p365-it")).toBe(true);
    // ...and the restore is byte-identical with respect to the table, not to the plan.
    expect(await storedState()).toEqual(before);
    expect(await unreversedCount(runId)).toBe(0);
  });
});
