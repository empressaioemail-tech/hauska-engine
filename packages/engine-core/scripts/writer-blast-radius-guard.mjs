/**
 * P-213: a generic, pre-write refusal for any batch writer that would transition a large share
 * of a population to a destructive state in one run.
 *
 * ---------------------------------------------------------------------------------------------
 * THE INCIDENT THIS PREVENTS
 * ---------------------------------------------------------------------------------------------
 *
 * P-212: `reconcileCountyParcelNodes` (packages/engine-core/src/parcel-node/reconcile-county-
 * parcel-nodes.ts) computed an unconditional set difference between a county's prior active
 * `parcel-node` rows and a new plan, and `write-parcel-node-county.mjs` wrote every id in that
 * difference to `status: "retired"` with no share check, no threshold, and no authorization gate.
 * One run built from an undersized plan marked 57,704 of Bastrop's 62,394 parcel-node atoms
 * retired (92.5 percent); 19 of 20 sampled retirements were live, current accounts at the
 * county's own cadastral source. Every row-level check in that path passed — the comparator's
 * key construction was correct, the write-then-verify confirmed the stored bytes matched what
 * was sent — because none of them can see a population. The defect was only visible at the
 * population level, and nothing was looking there.
 *
 * GENERIC BY DESIGN. This module is not a parcel-node control and must not become one. It
 * protects any batch writer that flips a status on a set of ids computed by SOME comparison
 * against a prior state — the exact shape of `reconcileCountyParcelNodes` /
 * `reconcileCountyRoadNodes`, and of any future writer built the same way.
 *
 * ---------------------------------------------------------------------------------------------
 * THE THREE-QUESTION GATE
 * ---------------------------------------------------------------------------------------------
 *
 *   1. What executes this?  `evaluateBlastRadius`, called by a batch writer BEFORE it takes a
 *      write lease or issues a write, with the share of ITS population it is about to move to a
 *      destructive state.
 *   2. What triggers it?    Every invocation the writer wires it into — this module does nothing
 *      unless a call site imports and calls it.
 *   3. What fails?          `evaluateBlastRadius` THROWS `BLAST_RADIUS_EXCEEDED` (or
 *      `BLAST_RADIUS_UNMEASURED`, `BLAST_RADIUS_OVERRIDE_MALFORMED`,
 *      `BLAST_RADIUS_OVERRIDE_MISMATCH`) when the measured share exceeds the caller's declared
 *      threshold and no valid, matching authorization was supplied. The caller must not catch
 *      this and continue; it must propagate before any write.
 *   4. What bypasses it?    STATED, because the answer is never none:
 *      (a) Any batch writer that never calls this module. P-328 reduced this list by wiring
 *          `write-road-node-county.mjs` / `reconcileCountyRoadNodes`, which had the IDENTICAL
 *          unconditional-orphan-retirement shape as the parcel-node writer this module was first
 *          wired into (same set-difference, same unconditional retirement, no threshold) and went
 *          unguarded for the whole life of the parcel-node guard. Every other `write-*-county.mjs`
 *          / `write-setback-city.mjs` writer in this package that does not call
 *          `evaluateBlastRadius` is still unguarded for whatever destructive transitions it
 *          performs; `destructive-write-declaration.mjs`'s `DESTRUCTIVE_WRITERS` enumerates the
 *          destructive ones and says, per writer, whether it is wired and why not.
 *      (b) A raw Postgres connection, or a hand `UPDATE atoms SET body = jsonb_set(...)`, issued
 *          outside the guarded writer's own code path. This module has no way to see a write it
 *          is not called from.
 *      (c) `review-retired-parcel-nodes.mjs`'s reactivation path — the opposite direction
 *          (retired -> active), out of THIS module's "destructive transition" scope. P-328 gave
 *          it its own refusal (`retired-reactivation-guard.mjs`), reading the SAME declared
 *          number and authorisation from `destructive-write-declaration.mjs`; a mass,
 *          unwarranted reactivation is a different failure mode with its own live-corroboration
 *          gate, not a "destructive state" one.
 *      (d) The ten-minute `factory-conformant reap` schedule (named, not touched, per this row's
 *          own explicit scope: it is flagged as worth auditing separately, not assumed defective).
 *      (e) Deleting or reverting this module, or a caller catching its throw and proceeding
 *          anyway. Nothing outside the calling writer enforces that it does not.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IS COMPARED
 * ---------------------------------------------------------------------------------------------
 *
 * `affected`   the count of ids THIS run would transition to the destructive state (e.g. orphans
 *              about to be retired).
 * `population` the size of the set `affected` is drawn from (e.g. the prior active rows the
 *              reconcile examined). NOT the new plan's size and NOT the store's total row count
 *              for unrelated counties — the population a caller measures is exactly the
 *              denominator its own share claim depends on, so a wrong denominator here is the
 *              same class of error `publish-coverage-floor.mjs` (P-236, hauska-factory) guards on
 *              its own two populations.
 *
 * `share = affected / population`. `population === 0` (nothing existed before this run touched
 * it — e.g. a county's first-ever load) can never be a "collapse": there is nothing to collapse
 * FROM, so it passes under its own basis (`no-population`), same reasoning as P-236's
 * `no-prior`/`priorBasis` split. `affected === 0` always passes (`no-change`).
 *
 * ---------------------------------------------------------------------------------------------
 * THE THRESHOLD IS ONE DECLARED NUMBER, PASSED IN
 * ---------------------------------------------------------------------------------------------
 *
 * `maxShare` is supplied by the CALLER, not this module, and since P-328 every engine caller
 * imports the SAME value (`MAX_DESTRUCTIVE_SHARE` from `destructive-write-declaration.mjs`) rather
 * than declaring its own — the engine's parcel-node writer carried `MAX_ORPHAN_SHARE = 0.05` and
 * its reactivation writer carried `MAX_REACTIVATION_SHARE = 0.05` before this row, two declarations
 * of a number the program had already declared once. This module still refuses to run without a
 * declared `0 < maxShare < 1`: a shared guard with a built-in default would let a threshold be a
 * config value nobody chose, which is exactly what this control exists to prevent. The number
 * itself is the program's, declared in hauska-factory and carried here by
 * `destructive-write-declaration.mjs` with a pinned ref and a drift check.
 *
 * ---------------------------------------------------------------------------------------------
 * THE OVERRIDE, PORTED FROM P-236's publish-coverage-floor.mjs
 * ---------------------------------------------------------------------------------------------
 *
 *     DESTRUCTIVE_WRITE_AUTHORISATION=<writer>:<scopeKey>:<affected>/<population>
 *     e.g. DESTRUCTIVE_WRITE_AUTHORISATION=parcel-node-county-reconcile:48021:57704/62394
 *
 * P-328: the variable NAME and the declared number are now the PROGRAM'S, read from
 * `destructive-write-declaration.mjs` (which is pinned to the factory's declaration). They were
 * the engine's own (`BLAST_RADIUS_OVERRIDE`, 0.05) until this row; the token GRAMMAR was already
 * identical, so what P-328 unified is the name and the number, not the shape.
 *
 * Names the writer, the scope (e.g. county FIPS) AND both measured counts, exactly, for the
 * same reasons P-236's override does: it cannot be written before the refusal exists to read the
 * numbers from, it expires the moment either count moves, and it is per-invocation, never a
 * template default. A present-but-not-needed override is recorded as `overridePresentUnused`
 * rather than silently ignored, so a stale authorization left on a job is visible even when it
 * did not fire.
 */

import { AUTHORISATION_ENV_VAR, REFUSAL_CODES } from "./destructive-write-declaration.mjs";

export const BLAST_RADIUS_EXCEEDED = REFUSAL_CODES.engine.blastRadius;
export const BLAST_RADIUS_UNMEASURED = REFUSAL_CODES.engine.unmeasured;
export const BLAST_RADIUS_OVERRIDE_MALFORMED = REFUSAL_CODES.engine.overrideMalformed;
export const BLAST_RADIUS_OVERRIDE_MISMATCH = REFUSAL_CODES.engine.overrideMismatch;

export const OVERRIDE_ENV_VAR = AUTHORISATION_ENV_VAR;

function refuse(code, message, detail = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, detail);
  throw err;
}

/** An integer >= 0, or it was not measured. undefined, null, "", NaN and negatives are unmeasured. */
function measuredCount(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

/**
 * The authorization token, pure. Returns null for an absent override (the common case) and
 * throws `BLAST_RADIUS_OVERRIDE_MALFORMED` for a present-but-unparseable one — a typo must not
 * silently read as "no override supplied".
 */
export function parseBlastRadiusOverride(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const s = String(raw).trim();
  const m = /^([a-z][a-z0-9._-]*):([^:]+):(\d+)\/(\d+)$/i.exec(s);
  if (!m) {
    refuse(
      BLAST_RADIUS_OVERRIDE_MALFORMED,
      `${OVERRIDE_ENV_VAR} must be <writer>:<scopeKey>:<affected>/<population> ` +
        `(e.g. parcel-node-county-reconcile:48021:57704/62394); got ${JSON.stringify(s)}`,
      { raw: s },
    );
  }
  return { writer: m[1], scopeKey: m[2], affected: Number(m[3]), population: Number(m[4]), raw: s };
}

/** The token an operator would have to supply to authorize THIS measured run, and no other. */
export function overrideTokenFor(writer, scopeKey, affected, population) {
  return `${OVERRIDE_ENV_VAR}=${writer}:${scopeKey}:${affected}/${population}`;
}

/**
 * Pure. Fixture-testable without a store or a writer, so every refusal — and every pass — is
 * provable by violation. Never logs; a caller that wants a record on the pass path as well as the
 * refusal path reads the return value (pass) or `err.record` (refusal).
 *
 *   writer      stable identifier for the calling writer (e.g. "parcel-node-county-reconcile").
 *               Part of the override token so an authorization for one writer can never silently
 *               carry into another.
 *   scopeKey    the batch's scope (e.g. county FIPS). String or number; compared as a string.
 *   affected    count of ids this run would move to the destructive state.
 *   population  size of the set `affected` is drawn from.
 *   maxShare    REQUIRED, 0 < maxShare < 1. The caller's own declared threshold; see the header.
 *   override    the raw override string (typically `process.env[OVERRIDE_ENV_VAR]`), or null.
 *
 * Throws on refusal; returns a verdict object `{ ok: true, ... }` on every passing basis
 * (`no-population`, `no-change`, `within-threshold`, `override-authorised`).
 */
export function evaluateBlastRadius({
  writer,
  scopeKey,
  affected,
  population,
  maxShare,
  override = null,
} = {}) {
  if (!writer || scopeKey === null || scopeKey === undefined || scopeKey === "") {
    throw new Error("evaluateBlastRadius requires a non-empty writer and scopeKey");
  }
  if (!(typeof maxShare === "number" && maxShare > 0 && maxShare < 1)) {
    throw new Error(
      `evaluateBlastRadius requires a declared 0 < maxShare < 1 from the caller; got ${maxShare}`,
    );
  }

  const scope = String(scopeKey);
  const parsedOverride = parseBlastRadiusOverride(override);

  const affectedCount = measuredCount(affected);
  const populationCount = measuredCount(population);
  if (affectedCount === null || populationCount === null) {
    refuse(
      BLAST_RADIUS_UNMEASURED,
      `blast-radius guard for ${writer}/${scope} could not measure its population ` +
        `(affected=${JSON.stringify(affected)}, population=${JSON.stringify(population)}) -- ` +
        "an unmeasured population is not safe to write against",
      { writer, scopeKey: scope, affected, population },
    );
  }

  const base = {
    ok: true,
    writer,
    scopeKey: scope,
    affected: affectedCount,
    population: populationCount,
    maxShare,
    override: null,
    overridePresentUnused: parsedOverride !== null,
  };

  // No prior population: there is nothing to collapse FROM. A first-ever run must not be
  // refused for it, same reasoning as P-236's `no-prior`.
  if (populationCount === 0) {
    return { ...base, basis: "no-population", share: null };
  }

  const share = affectedCount / populationCount;
  if (share <= maxShare) {
    return { ...base, basis: affectedCount === 0 ? "no-change" : "within-threshold", share };
  }

  const token = overrideTokenFor(writer, scope, affectedCount, populationCount);
  const wouldHaveDone =
    `transition ${affectedCount} of ${populationCount} (${(share * 100).toFixed(2)}%) to the destructive state`;

  if (parsedOverride) {
    if (parsedOverride.writer !== writer || parsedOverride.scopeKey !== scope) {
      refuse(
        BLAST_RADIUS_OVERRIDE_MISMATCH,
        `${OVERRIDE_ENV_VAR} authorizes ${parsedOverride.writer}/${parsedOverride.scopeKey}; ` +
          `this run is ${writer}/${scope}. An authorization is for one measured run in one ` +
          `writer/scope, never a template. Correct token: ${token}`,
        { writer, scopeKey: scope, override: parsedOverride, expectedToken: token, share, affected: affectedCount, population: populationCount },
      );
    }
    if (parsedOverride.affected !== affectedCount || parsedOverride.population !== populationCount) {
      refuse(
        BLAST_RADIUS_OVERRIDE_MISMATCH,
        `${OVERRIDE_ENV_VAR} authorizes ${parsedOverride.affected}/${parsedOverride.population}; ` +
          `this run measures ${affectedCount}/${populationCount}. The populations moved since ` +
          `that authorization was made, so it does not carry. Correct token: ${token}`,
        { writer, scopeKey: scope, override: parsedOverride, expectedToken: token, share, affected: affectedCount, population: populationCount },
      );
    }
    return {
      ...base,
      basis: "override-authorised",
      share,
      overridePresentUnused: false,
      override: { authorised: true, raw: parsedOverride.raw, affected: parsedOverride.affected, population: parsedOverride.population },
    };
  }

  refuse(
    BLAST_RADIUS_EXCEEDED,
    `${writer}/${scope} would ${wouldHaveDone} (declared threshold ${(maxShare * 100).toFixed(2)}%). ` +
      `NOTHING WAS WRITTEN. To authorize THIS measured run and no other, re-execute with ${token}`,
    {
      writer,
      scopeKey: scope,
      affected: affectedCount,
      population: populationCount,
      share,
      maxShare,
      expectedToken: token,
      wouldHaveDone,
      record: {
        ok: false,
        refuseCode: BLAST_RADIUS_EXCEEDED,
        writer,
        scopeKey: scope,
        affected: affectedCount,
        population: populationCount,
        share,
        maxShare,
        wouldHaveDone,
      },
    },
  );
}
