/**
 * P-328: THE DRIFT CHECK. The engine's declaration of the program's destructive-write number must
 * not diverge from the factory's, and the engine must not declare a SECOND number beside it.
 *
 * (No shebang: this module is IMPORTED by destructive-write-declaration.test.mjs, and vite's
 * transform rejects a `#!` line in a module it has to parse rather than execute directly. It is
 * still runnable as `node scripts/check-destructive-write-share-divergence.mjs`.)
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS CATCHES, AND WHY IT IS A CHECK RATHER THAN A COMMENT
 * ---------------------------------------------------------------------------------------------
 *
 * P-320's own words: "a second copy of 0.5 in another file is a number that can drift, and a
 * drifted copy is invisible until the day it is the only one that matters." The engine cannot
 * import the factory (different repo, private, unpublished), so the engine carries a COPY --
 * and a copy without a check is exactly the arrangement P-320 warned about. This is the check.
 *
 * It has four halves and they fail for different reasons:
 *
 *   OFFLINE (always runs, no repo needed)
 *     1. The declaration's constant, env var name, token grammar and refusal code must equal the
 *        literals recorded in `PROGRAM_DECLARATION_PIN.facts`. This is the half that FIRES WHEN THE
 *        ENGINE'S CONSTANT IS EDITED ALONE (the dispatch's fourth falsifier): edit
 *        `MAX_DESTRUCTIVE_SHARE` and this refuses, naming the pinned factory value it should have
 *        matched.
 *     2. No other module in `src/` or `scripts/` may declare its own share LITERAL. A second
 *        number is the defect the row exists to prevent, so it is refused as a second number
 *        rather than tolerated as a local constant.
 *     3. The guard's refusal codes must be the declared ones in both directions (every thrown code
 *        declared, every declared code thrown) -- so a code cannot be a literal spelled by hand at
 *        a throw site.
 *
 *   RE-DERIVED (`--factory <path-to-hauska-factory>`, needs a local clone)
 *     4. `git show <ref>:<path>` reads the factory's declaration at the pinned SHA, hashes it and
 *        parses its literals, and refuses on any disagreement -- so the pin is RE-DERIVABLE rather
 *        than asserted. This is the leg that catches a factory change.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY NOT A NETWORK FETCH, STATED WHERE A READER WILL LOOK FOR IT
 * ---------------------------------------------------------------------------------------------
 *
 * The dispatch offers "a pinned SHA or its published file". Neither is reachable from engine CI:
 * hauska-factory is PRIVATE and unpublished (measured 2026-09-18 -- the GitHub API and
 * raw.githubusercontent.com answer 404 for it while a credentialed `git fetch` succeeds, and
 * `npm view hauska-factory` is E404 because its package is `"private": true`). hauska-engine is
 * public, so the ENFORCEABLE cross-repo direction is the factory-side one -- the factory's CI can
 * read this public repo and fail on disagreement, which is the pattern P-331 established. That row
 * is handed back in the close's leave_behind; this script's offline half is what the engine's own
 * CI can run, and `--factory` is what a lane or the integration seat runs with a clone in hand.
 *
 * ---------------------------------------------------------------------------------------------
 * THE THREE-QUESTION GATE
 * ---------------------------------------------------------------------------------------------
 *
 *   Executes: `main()` in engine CI / by hand, and `evaluateDivergence` in the test suite.
 *   Triggers: every run -- there is no flag that makes a pass cheap and a check optional.
 *   Fails:    ENGINE_CONSTANT_DIVERGED | ENGINE_ENV_VAR_DIVERGED | ENGINE_TOKEN_DIVERGED |
 *             SECOND_THRESHOLD_DECLARED | REFUSAL_CODE_DRIFT | GUARD_UNREADABLE | PIN_HASH_MISMATCH |
 *             FACTORY_FACTS_DIVERGED | FACTORY_UNREADABLE | DECLARATION_UNREADABLE.
 *   Bypasses: deleting this script, or editing BOTH the declaration and the pin's recorded facts
 *             in one commit -- which is a deliberate act that review can see, and is why the pin
 *             records the factory's SHA and blob hash rather than only the number.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTHORISATION_ENV_VAR,
  MAX_DESTRUCTIVE_SHARE,
  PROGRAM_DECLARATION_PIN,
  REFUSAL_CODES,
  authorisationTokenFor,
} from "./destructive-write-declaration.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..");
const DECLARATION_FILE = "destructive-write-declaration.mjs";
const SELF_FILE = "check-destructive-write-share-divergence.mjs";

/** A file that carries no behaviour of its own to declare a number for. */
const SCAN_SKIP_DIRS = new Set(["node_modules", "dist", "__tests__", ".git"]);

function refuse(reason, detail) {
  return { verdict: "REFUSE", reason, detail };
}

export function normalisedSha256(buf) {
  const normalised = Buffer.from(buf.toString("utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"), "utf8");
  return createHash("sha256").update(normalised).digest("hex");
}

/**
 * Half 1: the declaration against the pin's recorded facts. Pure and injectable, so the test proves
 * it FIRES by handing it a mutated declaration (falsifier F5) rather than by reading the source.
 */
export function evaluateDeclarationAgainstPin({
  declaration,
  pin = PROGRAM_DECLARATION_PIN,
} = {}) {
  if (!declaration || !pin) {
    return refuse("DECLARATION_UNREADABLE", "declaration or pin was not supplied");
  }
  const facts = pin.facts;
  const out = {
    declarationConstant: declaration.MAX_DESTRUCTIVE_SHARE,
    declarationEnvVar: declaration.AUTHORISATION_ENV_VAR,
    pinnedConstant: facts.constantValue,
    pinnedEnvVar: facts.envVarValue,
    pin: { repo: pin.repo, path: pin.path, ref: pin.ref, sha256: pin.sha256 },
  };
  if (declaration.MAX_DESTRUCTIVE_SHARE !== facts.constantValue) {
    return refuse(
      "ENGINE_CONSTANT_DIVERGED",
      `engine MAX_DESTRUCTIVE_SHARE is ${declaration.MAX_DESTRUCTIVE_SHARE}; the pinned factory ` +
        `value at ${pin.ref} (${pin.path}) is ${facts.constantValue}. One number, one place: change ` +
        `the factory's declaration and re-pin, or revert this edit -- do not hold a second number.`,
    );
  }
  if (declaration.AUTHORISATION_ENV_VAR !== facts.envVarValue) {
    return refuse(
      "ENGINE_ENV_VAR_DIVERGED",
      `engine authorisation env var is ${JSON.stringify(declaration.AUTHORISATION_ENV_VAR)}; the ` +
        `pinned factory variable is ${JSON.stringify(facts.envVarValue)}.`,
    );
  }
  const token = declaration.authorisationTokenFor("w", "48021", 1, 2);
  if (token !== "w:48021:1/2") {
    return refuse("ENGINE_TOKEN_DIVERGED", `token grammar produced ${JSON.stringify(token)}, expected "w:48021:1/2"`);
  }
  return { verdict: "PASS", ...out, token };
}

/** Comments are stripped before scanning: a doc header that NAMES a destructive status is not a
 * destructive statement, and a scan that flags the guard's own documentation is noise -- which is
 * how a scan gets narrowed "to make it pass" instead of being fixed. */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/[^\n]*$/gm, "");
}

/**
 * Half 2: no second number in the engine. Scans for a share LITERAL anywhere outside the
 * declaration and the tests. A reference (`= MAX_DESTRUCTIVE_SHARE`) is not a literal and passes,
 * which is the point: the writer's number must be the declaration's, not its own.
 */
export function scanForSecondThresholds({ root = PACKAGE_ROOT } = {}) {
  const offenders = [];
  const declarationPath = path.join(root, "scripts", DECLARATION_FILE);
  const selfPath = path.join(root, "scripts", SELF_FILE);
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SCAN_SKIP_DIRS.has(entry)) continue;
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (/\.(mjs|ts)$/.test(entry) && !/\.test\.(mjs|ts)$/.test(entry)) {
        if (path.resolve(full) === path.resolve(declarationPath)) continue;
        if (path.resolve(full) === path.resolve(selfPath)) continue;
        const src = stripComments(readFileSync(full, "utf8"));
        // A declared share number: `const MAX_X_SHARE = 0.05;` (a literal, not an identifier).
        const re = /const\s+(MAX_[A-Z0-9_]*SHARE)\s*=\s*([0-9]*\.?[0-9]+)\s*;/g;
        let m;
        while ((m = re.exec(src)) !== null) {
          offenders.push({
            file: path.relative(root, full),
            constant: m[1],
            value: Number(m[2]),
          });
        }
      }
    }
  };
  for (const sub of ["src", "scripts"]) {
    const dir = path.join(root, sub);
    try {
      walk(dir);
    } catch {
      // A missing subtree is not a divergence; the offline half still runs.
    }
  }
  if (offenders.length > 0) {
    return refuse(
      "SECOND_THRESHOLD_DECLARED",
      `${offenders.length} module(s) declare a share literal beside the program's one number: ` +
        offenders.map((o) => `${o.file} (${o.constant} = ${o.value})`).join(", ") +
        `. Read MAX_DESTRUCTIVE_SHARE from ${DECLARATION_FILE} instead.`,
    );
  }
  return { verdict: "PASS", offenders };
}

/**
 * Half 3: re-derive the factory's declaration from a local clone and compare. Refuses on an
 * unreadable clone rather than skipping, because a check that silently passes when it cannot read
 * its subject is the failure this whole row is about.
 */
export function reDeriveFromFactory({ factoryPath, pin = PROGRAM_DECLARATION_PIN } = {}) {
  if (!factoryPath) {
    return refuse("FACTORY_UNREADABLE", "--factory <path-to-hauska-factory> was not supplied");
  }
  let text;
  try {
    text = execFileSync("git", ["-C", factoryPath, "show", `${pin.ref}:${pin.path}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    return refuse(
      "FACTORY_UNREADABLE",
      `could not read ${pin.ref}:${pin.path} from ${factoryPath} (${e.message.split("\n")[0]}). ` +
        `The pin needs a clone that contains ${pin.ref}.`,
    );
  }
  const sha = normalisedSha256(Buffer.from(text, "utf8"));
  if (sha !== pin.sha256) {
    return refuse(
      "PIN_HASH_MISMATCH",
      `factory ${pin.path} at ${pin.ref} hashes ${sha}, the pin records ${pin.sha256}. The pinned ` +
        `file is not what this declaration was copied from.`,
    );
  }
  const constant = /export const MAX_DESTRUCTIVE_SHARE = ([0-9]*\.?[0-9]+);/.exec(text);
  const envVar = /export const AUTHORISATION_ENV_VAR = "([^"]+)";/.exec(text);
  const diverged = [];
  if (!constant || Number(constant[1]) !== MAX_DESTRUCTIVE_SHARE) {
    diverged.push(`MAX_DESTRUCTIVE_SHARE: factory ${constant ? constant[1] : "UNREADABLE"} vs engine ${MAX_DESTRUCTIVE_SHARE}`);
  }
  if (!envVar || envVar[1] !== AUTHORISATION_ENV_VAR) {
    diverged.push(`AUTHORISATION_ENV_VAR: factory ${envVar ? envVar[1] : "UNREADABLE"} vs engine ${AUTHORISATION_ENV_VAR}`);
  }
  if (!text.includes("DESTRUCTIVE_BLAST_RADIUS")) {
    diverged.push("the factory file no longer carries a DESTRUCTIVE_BLAST_RADIUS refusal code");
  }
  if (diverged.length > 0) {
    return refuse("FACTORY_FACTS_DIVERGED", diverged.join("; "));
  }
  return {
    verdict: "PASS",
    factoryPath,
    ref: pin.ref,
    sha256: sha,
    facts: { MAX_DESTRUCTIVE_SHARE: Number(constant[1]), AUTHORISATION_ENV_VAR: envVar[1] },
  };
}

/**
 * Half 4: the refusal codes are thrown by identifier, not spelled by hand.
 *
 * The declaration records the engine's codes (`REFUSAL_CODES.engine`); the guard imports them and
 * passes the identifiers to `refuse(...)`. Two directions are checked, and each one alone is a
 * check that cannot fire:
 *
 *   - every `refuse(<IDENT>, ...)` in the guard must be one of the declared identifiers, so a new
 *     refusal cannot be added with a code nobody declared; and
 *   - every declared identifier must appear at a throw site, so a code cannot be declared here and
 *     never thrown, which is how a "checked" code becomes an unused one.
 *
 * `guardSource` is injectable so the test proves each direction by handing it a source that
 * violates that direction, rather than by trusting the module it is reading.
 */
export function scanForRefusalCodeDrift({
  root = PACKAGE_ROOT,
  codes = REFUSAL_CODES,
  guardSource,
} = {}) {
  let src = guardSource;
  if (src === undefined) {
    try {
      src = readFileSync(path.join(root, "scripts", "writer-blast-radius-guard.mjs"), "utf8");
    } catch (e) {
      return refuse(
        "GUARD_UNREADABLE",
        `could not read the guard whose refusal codes this declaration claims to declare: ${e.message.split("\n")[0]}`,
      );
    }
  }
  // The guard's own helper is `function refuse(code, message, detail)`; its parameter list is the
  // one `refuse(` in the file that is not a throw site, so the declaration is removed before the
  // call sites are read rather than a lookbehind trying to tell them apart.
  const stripped = stripComments(src).replace(/\bfunction\s+refuse\s*\([^)]*\)\s*\{/g, "guard-helper {");
  const declared = Object.values(codes.engine);
  // A throw site is `refuse(<IDENT>, ...)` or `refuse("<CODE>", ...)`. The string-literal form is
  // matched too, because a hand-spelled literal is exactly the drift this leg exists to catch.
  const thrown = [
    ...new Set(
      [...stripped.matchAll(/refuse\(\s*([^,()]+?)\s*,/g)].map((m) =>
        m[1].trim().replace(/^["'`]|["'`]$/g, ""),
      ),
    ),
  ];
  const undeclared = thrown.filter((t) => !declared.includes(t));
  const neverThrown = declared.filter((d) => !thrown.includes(d));
  if (undeclared.length > 0 || neverThrown.length > 0) {
    return refuse(
      "REFUSAL_CODE_DRIFT",
      [
        undeclared.length > 0
          ? `the guard throws undeclared refusal code(s) ${undeclared.join(", ")}`
          : null,
        neverThrown.length > 0
          ? `declared refusal code(s) ${neverThrown.join(", ")} are thrown nowhere in the guard`
          : null,
      ]
        .filter(Boolean)
        .join("; "),
    );
  }
  return { verdict: "PASS", thrown: [...new Set(thrown)].sort() };
}

export function evaluateDivergence({ declaration, pin = PROGRAM_DECLARATION_PIN, root, factoryPath } = {}) {
  const subject =
    declaration ??
    {
      MAX_DESTRUCTIVE_SHARE,
      AUTHORISATION_ENV_VAR,
      authorisationTokenFor,
    };
  const first = evaluateDeclarationAgainstPin({ declaration: subject, pin });
  if (first.verdict !== "PASS") return first;
  const second = scanForSecondThresholds({ root });
  if (second.verdict !== "PASS") return second;
  const codes = scanForRefusalCodeDrift({ root });
  if (codes.verdict !== "PASS") return codes;
  const third = factoryPath ? reDeriveFromFactory({ factoryPath, pin }) : { verdict: "PASS", skipped: "no --factory path supplied" };
  if (third.verdict !== "PASS") return third;
  return { verdict: "PASS", declaration: first, secondThresholds: second, refusalCodes: codes, factory: third };
}

function main(argv) {
  const factoryIdx = argv.indexOf("--factory");
  const factoryPath = factoryIdx >= 0 ? argv[factoryIdx + 1] : null;
  const result = evaluateDivergence({ factoryPath });
  const payload = {
    event: "destructive-write-share-divergence",
    pin: `${PROGRAM_DECLARATION_PIN.repo}@${PROGRAM_DECLARATION_PIN.ref}:${PROGRAM_DECLARATION_PIN.path}`,
    ...result,
  };
  console.log(JSON.stringify(payload, null, 2));
  if (result.verdict !== "PASS") process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
