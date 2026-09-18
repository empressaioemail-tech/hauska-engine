/**
 * P-213: the generic blast-radius guard.
 *
 * PRE-REGISTERED FALSIFIERS (written before any of these were run):
 *
 *   F1  A run that would transition a share above the declared threshold REFUSES and the
 *       simulated writer's write function is never called.
 *       Would falsify: any outcome where the write function is invoked, or where the refusal
 *       carries no share/population/affected.
 *   F2  A run below the threshold PASSES and the simulated writer's write function IS called
 *       with the expected batch. Would falsify: a guard that refuses a healthy run, which is how
 *       a control gets disabled by the first writer it blocks.
 *   F3  A first-ever run (population === 0) and a no-op run (affected === 0) are their own bases,
 *       never folded into "within-threshold" and never refused.
 *   F4  The override is not a habit-flag: only an exact <writer>:<scopeKey>:<affected>/
 *       <population> match passes; a mismatched writer, scope, or either count refuses with its
 *       own code.
 *
 * Every refusal below is proven BY VIOLATION. A check observed only passing has not been
 * observed working.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BLAST_RADIUS_EXCEEDED,
  BLAST_RADIUS_OVERRIDE_MALFORMED,
  BLAST_RADIUS_OVERRIDE_MISMATCH,
  BLAST_RADIUS_UNMEASURED,
  OVERRIDE_ENV_VAR,
  evaluateBlastRadius,
  overrideTokenFor,
  parseBlastRadiusOverride,
} from "./writer-blast-radius-guard.mjs";
import { MAX_DESTRUCTIVE_SHARE } from "./destructive-write-declaration.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// The real P-212 shape: 57,704 of Bastrop's 62,394 prior-active parcel-node rows.
const BASTROP = { affected: 57_704, population: 62_394 };
// A real, legitimate re-run: Kenedy County (48261), one synthetic-key orphan out of 528 prior
// active rows (_inbox/2026-08-08_L2_WAVE3_retirement_dry_full.json).
const KENEDY = { affected: 1, population: 528 };
const WRITER = "parcel-node-county-reconcile";
const MAX_SHARE = MAX_DESTRUCTIVE_SHARE; // P-328: the PROGRAM's one declared number, not a local one

/** Mimics the call order write-parcel-node-county.mjs actually uses: guard, THEN write. */
function simulateGuardedWrite(evalArgs, batch) {
  const writeCalls = [];
  const writeFn = (rows) => writeCalls.push(rows);
  const verdict = evaluateBlastRadius(evalArgs); // throws before writeFn is ever reachable
  writeFn(batch);
  return { verdict, writeCalls };
}

/* ============================================================================================
   THE DECLARED THRESHOLD -- REQUIRED FROM THE CALLER, NEVER A BUILT-IN DEFAULT
   ============================================================================================ */

describe("the threshold is supplied by the caller, never a module default", () => {
  it("refuses to evaluate without a declared 0 < maxShare < 1", () => {
    const base = { writer: WRITER, scopeKey: "48021", affected: 1, population: 1000 };
    expect(() => evaluateBlastRadius({ ...base })).toThrow(/declared 0 < maxShare < 1/);
    expect(() => evaluateBlastRadius({ ...base, maxShare: 0 })).toThrow(/declared 0 < maxShare < 1/);
    expect(() => evaluateBlastRadius({ ...base, maxShare: 1 })).toThrow(/declared 0 < maxShare < 1/);
    expect(() => evaluateBlastRadius({ ...base, maxShare: -0.05 })).toThrow(/declared 0 < maxShare < 1/);
    expect(evaluateBlastRadius({ ...base, maxShare: 0.05 }).ok).toBe(true);
  });

  it("requires a non-empty writer and scopeKey", () => {
    expect(() =>
      evaluateBlastRadius({ scopeKey: "48021", affected: 1, population: 10, maxShare: 0.05 }),
    ).toThrow(/writer and scopeKey/);
    expect(() =>
      evaluateBlastRadius({ writer: WRITER, affected: 1, population: 10, maxShare: 0.05 }),
    ).toThrow(/writer and scopeKey/);
  });
});

/* ============================================================================================
   F1 -- VIOLATION. The real Bastrop shape, at the real declared threshold.
   ============================================================================================ */

describe("F1 (violation): the Bastrop shape refuses and the writer never writes", () => {
  it("57,704 of 62,394 (92.5%) REFUSES against a 5% threshold, and the writer never writes", () => {
    let refused = false;
    let writeCalls;
    try {
      const batch = Array.from({ length: BASTROP.affected }, (_, i) => i);
      const result = simulateGuardedWrite(
        { writer: WRITER, scopeKey: "48021", ...BASTROP, maxShare: MAX_SHARE },
        batch,
      );
      writeCalls = result.writeCalls;
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    // simulateGuardedWrite throws from inside evaluateBlastRadius, before its own writeFn(batch)
    // call is reached, so writeCalls never comes back from the try block at all.
    expect(writeCalls).toBeUndefined();
  });

  it("names the code, the exact share, and says nothing was written", () => {
    try {
      evaluateBlastRadius({ writer: WRITER, scopeKey: "48021", ...BASTROP, maxShare: MAX_SHARE });
      expect.fail("expected a refusal");
    } catch (e) {
      expect(e.code).toBe(BLAST_RADIUS_EXCEEDED);
      expect(e.affected).toBe(57_704);
      expect(e.population).toBe(62_394);
      expect(Math.abs(e.share - 57_704 / 62_394)).toBeLessThan(1e-12);
      expect(e.maxShare).toBe(MAX_SHARE);
      expect(e.message).toMatch(/NOTHING WAS WRITTEN/);
      expect(e.expectedToken).toBe(overrideTokenFor(WRITER, "48021", 57_704, 62_394));
    }
  });

  it("a refusal carries a `record` the call site can write durably, same shape on refuse as on pass", () => {
    try {
      evaluateBlastRadius({ writer: WRITER, scopeKey: "48021", ...BASTROP, maxShare: MAX_SHARE });
      expect.fail("expected a refusal");
    } catch (e) {
      expect(e.record).toMatchObject({
        ok: false,
        refuseCode: BLAST_RADIUS_EXCEEDED,
        writer: WRITER,
        scopeKey: "48021",
        affected: 57_704,
        population: 62_394,
      });
    }
  });
});

/* ============================================================================================
   F2 -- THE NOT-VACUOUS HALF. A legitimate run passes, and the writer DOES write.
   ============================================================================================ */

describe("F2 (pass): a legitimate re-run writes normally", () => {
  it("Kenedy's real shape (1 of 528, 0.19%) passes and the simulated writer IS invoked with the batch", () => {
    const batch = ["48261:_feature-0"];
    const { verdict, writeCalls } = simulateGuardedWrite(
      { writer: WRITER, scopeKey: "48261", ...KENEDY, maxShare: MAX_SHARE },
      batch,
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.basis).toBe("within-threshold");
    expect(writeCalls).toEqual([batch]);
  });

  it("the boundary is the declared number -- exactly the declared share passes, above it refuses", () => {
    const atFloor = evaluateBlastRadius({ writer: WRITER, scopeKey: "48099", affected: 50, population: 100, maxShare: MAX_SHARE });
    expect(atFloor.ok).toBe(true);
    expect(atFloor.share).toBe(MAX_SHARE);
    expect(() =>
      evaluateBlastRadius({ writer: WRITER, scopeKey: "48099", affected: 51, population: 100, maxShare: MAX_SHARE }),
    ).toThrow();
  });
});

/* ============================================================================================
   F3 -- NO-POPULATION, NO-CHANGE AND UNMEASURED ARE DIFFERENT STATES
   ============================================================================================ */

describe("F3: no-population, no-change and unmeasured are three different passing/refusing states", () => {
  it("a county's first-ever load (population 0) is not a collapse and is recorded under its own basis", () => {
    const out = evaluateBlastRadius({ writer: WRITER, scopeKey: "48027", affected: 0, population: 0, maxShare: MAX_SHARE });
    expect(out.ok).toBe(true);
    expect(out.basis).toBe("no-population");
    expect(out.share).toBeNull();
  });

  it("zero affected against a real population is no-change, share exactly 0", () => {
    const out = evaluateBlastRadius({ writer: WRITER, scopeKey: "48021", affected: 0, population: 62_394, maxShare: MAX_SHARE });
    expect(out.ok).toBe(true);
    expect(out.basis).toBe("no-change");
    expect(out.share).toBe(0);
  });

  it("an unmeasured affected count (null/NaN/negative/non-integer) refuses distinctly, never reading as zero", () => {
    for (const bad of [null, undefined, "", NaN, -1, 1.5]) {
      try {
        evaluateBlastRadius({ writer: WRITER, scopeKey: "48021", affected: bad, population: 100, maxShare: MAX_SHARE });
        expect.fail(`expected unmeasured refusal for affected=${bad}`);
      } catch (e) {
        expect(e.code).toBe(BLAST_RADIUS_UNMEASURED);
      }
    }
  });

  it("an unmeasured population is likewise refused distinctly, never read as a collapse or as safe", () => {
    for (const bad of [null, undefined, "", NaN, -1]) {
      try {
        evaluateBlastRadius({ writer: WRITER, scopeKey: "48021", affected: 5, population: bad, maxShare: MAX_SHARE });
        expect.fail(`expected unmeasured refusal for population=${bad}`);
      } catch (e) {
        expect(e.code).toBe(BLAST_RADIUS_UNMEASURED);
      }
    }
  });

  it("a growing population (more ids than before) is not a collapse", () => {
    const out = evaluateBlastRadius({ writer: WRITER, scopeKey: "48021", affected: 0, population: 70_000, maxShare: MAX_SHARE });
    expect(out.ok).toBe(true);
  });
});

/* ============================================================================================
   F4 -- THE OVERRIDE IS NOT A HABIT-FLAG
   ============================================================================================ */

describe("F4: the override authorizes exactly one measured run, never a template", () => {
  it("round-trips: overrideTokenFor produces a string parseBlastRadiusOverride reads back identically", () => {
    const token = overrideTokenFor(WRITER, "48021", 57_704, 62_394);
    expect(token).toBe(`${OVERRIDE_ENV_VAR}=parcel-node-county-reconcile:48021:57704/62394`);
    const parsed = parseBlastRadiusOverride(token.slice(`${OVERRIDE_ENV_VAR}=`.length));
    expect(parsed).toEqual({ writer: WRITER, scopeKey: "48021", affected: 57_704, population: 62_394, raw: "parcel-node-county-reconcile:48021:57704/62394" });
  });

  it("an absent override is null, never a default authorization", () => {
    expect(parseBlastRadiusOverride(null)).toBeNull();
    expect(parseBlastRadiusOverride(undefined)).toBeNull();
    expect(parseBlastRadiusOverride("")).toBeNull();
    expect(parseBlastRadiusOverride("   ")).toBeNull();
  });

  it("a malformed override refuses distinctly rather than reading as absent", () => {
    expect(() => parseBlastRadiusOverride("garbage")).toThrow();
    try {
      parseBlastRadiusOverride("48021:57704/62394"); // missing the writer segment
      expect.fail("expected a malformed refusal");
    } catch (e) {
      expect(e.code).toBe(BLAST_RADIUS_OVERRIDE_MALFORMED);
    }
  });

  it("an override for a DIFFERENT writer or county refuses, even with the same counts", () => {
    const wrongWriter = "48021:57704/62394"; // valid shape, but for road-node-county-reconcile
    try {
      evaluateBlastRadius({
        writer: WRITER,
        scopeKey: "48021",
        ...BASTROP,
        maxShare: MAX_SHARE,
        override: `road-node-county-reconcile:${wrongWriter}`,
      });
      expect.fail("expected an override mismatch");
    } catch (e) {
      expect(e.code).toBe(BLAST_RADIUS_OVERRIDE_MISMATCH);
    }

    try {
      evaluateBlastRadius({
        writer: WRITER,
        scopeKey: "48099",
        ...BASTROP,
        maxShare: MAX_SHARE,
        override: `${WRITER}:48021:57704/62394`, // right writer, wrong county
      });
      expect.fail("expected an override mismatch");
    } catch (e) {
      expect(e.code).toBe(BLAST_RADIUS_OVERRIDE_MISMATCH);
    }
  });

  it("a STALE override (counts moved since it was issued) refuses -- it cannot be pasted from a prior run", () => {
    try {
      evaluateBlastRadius({
        writer: WRITER,
        scopeKey: "48021",
        affected: 57_705, // one more than the token authorizes
        population: 62_394,
        maxShare: MAX_SHARE,
        override: `${WRITER}:48021:57704/62394`,
      });
      expect.fail("expected a stale-override mismatch");
    } catch (e) {
      expect(e.code).toBe(BLAST_RADIUS_OVERRIDE_MISMATCH);
    }
  });

  it("an EXACT match authorizes this measured run and no other, and the write proceeds", () => {
    const batch = ["48021:12345"];
    const { verdict, writeCalls } = simulateGuardedWrite(
      {
        writer: WRITER,
        scopeKey: "48021",
        ...BASTROP,
        maxShare: MAX_SHARE,
        override: `${WRITER}:48021:57704/62394`,
      },
      batch,
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.basis).toBe("override-authorised");
    expect(verdict.override).toMatchObject({ authorised: true, affected: 57_704, population: 62_394 });
    expect(writeCalls).toEqual([batch]);
  });

  it("an override present but not needed (share within threshold) is recorded as unused, not silently dropped", () => {
    const out = evaluateBlastRadius({
      writer: WRITER,
      scopeKey: "48261",
      ...KENEDY,
      maxShare: MAX_SHARE,
      override: `${WRITER}:48261:1/528`,
    });
    expect(out.ok).toBe(true);
    expect(out.overridePresentUnused).toBe(true);
    expect(out.override).toBeNull();
  });
});

/* ============================================================================================
   WIRING -- the guard actually sits in write-parcel-node-county.mjs BEFORE every write call.
   ============================================================================================ */

describe("wiring: write-parcel-node-county.mjs calls the guard before it takes a lease or writes", () => {
  const writerSrc = readFileSync(path.join(here, "write-parcel-node-county.mjs"), "utf8");

  it("reads the program's ONE declared number from the declaration module (P-328) -- it no longer declares its own", () => {
    // P-328 replaced a local `MAX_ORPHAN_SHARE = 0.05` with the program's number. A local share
    // LITERAL here is now the defect, so this asserts its ABSENCE rather than its value.
    expect(writerSrc).toContain("MAX_DESTRUCTIVE_SHARE");
    expect(writerSrc).toContain('from "./destructive-write-declaration.mjs"');
    expect(writerSrc).toContain('from "./writer-blast-radius-guard.mjs"');
    expect(
      /MAX_[A-Z0-9_]*SHARE\s*=\s*0\./.test(writerSrc),
      "write-parcel-node-county.mjs must not declare its own share literal",
    ).toBe(false);
  });

  it("evaluateBlastRadius( precedes takeScopedLease( and every writePropertyAtomsBatch( call site in source order", () => {
    const guardAt = writerSrc.indexOf("evaluateBlastRadius(");
    const leaseAt = writerSrc.indexOf("takeScopedLease(");
    const firstWriteAt = writerSrc.indexOf("handle.storage.writePropertyAtomsBatch(");
    const lastWriteAt = writerSrc.lastIndexOf("handle.storage.writePropertyAtomsBatch(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(leaseAt).toBeGreaterThan(-1);
    expect(firstWriteAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(leaseAt);
    expect(guardAt).toBeLessThan(firstWriteAt);
    expect(guardAt).toBeLessThan(lastWriteAt);
  });

  it("the guard call is NOT gated behind --apply in source -- it runs in dry-run too (predicts the refusal, not only the write count)", () => {
    const guardAt = writerSrc.indexOf("evaluateBlastRadius(");
    const applyBranchAt = writerSrc.indexOf("if (!args.apply) {");
    expect(guardAt).toBeGreaterThan(-1);
    expect(applyBranchAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(applyBranchAt);
  });
});
