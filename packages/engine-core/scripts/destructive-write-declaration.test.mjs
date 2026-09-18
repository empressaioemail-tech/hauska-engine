/**
 * P-328: the program's destructive-write declaration in hauska-engine -- its number, its register,
 * and the drift check that keeps its single number single.
 *
 * PRE-REGISTERED FALSIFIERS (written in CP1 before any of this was run; see
 * _inbox/2026-09-18_p328-engine-reconcile-blast-radius_cp1.json):
 *
 *   F1 The Bastrop shape REFUSES and nothing is written: 57,704 of 62,394 active parcel-node rows
 *      (the real P-212 numbers) must throw before the simulated writer's write function is reached.
 *   F2 The authorised path still runs, and ONLY for the measured run: the exact token passes, a
 *      token with either count moved refuses, a token for another writer or county refuses.
 *   F3 A normal reconcile passes: Kenedy 48261, 1 of 528 prior active rows (0.19 percent).
 *   F4 Unmeasured is not zero: a missing count refuses rather than reading as "nothing to retire".
 *   F5 The drift check FIRES when the engine's constant is edited alone.
 *   F6 The enumeration is ENFORCED: a destructive statement in an unregistered engine module fails.
 *   F7 Every `wired: true` claim is backed by a real call site, not a comment.
 *
 * Every refusal is proven by VIOLATION. A check observed only passing has not been observed
 * working, which is the whole reason this row exists.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  AUTHORISATION_ENV_VAR,
  DESTRUCTIVE_WRITERS,
  MAX_DESTRUCTIVE_SHARE,
  PROGRAM_DECLARATION_PIN,
  REFUSAL_CODES,
  authorisationTokenFor,
  destructiveWriterById,
} from "./destructive-write-declaration.mjs";
import {
  BLAST_RADIUS_EXCEEDED,
  BLAST_RADIUS_OVERRIDE_MISMATCH,
  BLAST_RADIUS_UNMEASURED,
  evaluateBlastRadius,
} from "./writer-blast-radius-guard.mjs";
import {
  evaluateDeclarationAgainstPin,
  evaluateDivergence,
  evaluatePinHashes,
  normalisedSha256,
  scanForRefusalCodeDrift,
  scanForSecondThresholds,
  stripComments,
} from "./check-destructive-write-share-divergence.mjs";
import { reconcileCountyParcelNodes } from "../src/parcel-node/reconcile-county-parcel-nodes.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(HERE, "../../..");

// The real P-212 incident shape: 57,704 of Bastrop's 62,394 prior-active parcel-node rows.
const BASTROP = { affected: 57_704, population: 62_394 };
// The measured legitimate case: Kenedy County 48261, one synthetic-key orphan of 528 prior active.
const KENEDY = { affected: 1, population: 528 };
const PARCEL_WRITER = "parcel-node-county-reconcile";

/** Mimics the writers' real call order: guard FIRST, then (and only then) the write. */
function simulateGuardedWrite(evalArgs, batch) {
  const writeCalls = [];
  const writeFn = (rows) => writeCalls.push(rows);
  const verdict = evaluateBlastRadius(evalArgs); // throws before writeFn is reachable
  writeFn(batch);
  return { verdict, writeCalls };
}

/* ==========================================================================================
   F1 -- THE BASTROP SHAPE REFUSES AND NOTHING IS WRITTEN
   ========================================================================================== */

describe("P-328 F1: the shape that emptied Bastrop refuses against the program's number", () => {
  it("refuses, names the counts and the token, and never reaches the write", () => {
    let err;
    try {
      simulateGuardedWrite(
        {
          writer: PARCEL_WRITER,
          scopeKey: "48021",
          ...BASTROP,
          maxShare: MAX_DESTRUCTIVE_SHARE,
          override: null,
        },
        ["would-be-retire-body"],
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe(BLAST_RADIUS_EXCEEDED);
    // The refusal carries what it would have done, so it does not depend on knowing WHY.
    expect(err.affected).toBe(57_704);
    expect(err.population).toBe(62_394);
    expect(err.share).toBeCloseTo(0.9248, 4);
    expect(err.expectedToken).toBe(`${AUTHORISATION_ENV_VAR}=parcel-node-county-reconcile:48021:57704/62394`);
    expect(err.message).toContain("NOTHING WAS WRITTEN");
  });

  it("fires against the PROGRAM's number, which A-220 moved to the engine's own 0.05 -- 92.5% is above both", () => {
    // P-328's version of this test distinguished the program's 0.5 from the engine's old 0.05. After
    // A-220 (P-361) the program's number IS 0.05, so the row's completion predicate is the same
    // predicate and the share is above it under either reading of history.
    expect(MAX_DESTRUCTIVE_SHARE).toBe(0.05);
    expect(BASTROP.affected / BASTROP.population).toBeGreaterThan(MAX_DESTRUCTIVE_SHARE);
  });

  it("the fixture is REAL: the producer measures the same 57,704 of 62,394 the guard refuses", () => {
    // The two tests above hand the guard the incident's numbers. That proves the guard, and it
    // does NOT prove the numbers are what this producer measures on a Bastrop-shaped plan -- a
    // fixture that quietly yielded 0 orphans would refuse for the wrong reason and look identical.
    // This runs the ACTUAL producer over the incident's shape, then feeds its own measurement to
    // the guard. It is also the revert-and-run's first half: the pre-change writer retired exactly
    // `plan.orphans` with no guard between :439 and the write, so this is the set it wrote.
    const PRIOR_ACTIVE = 62_394;
    const PLANNED = 4_690; // 62,394 - 57,704
    const priorRows = Array.from({ length: PRIOR_ACTIVE }, (_, i) => ({
      parcelNodeId: `48021:${100_000 + i}`,
      status: "active",
      sourceVintage: "2026-08-txgio-stratmap",
    }));
    const plan = {
      countyFips: "48021",
      planned: priorRows.slice(0, PLANNED).map((r) => ({ parcelKey: r.parcelNodeId.split(":")[1] })),
      counts: {},
    };

    const measured = reconcileCountyParcelNodes(priorRows, plan, "2026-09-txgio-stratmap");

    expect(measured.priorActive).toBe(PRIOR_ACTIVE);
    expect(measured.orphans.length).toBe(57_704);

    let err;
    try {
      simulateGuardedWrite(
        {
          writer: PARCEL_WRITER,
          scopeKey: "48021",
          affected: measured.orphans.length,
          population: measured.priorActive,
          maxShare: MAX_DESTRUCTIVE_SHARE,
          override: null,
        },
        measured.orphans.map((o) => o.parcelNodeId),
      );
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(BLAST_RADIUS_EXCEEDED);
    expect(err.affected).toBe(measured.orphans.length);
    expect(err.population).toBe(measured.priorActive);
    // The sample the refusal carries is real ids from the set it would have retired.
    expect(measured.orphans.slice(0, 3).map((o) => o.parcelNodeId)).toEqual([
      "48021:104690",
      "48021:104691",
      "48021:104692",
    ]);
  });
});

/* ==========================================================================================
   F2 -- THE AUTHORISED PATH STILL RUNS, AND ONLY FOR THE MEASURED RUN
   ========================================================================================== */

describe("P-328 F2: the authorisation binds to the measured run", () => {
  const base = {
    writer: PARCEL_WRITER,
    scopeKey: "48021",
    ...BASTROP,
    maxShare: MAX_DESTRUCTIVE_SHARE,
  };

  it("the exact token lets the same run through", () => {
    const { verdict, writeCalls } = simulateGuardedWrite(
      { ...base, override: authorisationTokenFor(PARCEL_WRITER, "48021", 57_704, 62_394) },
      ["retire-batch"],
    );
    expect(verdict.basis).toBe("override-authorised");
    expect(verdict.overridePresentUnused).toBe(false);
    expect(writeCalls).toEqual([["retire-batch"]]);
  });

  it("a token whose counts moved does not carry", () => {
    let err;
    try {
      simulateGuardedWrite(
        { ...base, override: authorisationTokenFor(PARCEL_WRITER, "48021", 57_704, 62_395) },
        ["retire-batch"],
      );
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(BLAST_RADIUS_OVERRIDE_MISMATCH);
    expect(err.detail ?? err.expectedToken).toBeDefined();
  });

  it("a token for another writer or county does not carry", () => {
    for (const override of [
      authorisationTokenFor("road-node-county-reconcile", "48021", 57_704, 62_394),
      authorisationTokenFor(PARCEL_WRITER, "48491", 57_704, 62_394),
    ]) {
      let err;
      try {
        simulateGuardedWrite({ ...base, override }, ["retire-batch"]);
      } catch (e) {
        err = e;
      }
      expect(err.code).toBe(BLAST_RADIUS_OVERRIDE_MISMATCH);
    }
  });
});

/* ==========================================================================================
   F3 -- A NORMAL RECONCILE STILL PASSES (the control is not disabled by the first healthy run)
   ========================================================================================== */

describe("P-328 F3: a healthy reconcile passes", () => {
  it("Kenedy's 1 of 528 retires as before", () => {
    const { verdict, writeCalls } = simulateGuardedWrite(
      { writer: PARCEL_WRITER, scopeKey: "48261", ...KENEDY, maxShare: MAX_DESTRUCTIVE_SHARE },
      ["kenedy-orphan"],
    );
    expect(verdict.basis).toBe("within-threshold");
    expect(verdict.share).toBeCloseTo(0.0019, 4);
    expect(writeCalls.length).toBe(1);
  });

  it("a no-op and a first-ever run are their own bases, never refusals", () => {
    const noop = evaluateBlastRadius({
      writer: PARCEL_WRITER,
      scopeKey: "48021",
      affected: 0,
      population: 62_394,
      maxShare: MAX_DESTRUCTIVE_SHARE,
    });
    const first = evaluateBlastRadius({
      writer: PARCEL_WRITER,
      scopeKey: "48027",
      affected: 0,
      population: 0,
      maxShare: MAX_DESTRUCTIVE_SHARE,
    });
    expect(noop.basis).toBe("no-change");
    expect(first.basis).toBe("no-population");
  });
});

/* ==========================================================================================
   F4 -- UNMEASURED IS NOT ZERO
   ========================================================================================== */

describe("P-328 F4: an unmeasured count refuses", () => {
  it("refuses rather than reading a missing count as a county with nothing to retire", () => {
    for (const bad of [
      { affected: undefined, population: 100 },
      { affected: null, population: 100 },
      { affected: 5, population: undefined },
      { affected: 5, population: null },
      { affected: -1, population: 100 },
      { affected: 5, population: "not-a-count" },
    ]) {
      let err;
      try {
        evaluateBlastRadius({ writer: PARCEL_WRITER, scopeKey: "48021", ...bad, maxShare: MAX_DESTRUCTIVE_SHARE });
      } catch (e) {
        err = e;
      }
      expect(err, JSON.stringify(bad)).toBeDefined();
      expect(err.code, JSON.stringify(bad)).toBe(BLAST_RADIUS_UNMEASURED);
    }
  });
});

/* ==========================================================================================
   F5 -- THE DRIFT CHECK FIRES WHEN THE ENGINE'S CONSTANT IS EDITED ALONE
   ========================================================================================== */

describe("P-328 F5: the drift check can fire", () => {
  const realDeclaration = {
    MAX_DESTRUCTIVE_SHARE,
    AUTHORISATION_ENV_VAR,
    authorisationTokenFor,
  };

  it("passes on the tree as committed", () => {
    const out = evaluateDeclarationAgainstPin({ declaration: realDeclaration });
    expect(out.verdict).toBe("PASS");
    expect(out.pinnedConstant).toBe(MAX_DESTRUCTIVE_SHARE);
  });

  it("REFUSES when the constant is edited alone (the dispatch's fourth falsifier)", () => {
    const out = evaluateDeclarationAgainstPin({
      declaration: { ...realDeclaration, MAX_DESTRUCTIVE_SHARE: 0.1 },
    });
    expect(out.verdict).toBe("REFUSE");
    expect(out.reason).toBe("ENGINE_CONSTANT_DIVERGED");
    // A single-number edit is refused NAMING the pinned value it should have matched: the pinned
    // number is 0.05 (A-220 / P-361), so an engine that drifts to 0.1 is caught, and so is one that
    // reverts to the old 0.5.
    expect(out.detail).toContain("0.05");
    const reverted = evaluateDeclarationAgainstPin({
      declaration: { ...realDeclaration, MAX_DESTRUCTIVE_SHARE: 0.5 },
    });
    expect(reverted.verdict).toBe("REFUSE");
    expect(reverted.reason).toBe("ENGINE_CONSTANT_DIVERGED");
    expect(reverted.detail).toContain("0.05");
  });

  it("REFUSES when the authorisation variable is edited alone", () => {
    const out = evaluateDeclarationAgainstPin({
      declaration: { ...realDeclaration, AUTHORISATION_ENV_VAR: "BLAST_RADIUS_OVERRIDE" },
    });
    expect(out.verdict).toBe("REFUSE");
    expect(out.reason).toBe("ENGINE_ENV_VAR_DIVERGED");
  });

  it("REFUSES when a token grammar drifts", () => {
    const out = evaluateDeclarationAgainstPin({
      declaration: { ...realDeclaration, authorisationTokenFor: () => "wrong" },
    });
    expect(out.verdict).toBe("REFUSE");
    expect(out.reason).toBe("ENGINE_TOKEN_DIVERGED");
  });

  it("the whole check passes on the committed tree, and its pin is a real factory file", () => {
    const out = evaluateDivergence({});
    expect(out.verdict).toBe("PASS");
    expect(PROGRAM_DECLARATION_PIN.repo).toBe("empressaioemail-tech/hauska-factory");
    expect(PROGRAM_DECLARATION_PIN.ref).toMatch(/^[0-9a-f]{40}$/);
    expect(PROGRAM_DECLARATION_PIN.gitBlobSha).toMatch(/^[0-9a-f]{40}$/);
    expect(PROGRAM_DECLARATION_PIN.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.refusalCodes.verdict).toBe("PASS");
  });

  it("REFUSES when the guard throws a refusal code the declaration does not name", () => {
    const out = scanForRefusalCodeDrift({
      guardSource: `function x() { refuse(BLAST_RADIUS_EXCEEDED, "a"); refuse("A_HAND_SPELLED_CODE", "b"); }`,
    });
    expect(out.verdict).toBe("REFUSE");
    expect(out.reason).toBe("REFUSAL_CODE_DRIFT");
    expect(out.detail).toContain("A_HAND_SPELLED_CODE");
  });

  it("REFUSES when a declared refusal code is thrown nowhere", () => {
    const out = scanForRefusalCodeDrift({
      guardSource: `function x() { refuse(BLAST_RADIUS_EXCEEDED, "a"); }`,
    });
    expect(out.verdict).toBe("REFUSE");
    expect(out.reason).toBe("REFUSAL_CODE_DRIFT");
    expect(out.detail).toContain("BLAST_RADIUS_UNMEASURED");
  });

  it("the guard really does throw all four declared codes (the pass above is not vacuous)", () => {
    const out = scanForRefusalCodeDrift({});
    expect(out.verdict).toBe("PASS");
    expect(out.thrown).toEqual(
      [...Object.values(REFUSAL_CODES.engine)].sort(),
    );
    expect(out.thrown.length).toBe(4);
  });

  it("REFUSES when the factory bytes differ but the normalized digest does not", () => {
    // The case a sha256-only pin cannot see: one extra byte changes the byte count and git's own
    // blob identity while leaving a normalized digest of any OTHER pair of files untouched. This
    // leg exists because the pin RECORDS bytes and a blob sha, and a recorded field nothing reads
    // is a pin that looks stronger than it is.
    const pinnedText = "export const MAX_DESTRUCTIVE_SHARE = 0.5;\n";
    const out = evaluatePinHashes({
      text: pinnedText,
      blobSha: "0000000000000000000000000000000000000000",
      pin: {
        ...PROGRAM_DECLARATION_PIN,
        bytes: PROGRAM_DECLARATION_PIN.bytes + 1,
        sha256: normalisedSha256(Buffer.from(pinnedText, "utf8")),
      },
    });
    expect(out.verdict).toBe("REFUSE");
    expect(out.reason).toBe("PIN_HASH_MISMATCH");
    expect(out.detail).toContain("byte length");
    expect(out.detail).toContain("git blob sha");
  });

  it("PASSES on text that genuinely matches all three recorded fields", () => {
    const text = "abc";
    const out = evaluatePinHashes({
      text,
      blobSha: "b",
      pin: {
        ...PROGRAM_DECLARATION_PIN,
        bytes: 3,
        gitBlobSha: "b",
        sha256: normalisedSha256(Buffer.from(text, "utf8")),
      },
    });
    expect(out.verdict).toBe("PASS");
    expect(out.bytes).toBe(3);
  });

  it("hashes bytes the same way the re-derivation leg does", () => {
    // A CRLF/BOM variant of the same text must normalise to one hash, or a Windows clone would be
    // reported as a divergence and the check would be "fixed" by weakening it.
    const lf = normalisedSha256(Buffer.from("a\nb\n", "utf8"));
    const crlf = normalisedSha256(Buffer.from("\uFEFFa\r\nb\r\n", "utf8"));
    expect(crlf).toBe(lf);
  });
});

/* ==========================================================================================
   F6 -- THE ENUMERATION IS ENFORCED, NOT REMEMBERED
   ========================================================================================== */

/**
 * What counts as a destructive statement: a record leaving service, by status or by removal.
 *
 * `UPDATE atoms` alone is NOT here. It matched five in-place field rewrites (`SET body = ...`) on
 * rows that stay served -- see the exclusion note in `destructive-write-declaration.mjs`. Flagging
 * those would make the register a list of every writer that touches an atom body, and the register
 * would then be satisfied by adding five entries that all say "not a status transition", which is
 * how a control turns into paperwork. The families kept are the two that actually take a record out
 * of service:
 *
 *   1. a destructive STATUS literal (`status: "retired" | "superseded"`), and
 *   2. a SQL statement that removes rows (`DELETE FROM atoms`) or sets a destructive status.
 *
 * If a writer moves a record out of service in a shape neither pattern sees, the patterns are the
 * thing to widen -- not the register.
 */
const DESTRUCTIVE_STATEMENTS = [
  /status\s*:\s*["'](?:retired|superseded)["']/,
  /\bDELETE\s+FROM\s+atoms\b/i,
  /\bUPDATE\s+atoms\b[\s\S]{0,400}?status\s*=\s*["'](?:retired|superseded)["']/i,
];

/**
 * Register entries are engine-core-relative (`scripts/...`, `src/...`) unless they name another
 * package explicitly (`packages/storage/...`). The scan works in repo-root-relative paths, so the
 * two are normalised here rather than by rewriting the register into one long prefix.
 */
function registeredModulePaths() {
  const paths = new Set();
  for (const w of DESTRUCTIVE_WRITERS) {
    for (const part of String(w.module).split(",")) {
      const p = part.trim();
      if (!p) continue;
      paths.add(p.startsWith("packages/") ? p : `packages/engine-core/${p}`);
    }
  }
  return paths;
}

/** Every engine module carrying a destructive statement, excluding tests and the guard machinery. */
function scanDestructiveModules() {
  const found = [];
  const skipDirs = new Set(["node_modules", "dist", "__tests__", ".git", "fixtures", "docs"]);
  const exempt = new Set([
    "packages/engine-core/scripts/destructive-write-declaration.mjs",
    "packages/engine-core/scripts/check-destructive-write-share-divergence.mjs",
  ]);
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (skipDirs.has(entry)) continue;
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (/\.(mjs|ts)$/.test(entry) && !/\.test\.(mjs|ts)$/.test(entry)) {
        const rel = path.relative(REPO_ROOT, full).split(path.sep).join("/");
        if (exempt.has(rel)) continue;
        const src = stripComments(readFileSync(full, "utf8"));
        if (DESTRUCTIVE_STATEMENTS.some((re) => re.test(src))) found.push(rel);
      }
    }
  };
  walk(path.join(REPO_ROOT, "packages"));
  return found.sort();
}

describe("P-328 F6: every engine module that can set a destructive status is registered", () => {
  it("names them all -- a new unregistered destructive statement fails this test", () => {
    const registered = registeredModulePaths();
    const unregistered = scanDestructiveModules().filter((m) => !registered.has(m));
    expect(unregistered, `unregistered destructive modules: ${unregistered.join(", ")}`).toEqual([]);
  });

  it("the scan finds a known destructive module, so a green result is not an empty scan", () => {
    const found = scanDestructiveModules();
    // The module that BUILDS the retire body is the one carrying the statement. The producer
    // (`src/parcel-node/reconcile-county-parcel-nodes.ts`) computes the orphan SET and carries no
    // status literal at all -- naming it here was the assertion this test started with, and it
    // was wrong: a scan that "found" a module with no destructive statement in it would have been
    // green for the wrong reason.
    expect(found).toContain("packages/engine-core/scripts/write-parcel-node-county.mjs");
    expect(found).toContain("packages/engine-core/scripts/write-building-footprint-county.mjs");
  });
});

/* ==========================================================================================
   F7 -- EVERY `wired: true` CLAIM IS BACKED BY A CALL SITE
   ========================================================================================== */

describe("P-328 F7: a wired claim is a call site, not a comment", () => {
  it("each wired writer's module actually calls the guard", () => {
    const wired = DESTRUCTIVE_WRITERS.filter((w) => w.wired === true);
    expect(wired.length).toBeGreaterThanOrEqual(3);
    for (const w of wired) {
      const first = String(w.module).split(",")[0].trim();
      const rel = first.startsWith("packages/") ? first : `packages/engine-core/${first}`;
      const src = readFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect(
        /evaluateBlastRadius\s*\(/.test(src),
        `${w.id} claims wired:true but ${first} does not call evaluateBlastRadius`,
      ).toBe(true);
    }
  });

  it("the newly wired road writer reads the program's number, not one of its own", () => {
    const src = readFileSync(path.join(PACKAGE_ROOT, "scripts/write-road-node-county.mjs"), "utf8");
    expect(src).toContain("evaluateBlastRadius(");
    expect(src).toContain("MAX_DESTRUCTIVE_SHARE");
    expect(src).not.toMatch(/MAX_[A-Z0-9_]*SHARE\s*=\s*0\./);
  });

  it("the parcel-node writer no longer declares its own number", () => {
    const src = readFileSync(path.join(PACKAGE_ROOT, "scripts/write-parcel-node-county.mjs"), "utf8");
    expect(src).toContain("MAX_DESTRUCTIVE_SHARE");
    expect(src).not.toMatch(/MAX_[A-Z0-9_]*SHARE\s*=\s*0\./);
  });

  it("the reactivation guard re-exports the one number rather than a literal", () => {
    const src = readFileSync(path.join(PACKAGE_ROOT, "scripts/retired-reactivation-guard.mjs"), "utf8");
    expect(src).toMatch(/MAX_REACTIVATION_SHARE\s*=\s*MAX_DESTRUCTIVE_SHARE/);
  });

  it("the Bastrop share refuses under EACH wired writer's id, not just the parcel-node one", () => {
    // A call site (above) plus a refusal that only fires for one writer id would together look
    // like two writers are guarded while one of them authorises against the other's token. The
    // token is bound to the writer id, so this asserts the refusal is reachable and
    // authorisation-required per id -- and that an authorisation minted for the parcel writer
    // does NOT carry into the road writer.
    const ids = DESTRUCTIVE_WRITERS.filter((w) => w.wired === true)
      .map((w) => w.id)
      .filter((id) => id !== "parcel-node-retired-review-reactivation"); // opposite direction, its own token
    expect(ids.length).toBeGreaterThanOrEqual(2);
    for (const id of ids) {
      let err;
      try {
        evaluateBlastRadius({
          writer: id,
          scopeKey: "48021",
          ...BASTROP,
          maxShare: MAX_DESTRUCTIVE_SHARE,
          override: null,
        });
      } catch (e) {
        err = e;
      }
      expect(err, id).toBeDefined();
      expect(err.code, id).toBe(BLAST_RADIUS_EXCEEDED);
      expect(err.expectedToken).toContain(`${id}:48021:57704/62394`);
    }
  });
});

/* ==========================================================================================
   ONE NUMBER -- no second share literal anywhere in the engine package
   ========================================================================================== */

describe("P-328: the engine declares exactly one share number", () => {
  it("no module declares a share literal beside the declaration", () => {
    const out = scanForSecondThresholds({ root: PACKAGE_ROOT });
    expect(out.verdict, out.detail).toBe("PASS");
  });

  it("the register's ids are unique and resolvable", () => {
    const ids = DESTRUCTIVE_WRITERS.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(destructiveWriterById(id)?.id).toBe(id);
  });
});
