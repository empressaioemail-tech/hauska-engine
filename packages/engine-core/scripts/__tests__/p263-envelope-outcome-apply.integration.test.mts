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
});
