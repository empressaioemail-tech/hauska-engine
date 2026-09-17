#!/usr/bin/env node
/**
 * check-tagged-revision-env.mjs — P-279: a tagged revision cannot outlive a security setting.
 *
 * WHAT EXECUTES: this file. Live mode reads one or more Cloud Run services and their revisions
 * with gcloud and exits non-zero when a tag points at a revision that lacks an auth or secret
 * variable the SERVING revision carries. Fixture, selftest and divergence modes run the same
 * predicate over checked-in JSON, so the control is testable with no cloud access.
 *
 * WHAT TRIGGERS IT, per service — this list is the whole control surface, and it is not uniform:
 *   - cortex-api and smartsite-mcp: legacy-design-tools' .github/workflows/cloud-run-deploy.yml and
 *     cloud-run-deploy-smartsite-mcp.yml run it live (exit code fails the job) after canary deploy
 *     and again after the traffic shift, because a variable ADDED by the new revision is invisible
 *     to the comparison until traffic moves.
 *   - hauska-engine-api, hauska-retrieval-api, hauska-mcp-server: hauska-engine carries NO deploy
 *     workflow and NO deploy cloudbuild for these three services. Their deploy path is
 *     tools/deploy-cloud-run-service.mjs (P-279): it runs the hand `gcloud run deploy` verbatim and
 *     then runs THIS check against the service that deploy touched, propagating this file's own
 *     exit code unchanged. A deploy that does not go through that wrapper is unobserved by anything
 *     in this repo — the wrapper makes the check part of a deploy; it cannot make a deploy use the
 *     wrapper. Also mechanical here: .github/workflows/ci.yml runs --selftest and --check-divergence
 *     on every push, offline, so the rule cannot rot.
 *   - It is also runnable by hand for the census: node tools/check-tagged-revision-env.mjs --covered
 *
 * WHAT FAILS (exit codes): 0 pass · 1 FAIL (the class is live) · 2 REFUSE (could not read what it
 * needs — never a pass) · 3 usage error.
 *
 * WHAT BYPASSES IT — named here because the answer is never "nothing":
 *   1. A manual `gcloud run deploy <svc> --tag=<tag>` that does not go through the deploy path
 *      above — tools/deploy-cloud-run-service.mjs in this repo, the deploy workflows in
 *      legacy-design-tools. Nothing in this repo can see that command; for the three hauska-engine
 *      services a hand command that skips the wrapper is unobserved, which is why the wrapper is
 *      the documented deploy command and not an optional extra.
 *   2. Any deploy path, workflow or cloudbuild that does not call this check — including a deploy
 *      driven from the Cloud Run console or from another repo.
 *   3. A service not in --covered (or not passed via --service).
 *   4. Reading the exit code wrongly: this control is only a control where its exit code is
 *      allowed to fail the step that ran it.
 *
 * WHY IT RUNS WHERE TRAFFIC MOVES AND NOT ONLY WHERE A TAG IS CREATED: at canary time the new
 * revision is at 0 percent and the old one is still serving, so a variable ADDED by this deploy is
 * invisible to the comparison until traffic shifts. The instance of this class is created by the
 * shift. Both places call it.
 *
 * NEVER POSITIONAL: every gcloud read is `--format=json` and every value is taken by field name.
 * A positional formatter shifts every field after a blank column, and that misread has already cost
 * this operation a wrong serving-revision claim twice.
 *
 * NEVER A SECRET VALUE: this instrument reads variable NAMES and Secret Manager reference names.
 * It never reads or prints a value.
 *
 * Predicate version: see PREDICATE_VERSION. Two byte-identical copies of this file exist (the
 * canonical copy here and the copy legacy-design-tools runs); --check-divergence is what keeps them
 * one rule rather than two implementations (DEV_PROCESS 2.4).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PREDICATE_VERSION = "tagged-revision-env/v1";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "fixtures", "tagged-revision-env");
const RECORD_PATH = join(FIXTURE_ROOT, "canonical.json");

export const EXIT = { PASS: 0, FAIL: 1, REFUSE: 2, USAGE: 3 };

/**
 * A credential-bearing NAME. Auth/secret variables are the class this row names.
 * Deliberately NOT matched: a bare `_URL`/plain endpoint such as HAUSKA_ENGINE_API_URL or
 * HAUSKA_MCP_BASE_URL — failing on ordinary configuration drift is how a gate becomes
 * permanently red, which DEV_PROCESS 2.0 forbids. Secret-backed variables are caught by
 * secretRef regardless of their name.
 */
const CREDENTIAL_NAME_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|_KEY$|SERVICE_KEY)/i;

/** The five services this row covers. Project and region are read from the live describe. */
export const COVERED_SERVICES = [
  { project: "hauska-prod-497015", region: "us-central1", service: "hauska-engine-api" },
  { project: "hauska-prod-497015", region: "us-central1", service: "hauska-retrieval-api" },
  { project: "hauska-prod-497015", region: "us-central1", service: "hauska-mcp-server" },
  { project: "legacy-design-tools-prod", region: "us-central1", service: "cortex-api" },
  { project: "legacy-design-tools-prod", region: "us-central1", service: "smartsite-mcp" },
];

/* ------------------------------- predicate ------------------------------- */

/** Env entries of a revision, read by field. Missing shapes yield [] rather than a throw. */
export function envEntries(revision) {
  const containers = revision?.spec?.containers;
  const env = Array.isArray(containers) && containers[0] ? containers[0].env : null;
  if (!Array.isArray(env)) return [];
  return env
    .filter((e) => e && typeof e.name === "string")
    .map((e) => ({
      name: e.name,
      secretRef: e?.valueFrom?.secretKeyRef?.name ?? null,
      hasRef: Boolean(e?.valueFrom?.secretKeyRef),
    }));
}

/** The required set: the serving revision's secret-backed or credential-named variables. */
export function requiredNames(servingEnv) {
  return servingEnv.filter((e) => e.hasRef || CREDENTIAL_NAME_RE.test(e.name)).map((e) => e.name);
}

/**
 * The predicate itself, as a pure function, so the falsifiers can execute it with a deliberately
 * weakened scope instead of asserting that a weakened copy would have behaved differently.
 * scope: "auth" (production) · "all" (every env name) · "none" (reverted: nothing is required).
 * Only "auth" is reachable from the CLI.
 */
export function missingForScope(servingEnv, taggedEnv, scope = "auth") {
  const allNames = servingEnv.map((e) => e.name);
  const required =
    scope === "none" ? [] : scope === "all" ? allNames : requiredNames(servingEnv);
  const have = new Set(taggedEnv.map((e) => e.name));
  return {
    required,
    missingRequired: required.filter((n) => !have.has(n)),
    missingNonRequired: allNames.filter((n) => !required.includes(n) && !have.has(n)),
  };
}

/**
 * Evaluate one service from its describe JSON and its revisions list JSON — the same objects the
 * live path reads from gcloud, so fixture and live share one code path.
 */
export function evaluateService({ project, region, service, serviceJson, revisionsJson }) {
  const base = { predicateVersion: PREDICATE_VERSION, project, region, service };
  const traffic = serviceJson?.status?.traffic;
  if (!Array.isArray(traffic) || traffic.length === 0) {
    return { ...base, verdict: "REFUSE", reason: "SERVICE_TRAFFIC_UNREADABLE" };
  }
  const atFull = traffic.filter((e) => e && e.percent === 100);
  if (atFull.length !== 1) {
    return {
      ...base,
      verdict: "REFUSE",
      reason: "SERVING_REVISION_NOT_SINGLE",
      detail: `${atFull.length} traffic entries carry percent=100`,
      traffic: traffic.map((e) => ({ tag: e?.tag ?? null, revisionName: e?.revisionName ?? null, percent: e?.percent ?? 0 })),
    };
  }
  const servingName = atFull[0].revisionName;
  if (!servingName) return { ...base, verdict: "REFUSE", reason: "SERVING_REVISION_UNNAMED" };
  if (!Array.isArray(revisionsJson)) return { ...base, verdict: "REFUSE", reason: "REVISIONS_UNREADABLE" };
  const byName = new Map(revisionsJson.map((r) => [r?.metadata?.name, r]));
  const servingRevision = byName.get(servingName);
  if (!servingRevision) {
    return { ...base, verdict: "REFUSE", reason: "SERVING_REVISION_NOT_IN_LIST", servingRevision: servingName };
  }
  const servingEnv = envEntries(servingRevision);
  if (servingEnv.length === 0) {
    return { ...base, verdict: "REFUSE", reason: "SERVING_ENV_UNREADABLE", servingRevision: servingName };
  }
  const required = requiredNames(servingEnv);
  const tags = traffic.filter((e) => e && e.tag);

  const rows = tags.map((t) => {
    const rev = byName.get(t.revisionName);
    if (!rev) {
      return {
        tag: t.tag,
        revisionName: t.revisionName,
        percent: t.percent ?? 0,
        absentFromRevisionList: true,
        missingRequired: required,
        missingNonRequired: [],
      };
    }
    const m = missingForScope(servingEnv, envEntries(rev));
    return {
      tag: t.tag,
      revisionName: t.revisionName,
      percent: t.percent ?? 0,
      absentFromRevisionList: false,
      missingRequired: m.missingRequired,
      missingNonRequired: m.missingNonRequired,
    };
  });

  const failing = rows.filter((r) => r.absentFromRevisionList || r.missingRequired.length > 0);
  return {
    ...base,
    verdict: failing.length ? "FAIL" : "PASS",
    servingRevision: servingName,
    servingEnvCount: servingEnv.length,
    requiredCount: required.length,
    required,
    tagsChecked: rows.length,
    failingTagCount: failing.length,
    absentTagCount: rows.filter((r) => r.absentFromRevisionList).length,
    tags: rows,
  };
}

/* --------------------------------- gcloud -------------------------------- */

const SHELL_SAFE = /^[A-Za-z0-9_.:@/=+-]+$/;

function gcloudBinary() {
  return process.env.P279_GCLOUD || "gcloud";
}

function quote(arg) {
  if (!SHELL_SAFE.test(arg)) {
    const err = new Error(`unsafe argument refused (shell metacharacter or quote): ${JSON.stringify(arg)}`);
    err.code = "SHELL_UNSAFE_ARG";
    throw err;
  }
  return `"${arg}"`;
}

function gcloudJson(args, { allowFailure = false } = {}) {
  const command = [gcloudBinary(), ...args].map(quote).join(" ");
  try {
    const out = execFileSync(command, { shell: true, encoding: "utf8", maxBuffer: 1024 * 1024 * 512, stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(out);
  } catch (e) {
    if (e.code === "SHELL_UNSAFE_ARG") throw e;
    const stderr = String(e.stderr || e.message || e);
    if (allowFailure) return { __error: stderr };
    const err = new Error(stderr.trim().split("\n").slice(-3).join(" | "));
    err.code = "GCLOUD_FAILED";
    throw err;
  }
}

export function readService({ project, region, service }) {
  return gcloudJson(["run", "services", "describe", service, `--project=${project}`, `--region=${region}`, "--format=json"]);
}

export function readRevisions({ project, region, service }) {
  return gcloudJson(["run", "revisions", "list", `--service=${service}`, `--project=${project}`, `--region=${region}`, "--format=json"]);
}

/** Live evaluation. Any unreadable read is a REFUSE, never a pass. */
export function evaluateLive({ project, region, service }) {
  let serviceJson;
  try {
    serviceJson = readService({ project, region, service });
  } catch (e) {
    return { predicateVersion: PREDICATE_VERSION, project, region, service, verdict: "REFUSE", reason: "SERVICE_DESCRIBE_FAILED", detail: e.message };
  }
  let revisionsJson;
  try {
    revisionsJson = readRevisions({ project, region, service });
  } catch (e) {
    return { predicateVersion: PREDICATE_VERSION, project, region, service, verdict: "REFUSE", reason: "REVISIONS_LIST_FAILED", detail: e.message };
  }
  return evaluateService({ project, region, service, serviceJson, revisionsJson });
}

/* -------------------------------- fixtures ------------------------------- */

function readFixture(dir) {
  const servicePath = join(dir, "service.json");
  const revisionsPath = join(dir, "revisions.json");
  if (!existsSync(servicePath)) return { refuse: "FIXTURE_SERVICE_MISSING", detail: servicePath };
  if (!existsSync(revisionsPath)) return { refuse: "FIXTURE_REVISIONS_MISSING", detail: revisionsPath };
  try {
    return {
      serviceJson: JSON.parse(readFileSync(servicePath, "utf8")),
      revisionsJson: JSON.parse(readFileSync(revisionsPath, "utf8")),
    };
  } catch (e) {
    return { refuse: "FIXTURE_UNPARSEABLE", detail: e.message };
  }
}

function evaluateFixture(dir, meta) {
  const f = readFixture(dir);
  if (f.refuse) {
    return { predicateVersion: PREDICATE_VERSION, ...meta, verdict: "REFUSE", reason: f.refuse, detail: f.detail };
  }
  return evaluateService({ ...meta, serviceJson: f.serviceJson, revisionsJson: f.revisionsJson });
}

/** Byte-normalized hash: CRLF and lone CR collapse to LF so Windows clones and Linux CI agree. */
export function normalizedBytes(buf) {
  return Buffer.from(Buffer.from(buf).toString("utf8").replace(/\r\n?/g, "\n"), "utf8");
}

export function fileSha256(path) {
  return createHash("sha256").update(normalizedBytes(readFileSync(path))).digest("hex");
}

export function readRecord(path = RECORD_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function selfPath() {
  return fileURLToPath(import.meta.url);
}

function fetchCanonical(record) {
  const url = `https://raw.githubusercontent.com/${record.canonicalRepo}/${record.canonicalRef}/${record.canonicalPath}`;
  try {
    return execFileSync("curl", ["-fsSL", url], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = new Error(`could not read the canonical copy at ${url}: ${String(e.stderr || e.message).trim()}`);
    err.code = "CANONICAL_UNREADABLE";
    throw err;
  }
}

/**
 * Divergence control: byte-compare this file with the canonical copy pinned in the fixture record.
 * Refuses (never passes) when the canonical copy cannot be read or when the bytes differ.
 */
export function checkDivergence({ path = selfPath(), record = readRecord() } = {}) {
  const localHash = fileSha256(path);
  const out = {
    predicateVersion: PREDICATE_VERSION,
    file: path,
    localSha256: localHash,
    canonicalRepo: record.canonicalRepo,
    canonicalPath: record.canonicalPath,
    canonicalRef: record.canonicalRef,
    recordSha256: record.sha256,
  };
  if (record.sha256 && localHash !== record.sha256) {
    return { ...out, verdict: "REFUSE", reason: "SELF_HASH_MISMATCH", detail: `local ${localHash} != recorded ${record.sha256}` };
  }
  // The canonical repo's own copy is canonical: it has nothing to fetch and compare against.
  if (!record.canonicalRef) return { ...out, verdict: "PASS", compared: "self-hash only (this is the canonical copy)" };
  let remote;
  try {
    remote = fetchCanonical(record);
  } catch (e) {
    return { ...out, verdict: "REFUSE", reason: "CANONICAL_UNREADABLE", detail: e.message };
  }
  const remoteHash = createHash("sha256").update(normalizedBytes(Buffer.from(remote, "utf8"))).digest("hex");
  if (remoteHash !== localHash) {
    return { ...out, verdict: "REFUSE", reason: "DIVERGED_FROM_CANONICAL", detail: `local ${localHash} != canonical ${remoteHash}` };
  }
  return { ...out, verdict: "PASS", canonicalSha256: remoteHash };
}

/** The shipped fixture set, run through the real predicate. Both directions, plus the refusals. */
export function selftest() {
  const cases = [
    { dir: "pass", expect: "PASS", why: "every tag carries the serving revision's required variables" },
    { dir: "fail", expect: "FAIL", why: "a tag points at a revision missing a secret the serving revision carries" },
    { dir: "refuse-ambiguous-traffic", expect: "REFUSE", why: "two traffic entries claim percent=100" },
    { dir: "refuse-no-traffic", expect: "REFUSE", why: "no traffic entries at all" },
    { dir: "refuse-absent-revision", expect: "REFUSE-OR-FAIL", why: "a tagged revision is absent from the revision list" },
    { dir: "refuse-unreadable-revisions", expect: "REFUSE", why: "the revisions listing is unreadable" },
  ];
  const results = [];
  let failed = 0;
  for (const c of cases) {
    const dir = join(FIXTURE_ROOT, c.dir);
    const r = evaluateFixture(dir, { project: "fixture", region: "fixture", service: c.dir });
    const ok = c.expect === "REFUSE-OR-FAIL" ? r.verdict !== "PASS" : r.verdict === c.expect;
    if (!ok) failed += 1;
    results.push({ case: c.dir, expect: c.expect, got: r.verdict, reason: r.reason ?? null, ok, why: c.why });
  }
  // Falsifier 3: revert the predicate and the failing case must flip. Executed, not asserted by hand.
  const failDir = join(FIXTURE_ROOT, "fail");
  const f = readFixture(failDir);
  if (f.refuse) {
    failed += 1;
    results.push({ case: "fail/predicate-reverted", expect: "PASS", got: `REFUSE:${f.refuse}`, ok: false, why: "fixture unreadable" });
  } else {
    const servingName = (f.serviceJson.status.traffic.find((t) => t.percent === 100) || {}).revisionName;
    const byName = new Map(f.revisionsJson.map((r) => [r.metadata.name, r]));
    const servingEnv = envEntries(byName.get(servingName));
    const tagRow = f.serviceJson.status.traffic.find((t) => t.tag && t.revisionName !== servingName);
    const taggedEnv = envEntries(byName.get(tagRow.revisionName));
    const production = missingForScope(servingEnv, taggedEnv, "auth");
    const reverted = missingForScope(servingEnv, taggedEnv, "none");
    const ok = production.missingRequired.length > 0 && reverted.missingRequired.length === 0;
    if (!ok) failed += 1;
    results.push({
      case: "fail/predicate-reverted",
      expect: "production scope fails, reverted scope (nothing required) passes",
      got: `auth missing=${production.missingRequired.length} · reverted missing=${reverted.missingRequired.length}`,
      ok,
      why: "falsifier 3 — the guard is not syntax-only",
    });
  }
  return { predicateVersion: PREDICATE_VERSION, cases: results, failed, passed: failed === 0 };
}

/* ---------------------------------- cli ---------------------------------- */

const USAGE = `check-tagged-revision-env — P-279

  --covered                          check all five covered services (${COVERED_SERVICES.map((c) => c.service).join(", ")})
  --service <name>                   check one service (repeatable); needs --project and --region
  --project <id> --region <id>       target for --service
  --from-fixture <dir>               evaluate <dir>/service.json + <dir>/revisions.json instead of gcloud
  --selftest                         run the shipped fixture set through the real predicate
  --check-divergence                 byte-compare this file with the canonical copy in the fixture record
  --json                             machine-readable output

Exit codes: 0 pass · 1 FAIL (class live) · 2 REFUSE (unreadable — never a pass) · 3 usage`;

function parseArgs(argv) {
  const out = { services: [], covered: false, fromFixture: null, json: false, selftest: false, divergence: false, project: null, region: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--covered") out.covered = true;
    else if (a === "--json") out.json = true;
    else if (a === "--selftest") out.selftest = true;
    else if (a === "--check-divergence") out.divergence = true;
    else if (a === "--service") out.services.push(argv[++i]);
    else if (a === "--project") out.project = argv[++i];
    else if (a === "--region") out.region = argv[++i];
    else if (a === "--from-fixture") out.fromFixture = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else out.bad = a;
  }
  return out;
}

function reportHuman(results) {
  for (const r of results) {
    const head = `${r.verdict}  ${r.project}/${r.service}${r.reason ? `  [${r.reason}]` : ""}`;
    console.log(head);
    if (r.detail) console.log(`  detail: ${r.detail}`);
    if (r.servingRevision) {
      console.log(`  serving=${r.servingRevision}  tags=${r.tagsChecked}  required=${r.requiredCount}  failing=${r.failingTagCount}`);
      for (const t of r.tags || []) {
        if (t.absentFromRevisionList) {
          console.log(`    FAIL  ${t.tag} -> ${t.revisionName}  ABSENT FROM REVISION LIST (cannot prove its env; refusing to call it covered)`);
        } else if (t.missingRequired.length) {
          console.log(`    FAIL  ${t.tag} -> ${t.revisionName}  missing: ${t.missingRequired.join(", ")}`);
        }
        if (!t.absentFromRevisionList && t.missingNonRequired?.length) {
          console.log(`    note  ${t.tag} -> ${t.revisionName}  missing non-credential vars (not a failure): ${t.missingNonRequired.join(", ")}`);
        }
      }
    }
  }
}

function worst(results) {
  if (results.some((r) => r.verdict === "FAIL")) return EXIT.FAIL;
  if (results.some((r) => r.verdict === "REFUSE")) return EXIT.REFUSE;
  return EXIT.PASS;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.bad || args.help) {
    console.log(USAGE);
    process.exit(args.bad ? EXIT.USAGE : EXIT.PASS);
  }

  if (args.selftest) {
    const r = selftest();
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.passed ? EXIT.PASS : EXIT.FAIL);
  }

  if (args.divergence) {
    const r = checkDivergence();
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.verdict === "PASS" ? EXIT.PASS : EXIT.REFUSE);
  }

  if (args.fromFixture) {
    const r = evaluateFixture(args.fromFixture, { project: args.project ?? "fixture", region: args.region ?? "fixture", service: args.service?.[0] ?? args.fromFixture });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.verdict === "PASS" ? EXIT.PASS : r.verdict === "FAIL" ? EXIT.FAIL : EXIT.REFUSE);
  }

  const targets = args.covered
    ? COVERED_SERVICES
    : args.services.map((s) => ({ project: args.project, region: args.region, service: s }));
  if (targets.length === 0 || targets.some((t) => !t.service || !t.project || !t.region)) {
    console.log(USAGE);
    process.exit(EXIT.USAGE);
  }

  const results = targets.map((t) => evaluateLive(t));
  if (args.json) console.log(JSON.stringify({ predicateVersion: PREDICATE_VERSION, results }, null, 2));
  else reportHuman(results);

  const code = worst(results);
  if (!args.json) {
    const failing = results.filter((r) => r.verdict === "FAIL");
    console.log(
      `\n${results.length} service(s): ${results.filter((r) => r.verdict === "PASS").length} pass, ${failing.length} fail, ${results.filter((r) => r.verdict === "REFUSE").length} refuse`,
    );
    if (failing.length) {
      console.log("The class is live. Removing a stale tag is an operator decision: gcloud run services update-traffic <service> --remove-tags=<tag,tag>");
    }
  }
  process.exit(code);
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("check-tagged-revision-env.mjs");
if (isMain) main();
