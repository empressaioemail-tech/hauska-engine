#!/usr/bin/env tsx
/**
 * P-342 — THE APPLY for P-263's envelope-outcome movement.
 *
 * P-263 removed the writers that minted a `no-buildable-area` claim with no computation behind
 * it, and fixed the one branch that re-asserted an upstream Tier-1 STATUS as its own zero. It
 * did NOT move the atoms already on record, and it left no apply path: the census
 * (`p263-envelope-outcome-census.mts`) is read-only by construction and says so. This file is
 * that path, and it exists so the movement OPS-16 A-215 Ruling 11 authorises ("county by
 * county, each county's run capped at its own measured share, under P-213's blast-radius
 * refusal and P-281's heavy-scan lease") is performed by a control rather than by hand.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IT MOVES, AND WHAT IT REFUSES TO MOVE
 * ---------------------------------------------------------------------------------------------
 *
 * It moves EXACTLY the census's buckets and nothing else, using the SAME classifier the census
 * uses (one module, `src/property-reasoning/envelope-outcome-movement.ts`; never two):
 *
 *   unzoned              -> outcome.kind `not-applicable`          (the ordinance does not reach it)
 *   no-district          -> outcome.kind `provisional-front-edge`  (zoned, not yet wired)
 *   tier1StatusAssertion -> outcome.kind `provisional-front-edge` with the producer's CURRENT
 *                           honest reason, never the retired literal that IS the false claim
 *
 * It moves NOTHING for `unclassifiedByReason` (OPS-16 A-215 Ruling 12: the 30,434 atoms that
 * name a FAILED computation are withheld as unverified on every surface and fixed properly by
 * P-343, not swept into a classification the census declined to make), nothing for
 * `alreadyComputedZero`, and nothing for `notNoBuildableArea`. `movedOutcomeFor` returns `null`
 * for all three; `assertMovable` throws instead of returning, so a writer cannot read a refusal
 * as "nothing to do".
 *
 * Only TWO fields of an atom change: `body.outcome` and `content_hash` (recomputed with
 * `contentHashExcludingProvenance`, the same function the emitter uses, so the atom stays
 * self-consistent). `status`, provenance, refs and the rest of the body are untouched.
 *
 * ---------------------------------------------------------------------------------------------
 * THE FOUR REFUSALS (each one a pre-registered falsifier, each proven by violation in the tests)
 * ---------------------------------------------------------------------------------------------
 *
 *   1. MISSING CAP. `--blast-radius-max-share` is REQUIRED and has no default: `evaluateBlastRadius`
 *      refuses to run without a caller-declared `0 < maxShare < 1`, because "the threshold is a
 *      declared number per county run, recorded with its basis, not a judgement call at call time"
 *      (OPS-16 P-213). A missing share refuses with BLAST_RADIUS_UNMEASURED — it never defaults.
 *      Over the cap, the run refuses and writes NOTHING, and the refusal prints the EXACT
 *      `BLAST_RADIUS_OVERRIDE=` token the integration seat would pass to authorise THIS measured
 *      run and no other (`overrideTokenFor`). Counts move and the token stops carrying.
 *   2. CENSUS DRIFT. `--apply` REQUIRES `--expect-digest` (the digest a reviewed dry run printed),
 *      and the run takes its OWN fresh census in its own read window before writing. Population or
 *      any bucket differing from the pinned digest refuses with CENSUS_DRIFT and writes nothing —
 *      "it refuses a county whose population or buckets differ from a fresh census taken in the
 *      same leased window". A dry run needs no pin; it PRINTS the digest to pin.
 *   3. NO LEASE, NO RUN. `--apply` requires `--run-id` (LEASE_REQUIRED otherwise) and takes a live
 *      `atoms_writer_lease_v2` WRITE scope on `(buildable-envelope, <county fips>)`. A write
 *      without a held lease fails closed. `--apply` also refuses outside a Cloud Run Job
 *      (LAPTOP_WRITE_FROZEN, P-169) — see "WHAT BYPASSES THIS" below for the fixture seam.
 *   4. NO RECORD, NO WRITE. Every atom's before-state and after-state is INSERTed into
 *      `envelope_outcome_movement_journal` IN THE SAME TRANSACTION as the body UPDATE, before it.
 *      If the record cannot be written the transaction aborts and the write does not run.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT BYPASSES THIS (stated in full, because the answer is never none)
 * ---------------------------------------------------------------------------------------------
 *
 *   (a) A RAW CONNECTION. `UPDATE atoms SET body = ...` issued outside this file — by hand, by a
 *       psql session, by any other writer of buildable-envelope atoms. No in-process control can
 *       see it; that is exactly why P-263's census exists as a recurrence control and why
 *       `--guard` is the thing that notices. THIS FILE IS THE ONLY APPLY PATH THIS LANE BUILT,
 *       and it is not the only way the bytes can change.
 *   (b) A CALLER OF THE CORE. `applyCountyMovement()` / `reverseMovementRun()` are exported for
 *       the fixture-store tests. A caller that reaches them from outside the CLI skips the
 *       Cloud-Run-Job gate and the `--run-id` requirement (but NOT the lease: the core calls
 *       `takeScopedLease` itself, so it still fails closed without a live scope). The
 *       integration test is exactly such a caller, by design.
 *   (c) A HAND-EDITED CAP. `--blast-radius-max-share` is supplied by the operator's seat. A run
 *       that declares a cap so wide the guard cannot fire is a run whose cap was chosen to not
 *       fire; every artifact records the declared number with the sharing figures so that choice
 *       is visible rather than silent.
 *   (d) DELETING OR REVERTING THIS FILE, or removing the trigger in migration 018. Nothing
 *       outside the store enforces that the journal is written.
 *
 * ---------------------------------------------------------------------------------------------
 * REVERSAL
 * ---------------------------------------------------------------------------------------------
 *
 * `--reverse --journal-run-id=<id>` replays `before_body` + `before_content_hash` for every row
 * of that run not yet reversed and marks each row `reversed_at`/`reversed_by_run_id`. The mark is
 * in the same transaction as the restore (restore first), so a crash mid-reversal leaves the
 * un-marked rows still reversible and still described by the journal. A row can be reversed ONCE:
 * the migration-018 trigger refuses a second reversal UPDATE, and the (run_id, atom_did) unique
 * index refuses a second journal row for the same atom in the same run.
 *
 * ---------------------------------------------------------------------------------------------
 * THE THREE-QUESTION GATE
 * ---------------------------------------------------------------------------------------------
 *
 *   1. What executes the apply?  This script, `--county=<fips>` + `--apply`, run by the
 *      integration seat. It is the only writer in this lane.
 *   2. What triggers it?  An operator-authorised county run, after the seat has reviewed a dry
 *      run's buckets and digest and supplied `--blast-radius-max-share` and `--expect-digest`.
 *   3. What fails?  Refusals 1-4 above, each with its own code, each writing nothing:
 *      BLAST_RADIUS_UNMEASURED / BLAST_RADIUS_EXCEEDED / BLAST_RADIUS_OVERRIDE_MISMATCH,
 *      CENSUS_DRIFT, LEASE_REQUIRED / LAPTOP_WRITE_FROZEN / lease scope errors from
 *      `takeScopedLease`, P263_JOURNAL_ALREADY_WRITTEN, and P263_POST_STATE_NOT_MOVED if the
 *      county does not read zero mislabelled atoms after the write.
 *   4. What bypasses it?  (a)-(d) above.
 *
 * Usage:
 *   tsx scripts/p263-envelope-outcome-apply.mts --county=48021 \
 *       --blast-radius-max-share=0.9 [--expect-digest=<sha256>] [--json <out>] [--guard]
 *       [--apply --run-id=<factory run id>] [--batch-size=100]
 *   tsx scripts/p263-envelope-outcome-apply.mts --reverse --journal-run-id=<id> \
 *       [--county=<fips>] [--run-id=<this reversal's run id>] [--json <out>]
 *
 * Dry run is the DEFAULT: without `--apply` nothing is written by any code path in this file.
 * The DSN comes from `resolveSubstrateDatabaseUrl()` and is never printed; artifacts carry a
 * host fingerprint instead.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

import {
  releaseScopedLease,
  resolveSubstrateDatabaseUrl,
  takeScopedLease,
} from "@hauska-engine/storage";

import { contentHashExcludingProvenance } from "../src/property-reasoning/confidence.js";
import {
  ENVELOPE_MOVEMENT_COUNTING_RULE,
  assertMovable,
  classifyEnvelopeOutcomeBucket,
  movementOf,
  type EnvelopeOutcomeBucket,
} from "../src/property-reasoning/envelope-outcome-movement.js";
/**
 * TASK 4's INSTRUMENT. Ruling 12 says the withheld cohort is "withheld as unverified on every
 * surface and never served as the legacy claim"; the axis the serving surfaces actually gate on
 * is VERIFICATION, not reason — `isDepthWarmPromotedAtom` (P-261/A-180), the predicate
 * hauska-map's `isDepthWarmPromoted` and legacy-design-tools' `isEnvelopeAtomVerified` mirror.
 * A reason-carrying atom is withheld on both producers by the reason branches alone; a
 * reason-LESS atom is withheld only while it is UNPROMOTED. So the question this lane must
 * answer with a measurement rather than an assurance is: how many of the withheld cohort are
 * already promoted — i.e. how many can reach a claim branch at all?
 *
 * Imported rather than re-expressed: the promotion rule has FOUR readers in three repos (this
 * module's own doc names them), and a fifth copy written for a script's convenience is exactly
 * the drift the canon forbids.
 */
import { isDepthWarmPromotedAtom } from "../src/site-plan/envelope-promotion.js";
import { openSubstrateClient, storeHostFingerprint } from "./atoms-store-client.mjs";
import {
  COUNTY_NAME,
  ENVELOPE_MOVEMENT_WRITER,
  SIX_COUNTIES,
} from "./p263-phase0-counties.mjs";
import {
  OVERRIDE_ENV_VAR as BLAST_RADIUS_OVERRIDE_ENV_VAR,
  evaluateBlastRadius,
  overrideTokenFor,
} from "./writer-blast-radius-guard.mjs";
import {
  refuseApplyOutsideCloudRunJob,
  refuseApplyWithoutRunId,
} from "./writer-apply-lease.mjs";

const DEFAULT_BATCH_SIZE = 100;

/* ------------------------------- argument parsing ------------------------------- */

/** `--flag=value` or `--flag value`. Returns the string, or null when absent. */
export function readArg(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === name) return argv[i + 1] ?? null;
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return null;
}

export function hasFlag(argv, name) {
  return argv.includes(name);
}

function refuse(code, message, detail = {}) {
  // The code leads the message as well as riding on `err.code`, so a refusal is greppable in a
  // log and a human reading the text sees the same identifier a caller branches on.
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  Object.assign(err, detail);
  throw err;
}

/* ---------------------------------- pure planning ---------------------------------- */

/** One classified atom, as the planner consumes it. */
export type PlannedAtom = {
  atomDid: string;
  kind: string | null;
  reason: string | null;
  hasZero: boolean;
  bucket: EnvelopeOutcomeBucket;
  movement: "toNotApplicable" | "toPendingDerivation" | null;
};

export type CountyPlan = {
  county: string;
  countyName: string;
  /** All active buildable-envelope atoms in the county — the blast-radius denominator. */
  envelopeAtomsInScope: number;
  /** The census population: no-buildable-area, no zero proof. */
  population: number;
  toNotApplicable: number;
  toPendingDerivation: number;
  toPendingByTier1Status: number;
  cannotClassify: number;
  alreadyComputedZero: number;
  notNoBuildableArea: number;
  moves: number;
  /**
   * TASK 4 (Ruling 12's audit) — of `cannotClassify`, how many carry the depth-warm promotion
   * marker. This is the ESCAPE COUNT: the serving surfaces (hauska-map's claim branch,
   * legacy-design-tools' reconciliation) gate a reason-less `no-buildable-area` claim on
   * promotion and on nothing else, so a promoted member of the cohort can still be served the
   * legacy sentence while an unpromoted one cannot. Zero means the withholding is real on every
   * surface today; non-zero means it is real only by accident of promotion state, and the
   * surfaces need the honesty predicate (P-343), not the verification one.
   */
  cannotClassifyPromoted: number;
  /** Up to five DIDs of the escape set, so an artifact names atoms rather than a count. */
  cannotClassifyPromotedDids: string[];
  /** Of the whole population, how many are promoted — the same axis, over the movable buckets. */
  populationPromoted: number;
  /** Atoms the apply will actually rewrite, in stable atom_did order. */
  movable: PlannedAtom[];
  /** sha256 over population + every bucket — the pin a dry run prints, an apply must carry. */
  censusDigest: string;
  /** sha256 over sorted `<atom_did>|<body json>` for every atom in the population. */
  populationContentDigest: string;
};

export function digestOf(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * The pin. Deliberately over COUNTS AND POPULATION, not over atom identities: this is the thing
 * the dispatch requires the apply to re-check ("population or buckets differ"), and it is the
 * field a dry run prints and an `--apply` requires. The denominator is deliberately NOT part of
 * the pin — it is re-measured in the apply's own window and reported in the artifact, and a
 * county whose envelope population grew while the movement counts held is a separate finding
 * (visible in `plan.envelopeAtomsInScope`), not a silent pass.
 */
export function censusDigestOf(plan: {
  population: number;
  toNotApplicable: number;
  toPendingDerivation: number;
  cannotClassify: number;
  alreadyComputedZero: number;
  notNoBuildableArea: number;
}): string {
  return digestOf(
    JSON.stringify([
      ["population", plan.population],
      ["toNotApplicable", plan.toNotApplicable],
      ["toPendingDerivation", plan.toPendingDerivation],
      ["cannotClassify", plan.cannotClassify],
      ["alreadyComputedZero", plan.alreadyComputedZero],
      ["notNoBuildableArea", plan.notNoBuildableArea],
    ]),
  );
}

/**
 * PURE. Classify every atom row of one county into buckets and build the plan. No store, no
 * writes — this is what the hermetic tests exercise, and what the store path calls.
 *
 * `rows` must already be scoped to the county's active buildable-envelope atoms; the caller's
 * SQL does the scoping, exactly as the census's does. `body` is used only for the content digest.
 */
export function planCounty(
  county: string,
  rows: ReadonlyArray<{
    atomDid: string;
    kind: string | null;
    reason: string | null;
    hasZero: boolean;
    body?: unknown;
  }>,
): CountyPlan {
  const plan: CountyPlan = {
    county,
    countyName: COUNTY_NAME[county] ?? county,
    envelopeAtomsInScope: rows.length,
    population: 0,
    toNotApplicable: 0,
    toPendingDerivation: 0,
    toPendingByTier1Status: 0,
    cannotClassify: 0,
    alreadyComputedZero: 0,
    notNoBuildableArea: 0,
    moves: 0,
    movable: [],
    censusDigest: "",
    populationContentDigest: "",
    cannotClassifyPromoted: 0,
    cannotClassifyPromotedDids: [],
    populationPromoted: 0,
  };

  const digestParts: string[] = [];
  for (const r of rows) {
    const bucket = classifyEnvelopeOutcomeBucket({
      kind: r.kind,
      reason: r.reason,
      hasZero: r.hasZero,
    });
    const movement = movementOf(bucket);

    if (bucket === "alreadyComputedZero") {
      plan.alreadyComputedZero += 1;
      continue;
    }
    if (bucket === "notNoBuildableArea") {
      plan.notNoBuildableArea += 1;
      continue;
    }

    plan.population += 1;
    digestParts.push(`${r.atomDid}|${JSON.stringify(r.body ?? null)}`);

    /**
     * TASK 4's measurement, taken here because this loop already holds every population row.
     * `body` is the stored atom body the serving surfaces read (`depthWarmPromotion` /
     * `sourceCitation` ride it top-level: `cert-grade-core.ts` queries
     * `body->>'depthWarmPromotion'`, and hauska-map's chain projection hands the body on as
     * `buildableEnvelope`), so this is the SAME field the surfaces gate on, read from the same
     * record — not a proxy for it.
     */
    const promoted = isDepthWarmPromotedAtom(
      (r.body ?? null) as { depthWarmPromotion?: unknown; sourceCitation?: unknown } | null,
    );
    if (promoted) plan.populationPromoted += 1;

    if (bucket === "unzoned") {
      plan.toNotApplicable += 1;
      plan.moves += 1;
      plan.movable.push({
        atomDid: r.atomDid,
        kind: r.kind,
        reason: r.reason,
        hasZero: r.hasZero,
        bucket,
        movement,
      });
    } else if (bucket === "no-district") {
      plan.toPendingDerivation += 1;
      plan.moves += 1;
      plan.movable.push({
        atomDid: r.atomDid,
        kind: r.kind,
        reason: r.reason,
        hasZero: r.hasZero,
        bucket,
        movement,
      });
    } else if (bucket === "tier1StatusAssertion") {
      plan.toPendingDerivation += 1;
      plan.toPendingByTier1Status += 1;
      plan.moves += 1;
      plan.movable.push({
        atomDid: r.atomDid,
        kind: r.kind,
        reason: r.reason,
        hasZero: r.hasZero,
        bucket,
        movement,
      });
    } else {
      plan.cannotClassify += 1;
      if (promoted) {
        plan.cannotClassifyPromoted += 1;
        if (plan.cannotClassifyPromotedDids.length < 5) {
          plan.cannotClassifyPromotedDids.push(r.atomDid);
        }
      }
    }
  }

  const bucketSum = plan.toNotApplicable + plan.toPendingDerivation + plan.cannotClassify;
  if (bucketSum !== plan.population) {
    refuse(
      "P263_BUCKET_SUM_MISMATCH",
      `bucket sum ${bucketSum} != population ${plan.population} — the classifier is not total`,
      { county, bucketSum, population: plan.population },
    );
  }

  plan.movable.sort((a, b) => a.atomDid.localeCompare(b.atomDid));
  plan.censusDigest = censusDigestOf(plan);
  plan.populationContentDigest = digestOf(digestParts.sort().join("\n"));
  return plan;
}

/* ---------------------------------- store reads ---------------------------------- */

/** The census's read, per atom, for ONE county. Read-only; SELECT only. */
export async function readCountyAtoms(sql, county: string) {
  const rows = await sql`
    SELECT atom_did,
           content_hash,
           body->'outcome'->>'kind' AS kind,
           coalesce(body->'outcome'->>'reason', body->'absence'->>'reason') AS reason,
           (body->'outcome' ? 'zero') AS has_zero,
           body
      FROM atoms
     WHERE entity_type = 'buildable-envelope'
       AND coalesce(body->>'status', 'active') = 'active'
       AND substring(body->>'parcelNodeId' from 1 for 5) = ${county}
     ORDER BY atom_did
  `;
  return rows.map((r) => ({
    atomDid: String(r.atom_did),
    contentHash: r.content_hash === null ? "" : String(r.content_hash),
    kind: r.kind === null ? null : String(r.kind),
    reason: r.reason === null ? null : String(r.reason),
    hasZero: r.has_zero === true,
    body: r.body,
  }));
}

/** A body-free fingerprint of the county, used to prove a dry run wrote nothing. */
export async function readCountyPopulationFingerprint(sql, county: string) {
  const rows = await sql`
    SELECT atom_did,
           body->'outcome'->>'kind' AS kind,
           coalesce(body->'outcome'->>'reason', body->'absence'->>'reason') AS reason,
           (body->'outcome' ? 'zero') AS has_zero
      FROM atoms
     WHERE entity_type = 'buildable-envelope'
       AND coalesce(body->>'status', 'active') = 'active'
       AND substring(body->>'parcelNodeId' from 1 for 5) = ${county}
     ORDER BY atom_did
  `;
  return digestOf(
    rows
      .map((r) => `${r.atom_did}|${r.kind ?? ""}|${r.reason ?? ""}|${r.has_zero === true}`)
      .join("\n"),
  );
}

/* ---------------------------------- the writer core ---------------------------------- */

/**
 * Apply one county's plan. NOT guarded by the CLI's Cloud-Run gate — this is the core the
 * fixture-store tests call (see "WHAT BYPASSES THIS" (b)). It DOES take the write lease itself,
 * so it still fails closed without a live scope.
 *
 * The journal row and the body UPDATE go in the SAME transaction, journal first, so the record
 * cannot be missing when the write commits and the write cannot commit if the record fails.
 *
 * `beforeBodies` MUST be the bodies the plan was built from; the core refuses if an atom in the
 * plan has no before-body, because a journal row without the state it restores is not a record.
 */
export async function applyCountyMovement(
  sql,
  options: {
    plan: CountyPlan;
    /** The rows the plan was built from — the ONLY source of the before-state, never a caller's guess. */
    rows: ReadonlyArray<{ atomDid: string; contentHash: string; body: unknown }>;
    runId: string;
    holderLabel: string;
    batchSize?: number;
    now?: () => Date;
  },
): Promise<{ moved: number; journalRows: number; batches: number }> {
  const { plan, rows, runId, holderLabel } = options;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, 1000));
  if (!plan.movable.length) return { moved: 0, journalRows: 0, batches: 0 };

  const before = new Map<string, { contentHash: string; body: Record<string, unknown> }>();
  for (const r of rows) {
    if (r.body && typeof r.body === "object") {
      before.set(r.atomDid, {
        contentHash: r.contentHash,
        body: r.body as Record<string, unknown>,
      });
    }
  }

  const lease = await takeScopedLease(sql, {
    scope: { scope_type: "write", entity_type: "buildable-envelope", county_fips: plan.county },
    holder_label: holderLabel,
    run_id: runId,
  });

  let moved = 0;
  let journalRows = 0;
  let batches = 0;
  try {
    for (let i = 0; i < plan.movable.length; i += batchSize) {
      const slice = plan.movable.slice(i, i + batchSize);
      batches += 1;
      const appliedAt = (options.now ?? (() => new Date()))();

      const prepared = slice.map((atom) => {
        const prior = before.get(atom.atomDid);
        if (!prior) {
          refuse(
            "P263_BEFORE_BODY_MISSING",
            `no before-state loaded for ${atom.atomDid} — refusing to write a journal row ` +
              `without the state it restores`,
            { atomDid: atom.atomDid },
          );
        }
        const outcome = assertMovable(atom.bucket, atom.reason);
        /**
         * The content hash is recomputed the way the EMITTER does it: the field is emptied,
         * then the body is hashed, then the hash is written into it. Hashing a body that still
         * carried the PREVIOUS hash would fold the old hash into the new one
         * (`contentHash` is not in PROVENANCE_KEYS).
         */
        const afterHashed = { ...prior.body, outcome, contentHash: "" };
        const afterContentHash = contentHashExcludingProvenance(afterHashed);
        const afterBody = { ...afterHashed, contentHash: afterContentHash };
        return {
          atom_did: atom.atomDid,
          bucket: atom.bucket,
          movement: atom.movement,
          beforeBody: prior.body,
          before_content_hash: prior.contentHash,
          afterBody,
          after_content_hash: afterContentHash,
        };
      });

      await sql.begin(async (txn) => {
        /**
         * THE RECORD, BEFORE THE WRITE. ON CONFLICT DO NOTHING + a count check is what refuses
         * a re-run of the same run_id rather than silently re-moving.
         *
         * The jsonb columns take a JS value through `txn.json()` — NOT `JSON.stringify(x)` with
         * an explicit `::jsonb` cast. postgres.js JSON-encodes a value it is told is jsonb, so
         * passing pre-stringified text and casting double-encodes it into a jsonb STRING (proven
         * against a live Postgres while building this file: `jsonb_to_recordset` on that shape
         * raises `cannot call jsonb_to_recordset on a non-array`).
         */
        const journalRecords = prepared.map((row) => ({
          run_id: runId,
          county_fips: plan.county,
          atom_did: row.atom_did,
          bucket: row.bucket,
          movement: row.movement,
          applied_at: appliedAt,
          before_body: txn.json(row.beforeBody),
          before_content_hash: row.before_content_hash,
          after_body: txn.json(row.afterBody),
          after_content_hash: row.after_content_hash,
        }));
        const inserted = await txn`
          INSERT INTO envelope_outcome_movement_journal ${txn(
            journalRecords,
            "run_id",
            "county_fips",
            "atom_did",
            "bucket",
            "movement",
            "applied_at",
            "before_body",
            "before_content_hash",
            "after_body",
            "after_content_hash",
          )}
          ON CONFLICT (run_id, atom_did) DO NOTHING
          RETURNING id
        `;
        if (inserted.length !== slice.length) {
          refuse(
            "P263_JOURNAL_ALREADY_WRITTEN",
            `journal accepted ${inserted.length} of ${slice.length} rows for run ${runId} — ` +
              `these atoms already carry a journal row for this run. NOTHING WAS WRITTEN. ` +
              `Use a new --run-id, or reverse run ${runId} first.`,
            { runId, county: plan.county, accepted: inserted.length, attempted: slice.length },
          );
        }
        journalRows += inserted.length;

        // 2. THE WRITE.
        for (const row of prepared) {
          const updated = await txn`
            UPDATE atoms
               SET body = ${txn.json(row.afterBody)},
                   content_hash = ${row.after_content_hash},
                   updated_at = now()
             WHERE atom_did = ${row.atom_did}
               AND entity_type = 'buildable-envelope'
            RETURNING atom_did
          `;
          if (updated.length !== 1) {
            refuse(
              "P263_ATOM_NOT_UPDATED",
              `expected exactly 1 row for ${row.atom_did}, updated ${updated.length}`,
              { atomDid: row.atom_did },
            );
          }
        }
      });
      moved += slice.length;
    }
  } finally {
    await releaseScopedLease(sql, lease);
  }
  return { moved, journalRows, batches };
}

/* ---------------------------------- reversal ---------------------------------- */

/**
 * Reverse a whole journal run: restore every not-yet-reversed row's before-state and mark it.
 * Restore precedes the mark in the same transaction, so a crash between them leaves the row
 * unmarked and therefore still reversible.
 */
export async function reverseMovementRun(
  sql,
  options: {
    journalRunId: string;
    reversalRunId: string;
    county?: string | null;
    batchSize?: number;
  },
): Promise<{ reversed: number; batches: number }> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, 1000));
  const county = options.county ?? null;

  const rows = await sql`
    SELECT id, atom_did
      FROM envelope_outcome_movement_journal
     WHERE run_id = ${options.journalRunId}
       AND reversed_at IS NULL
       AND (${county}::text IS NULL OR county_fips = ${county})
     ORDER BY id
  `;
  if (rows.length === 0) return { reversed: 0, batches: 0 };

  let reversed = 0;
  let batches = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    batches += 1;
    const ids = slice.map((r) => Number(r.id));
    const now = new Date();
    await sql.begin(async (txn) => {
      const restored = await txn`
        UPDATE atoms a
           SET body = j.before_body,
               content_hash = j.before_content_hash,
               updated_at = now()
          FROM envelope_outcome_movement_journal j
         WHERE j.id = ANY(${ids})
           AND a.atom_did = j.atom_did
           AND a.entity_type = 'buildable-envelope'
        RETURNING a.atom_did
      `;
      if (restored.length !== ids.length) {
        refuse(
          "P263_REVERSAL_INCOMPLETE",
          `restored ${restored.length} of ${ids.length} journal rows — NOTHING WAS REVERSED ` +
            `(an atom named by the journal is missing from the store)`,
          { expected: ids.length, restored: restored.length, journalRunId: options.journalRunId },
        );
      }
      const marked = await txn`
        UPDATE envelope_outcome_movement_journal
           SET reversed_at = ${now},
               reversed_by_run_id = ${options.reversalRunId}
         WHERE id = ANY(${ids})
           AND reversed_at IS NULL
        RETURNING id
      `;
      if (marked.length !== ids.length) {
        refuse(
          "P263_REVERSAL_MARK_INCOMPLETE",
          `marked ${marked.length} of ${ids.length} rows as reversed`,
          { expected: ids.length, marked: marked.length },
        );
      }
      reversed += marked.length;
    });
  }
  return { reversed, batches };
}

/* ---------------------------------- the guard ---------------------------------- */

/** F1: the cap refuses above the declared share and writes nothing; the exact token carries. */
export function evaluateCap(plan: CountyPlan, maxShare: number, override: string | null) {
  return evaluateBlastRadius({
    writer: ENVELOPE_MOVEMENT_WRITER,
    scopeKey: plan.county,
    affected: plan.moves,
    population: plan.envelopeAtomsInScope,
    maxShare,
    override,
  });
}

export function authorisationTokenFor(plan: CountyPlan): string {
  return overrideTokenFor(
    ENVELOPE_MOVEMENT_WRITER,
    plan.county,
    plan.moves,
    plan.envelopeAtomsInScope,
  );
}

/**
 * The bare VALUE of `BLAST_RADIUS_OVERRIDE` for this run — `writer:scope:affected/population`,
 * with no `NAME=` prefix. `overrideTokenFor` returns the full assignment (what an operator
 * pastes); `parseBlastRadiusOverride` reads the env value (what the guard receives), and the two
 * differ by exactly the prefix. Recorded side by side in every refusal so the paste and the
 * value can never be confused for one another.
 */
export function authorisationValueFor(plan: CountyPlan): string {
  return authorisationTokenFor(plan).slice(`${BLAST_RADIUS_OVERRIDE_ENV_VAR}=`.length);
}

/**
 * The guard, as a pure verdict. `--guard` is the recurrence control: it fires the moment a
 * mislabelled atom is on record for a county, which is the state P-263 retired. Non-zero IS the
 * firing, not a warning — the census's `--guard` exits non-zero on it and this reports the same
 * shape so a test can prove it fires on a FIXTURE WRITE rather than only reading zero after the
 * apply (DEV_PROCESS 2.2: a gating indicator is tested for its ability to fire before it is trusted).
 */
export function guardVerdict(plan: CountyPlan) {
  return {
    fires: plan.population > 0,
    mislabelledOnRecord: plan.population,
    byBucket: {
      unzoned: plan.toNotApplicable,
      noDistrict: plan.toPendingDerivation - plan.toPendingByTier1Status,
      tier1StatusAssertion: plan.toPendingByTier1Status,
      unclassifiedByReason: plan.cannotClassify,
    },
  };
}

/**
 * TASK 4 (Ruling 12's audit), as a pure verdict — and its falsifier.
 *
 * Ruling 12 withholds the unclassifiable cohort "as unverified on every surface and never served
 * as the legacy claim". The surfaces gate that on VERIFICATION (`isDepthWarmPromotedAtom` in the
 * map's claim branch, `isEnvelopeAtomVerified` in legacy-design-tools' reconciliation) and on the
 * reason branches (a reason that names a failed computation is declined before any claim). So the
 * ruling holds on every surface TODAY exactly when the cohort is unpromoted; a promoted member
 * reaches the claim branch and is served the legacy sentence with a `0%` figure.
 *
 * This is deliberately reported as a verdict with the count, not asserted as `ok`: the honest
 * reading is `withheld-everywhere` at zero and `ESCAPES-THE-PROMOTION-GATE` above it, and the
 * artifact carries the atom DIDs of the escape set so the finding is actionable rather than a
 * number. NOTE the axis: the ENGINE's own `isHonestZeroOutcome` (no computed zero -> no claim) is
 * the predicate Ruling 12 actually states, and the surfaces do not implement it — the map's
 * `AtomChainEnvelopeOutcome` does not even carry `zero` on the wire. Whether that gap is worth
 * closing is P-343's call, and this verdict is the evidence it needs.
 */
export function ruling12Verdict(
  plan: Pick<CountyPlan, "cannotClassify" | "cannotClassifyPromoted" | "cannotClassifyPromotedDids">,
) {
  const escapes = plan.cannotClassifyPromoted;
  return {
    withheld: plan.cannotClassify,
    withheldAndPromoted: escapes,
    withheldAndPromotedDids: plan.cannotClassifyPromotedDids,
    verdict: escapes === 0 ? "withheld-everywhere" : "ESCAPES-THE-PROMOTION-GATE",
    surfacesGateOn: "depth-warm promotion (P-216/P-249), NOT on a computed zero proof",
    why:
      escapes === 0
        ? `Every one of this county's ${plan.cannotClassify} withheld atoms is unpromoted, so the ` +
          `reason branches and the promotion gate withhold it on both producers ` +
          `(hauska-map's claim branch, legacy-design-tools' reconciliation). The legacy sentence ` +
          `is unreachable for this cohort on the surfaces audited.`
        : `${escapes} of this county's ${plan.cannotClassify} withheld atoms carry the depth-warm ` +
          `promotion marker, so the surfaces' gate does not withhold them: audited by reading, a ` +
          `PROMOTED reason-less \`no-buildable-area\` atom reaches hauska-map's claim branch ` +
          `(atom-chain-to-facets.ts, \`outcomeKind === "no-buildable-area" && depthWarm\`) and ` +
          `legacy-design-tools' fallback (\`rawReason ?? "Setbacks consume the lot…"\`), where ` +
          `nothing tests for a computed zero. It is withheld today only when a reason is present. ` +
          `That is a finding, not a pass (P-343).`,
  };
}


/**
 * F3: after a county applies, the guard must read ZERO mislabelled atoms for it — meaning zero
 * atoms left in a MOVABLE bucket (the ones this apply exists to fix). Both movable buckets must
 * be empty, the total population must equal the atoms that were ALREADY unclassifiable (nothing
 * else may remain), and `unclassifiedByReason` must be UNCHANGED — the apply does not sweep them
 * (Ruling 12).
 *
 * `censusGuardWouldFire` exists because P-263's `--guard` counts the WHOLE population — every
 * `no-buildable-area` with no zero proof — so on a county that carries a withheld cohort it still
 * exits non-zero AFTER a clean apply. That is the expected state until P-343 fixes those atoms,
 * and it is reported here rather than left for an operator to discover by running the two
 * instruments and finding them disagree about one word.
 */
export function postStateVerdict(
  before: Pick<CountyPlan, "toNotApplicable" | "toPendingDerivation" | "cannotClassify">,
  after: Pick<
    CountyPlan,
    "population" | "toNotApplicable" | "toPendingDerivation" | "cannotClassify"
  >,
) {
  const mislabelledMovable = after.toNotApplicable + after.toPendingDerivation;
  const unclassifiedDelta = after.cannotClassify - before.cannotClassify;
  const populationDelta = after.population - before.cannotClassify;
  const withheldPendingP343 = after.cannotClassify;
  return {
    ok: mislabelledMovable === 0 && unclassifiedDelta === 0 && populationDelta === 0,
    mislabelledMovable,
    withheldPendingP343,
    unclassifiedDelta,
    populationDelta,
    censusGuardWouldFire: withheldPendingP343 > 0,
    censusGuardWouldFireBecause:
      withheldPendingP343 > 0
        ? `${withheldPendingP343} atoms are withheld as unverified (OPS-16 A-215 Ruling 12): their ` +
          `reason names a FAILED computation. This apply does not move them, and P-263's --guard ` +
          `counts the whole population, so it still reports them. ZERO movable atoms remain.`
        : null,
    afterMislabelledBuckets: {
      unzonedWouldRemain: after.toNotApplicable,
      noDistrictWouldRemain: after.toPendingDerivation,
    },
  };
}

/* ---------------------------------- CLI ---------------------------------- */

async function main() {
  const argv = process.argv.slice(2);
  const jsonOut = readArg(argv, "--json");
  const url = resolveSubstrateDatabaseUrl();
  if (!url) {
    console.error("FATAL: SUBSTRATE_DATABASE_URL / DATABASE_URL required");
    process.exit(1);
  }
  const hostFingerprint = storeHostFingerprint(url);
  const sql = openSubstrateClient(url);

  try {
    if (hasFlag(argv, "--reverse")) {
      const journalRunId = readArg(argv, "--journal-run-id");
      if (!journalRunId) {
        refuse("USAGE", "--reverse requires --journal-run-id=<the run_id of the apply to undo>");
      }
      const runIdArg = readArg(argv, "--run-id");
      const reversalRunId = runIdArg ?? `p342-reverse:${journalRunId}`;
      const county = readArg(argv, "--county");
      const result = await reverseMovementRun(sql, {
        journalRunId,
        reversalRunId,
        county,
        batchSize: Number(readArg(argv, "--batch-size") ?? DEFAULT_BATCH_SIZE),
      });
      const artifact = {
        instrument: "p263-envelope-outcome-apply",
        mode: "REVERSE",
        ranAt: new Date().toISOString(),
        storeHostFingerprint: hostFingerprint,
        journalRunId,
        reversalRunId,
        county: county ?? null,
        reversed: result.reversed,
        batches: result.batches,
      };
      if (jsonOut) writeFileSync(jsonOut, JSON.stringify(artifact, null, 2));
      console.log(JSON.stringify(artifact, null, 2));
      return;
    }

    const county = readArg(argv, "--county");
    if (!county) refuse("COUNTY_REQUIRED", "--county=<fips> is required");
    if (!(SIX_COUNTIES as readonly string[]).includes(county)) {
      refuse(
        "COUNTY_NOT_IN_SCOPE",
        `--county=${county} is not one of the six Phase-0 counties (${SIX_COUNTIES.join(",")})`,
      );
    }

    const apply = hasFlag(argv, "--apply");
    const guardOnly = hasFlag(argv, "--guard");
    const rawShare = readArg(argv, "--blast-radius-max-share");
    const maxShare = rawShare === null ? null : Number(rawShare);
    const expectDigest = readArg(argv, "--expect-digest");
    const runIdArg = readArg(argv, "--run-id");
    const batchSize = Number(readArg(argv, "--batch-size") ?? DEFAULT_BATCH_SIZE);

    // ---- 1. THE CAP. Declared, never defaulted.
    if (maxShare === null || !Number.isFinite(maxShare) || !(maxShare > 0 && maxShare < 1)) {
      const err = new Error(
        `--blast-radius-max-share is REQUIRED and must be 0 < share < 1 (got ${JSON.stringify(rawShare)}). ` +
          `P-213's guard refuses to run without a caller-declared threshold; this lane does not own ` +
          `that number. Re-run with --blast-radius-max-share=<the county's declared share, with its basis>.`,
      );
      err.code = "BLAST_RADIUS_UNMEASURED";
      console.error(
        JSON.stringify({
          event: "p263-envelope-outcome-apply.cap-missing",
          refuseCode: err.code,
          county,
          message: err.message,
        }),
      );
      process.exitCode = 1;
      return;
    }

    const rows = await readCountyAtoms(sql, county);
    const plan = planCounty(county, rows);

    const override = process.env[BLAST_RADIUS_OVERRIDE_ENV_VAR] ?? null;
    let cap;
    try {
      cap = evaluateCap(plan, maxShare, override);
    } catch (error) {
      const record = {
        instrument: "p263-envelope-outcome-apply",
        mode: apply ? "APPLY-BLOCKED-BY-CAP" : "DRY-RUN-BLOCKED-BY-CAP",
        county,
        countyName: plan.countyName,
        storeHostFingerprint: hostFingerprint,
        refuseCode: error?.code ?? "THREW",
        message: String(error?.message ?? error),
        requiredAuthorisation: /BLAST_RADIUS_EXCEEDED/.test(error?.code ?? "")
          ? authorisationTokenFor(plan)
          : null,
        plan: {
          population: plan.population,
          moves: plan.moves,
          envelopeAtomsInScope: plan.envelopeAtomsInScope,
          censusDigest: plan.censusDigest,
          /**
           * The buckets and the Ruling-12 verdict travel WITH the refusal: a control that hides
           * the measurement it refused on cannot be audited, and the operator deciding whether to
           * authorise needs exactly these numbers and no second run.
           */
          toNotApplicable: plan.toNotApplicable,
          toPendingDerivation: plan.toPendingDerivation,
          toPendingByTier1Status: plan.toPendingByTier1Status,
          cannotClassify: plan.cannotClassify,
          alreadyComputedZero: plan.alreadyComputedZero,
          notNoBuildableArea: plan.notNoBuildableArea,
          cannotClassifyPromoted: plan.cannotClassifyPromoted,
          ruling12: ruling12Verdict(plan),
        },
      };
      if (jsonOut) writeFileSync(jsonOut, JSON.stringify(record, null, 2));
      console.error(JSON.stringify(record, null, 2));
      process.exitCode = 1;
      return;
    }

    // ---- 2. CENSUS DRIFT. --apply must be pinned to the reviewed measurement.
    if (apply) {
      if (!expectDigest) {
        refuse(
          "CENSUS_DRIFT",
          `--apply requires --expect-digest=<sha256> (the digest a reviewed dry run printed). ` +
            `This county's fresh census digests to ${plan.censusDigest}. A run that is not pinned ` +
            `to the measurement it was authorised against is refused.`,
          { county, censusDigest: plan.censusDigest },
        );
      }
      if (expectDigest !== plan.censusDigest) {
        refuse(
          "CENSUS_DRIFT",
          `--expect-digest=${expectDigest} but this county's fresh census digests to ` +
            `${plan.censusDigest} — the population or a bucket moved since the authorisation was ` +
            `made, so it does not carry. NOTHING WAS WRITTEN. Re-run the dry run and re-authorise.`,
          { county, expected: expectDigest, measured: plan.censusDigest },
        );
      }
    }

    // ---- 3. THE LEASE. --apply only.
    if (apply) {
      if (refuseApplyWithoutRunId("p263-envelope-outcome-apply", apply, runIdArg)) {
        process.exitCode = 1;
        return;
      }
      if (refuseApplyOutsideCloudRunJob("p263-envelope-outcome-apply", apply)) {
        process.exitCode = 1;
        return;
      }
    }

    const artifact = {
      instrument: "p263-envelope-outcome-apply",
      mode: apply ? "APPLY" : "DRY-RUN (read-only; no write lease taken)",
      ranAt: new Date().toISOString(),
      storeHostFingerprint: hostFingerprint,
      writer: ENVELOPE_MOVEMENT_WRITER,
      county: plan.county,
      countyName: plan.countyName,
      countingRule: ENVELOPE_MOVEMENT_COUNTING_RULE,
      declaredMaxShare: maxShare,
      blastRadius: cap,
      requiredAuthorisation: authorisationTokenFor(plan),
      requiredAuthorisationEnvValue: authorisationValueFor(plan),
      expectDigest: expectDigest ?? null,
      plan: {
        envelopeAtomsInScope: plan.envelopeAtomsInScope,
        population: plan.population,
        toNotApplicable: plan.toNotApplicable,
        toPendingDerivation: plan.toPendingDerivation,
        toPendingByTier1Status: plan.toPendingByTier1Status,
        cannotClassify: plan.cannotClassify,
        cannotClassifyPromoted: plan.cannotClassifyPromoted,
        cannotClassifyPromotedDids: plan.cannotClassifyPromotedDids,
        populationPromoted: plan.populationPromoted,
        alreadyComputedZero: plan.alreadyComputedZero,
        notNoBuildableArea: plan.notNoBuildableArea,
        moves: plan.moves,
        censusDigest: plan.censusDigest,
        populationContentDigest: plan.populationContentDigest,
      },
      /**
       * TASK 4 — the withheld cohort, on the axis the serving surfaces gate on. Present in both
       * modes: a dry run is where the operator reads it, and the apply's post-state names what the
       * apply deliberately did NOT touch.
       */
      ruling12: ruling12Verdict(plan),
      writes: null as unknown,
      guard: null as unknown,
    };

    if (guardOnly && !apply) {
      artifact.guard = {
        mode: "GUARD (read-only)",
        ...guardVerdict(plan),
        why:
          "buildable-envelope atoms claim `no-buildable-area` (served to the customer as 'Setbacks " +
          "consume the lot') with no computed zero behind them. Non-zero means the state P-263 " +
          "retired is still on record for this county; after this lane's apply it must read zero.",
      };
    }

    if (apply) {
      const result = await applyCountyMovement(sql, {
        plan,
        rows,
        runId: runIdArg as string,
        holderLabel: process.env.CLOUD_RUN_EXECUTION?.trim() || "p342-local",
        batchSize,
      });
      const afterRows = await readCountyAtoms(sql, county);
      const after = planCounty(county, afterRows);
      const verdict = postStateVerdict(plan, after);
      artifact.writes = {
        moved: result.moved,
        journalRows: result.journalRows,
        batches: result.batches,
        runId: runIdArg,
        reversal:
          `tsx scripts/p263-envelope-outcome-apply.mts --reverse ` +
          `--journal-run-id=${runIdArg} --county=${county}`,
      };
      artifact.guard = {
        mode: "POST-APPLY GUARD",
        countyPopulationAfter: after.population,
        mislabelledMovableAfter: verdict.mislabelledMovable,
        withheldPendingP343: verdict.withheldPendingP343,
        unclassifiedDelta: verdict.unclassifiedDelta,
        populationDelta: verdict.populationDelta,
        censusGuardWouldFire: verdict.censusGuardWouldFire,
        censusGuardWouldFireBecause: verdict.censusGuardWouldFireBecause,
        ok: verdict.ok,
        detail: verdict.afterMislabelledBuckets,
        /**
         * Re-measured on the POST state: the withheld cohort is not moved by construction, so a
         * changed escape count here would mean the write touched atoms Ruling 12 withholds.
         */
        ruling12: ruling12Verdict(after),
      };
      if (jsonOut) writeFileSync(jsonOut, JSON.stringify(artifact, null, 2));
      console.log(JSON.stringify(artifact, null, 2));
      if (!verdict.ok) {
        console.error(
          JSON.stringify({
            event: "P263_POST_STATE_NOT_MOVED",
            refused: true,
            county,
            mislabelledMovableAfter: verdict.mislabelledMovable,
            unclassifiedDelta: verdict.unclassifiedDelta,
            populationDelta: verdict.populationDelta,
          }),
        );
        process.exitCode = 1;
      }
      return;
    }

    // Dry run must PROVE it wrote nothing: two identical reads, compared.
    const fingerprintBefore = await readCountyPopulationFingerprint(sql, county);
    const fingerprintAfter = await readCountyPopulationFingerprint(sql, county);
    artifact.writes = {
      statementsIssued: "SELECT only (two identical population fingerprint reads)",
      unchangedBetweenReads: fingerprintBefore === fingerprintAfter,
      populationFingerprint: fingerprintAfter,
    };
    if (jsonOut) writeFileSync(jsonOut, JSON.stringify(artifact, null, 2));
    console.log(JSON.stringify(artifact, null, 2));
    if (fingerprintBefore !== fingerprintAfter) {
      console.error(JSON.stringify({ event: "P263_DRY_RUN_DRIFT", refused: true, county }));
      process.exitCode = 1;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const invoked = process.argv[1]?.replace(/\\/g, "/").endsWith("p263-envelope-outcome-apply.mts");
if (invoked) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        event: "p263-envelope-outcome-apply.fatal",
        refuseCode: error?.code ?? null,
        message: String(error?.message ?? error),
      }),
    );
    process.exitCode = 1;
  });
}
