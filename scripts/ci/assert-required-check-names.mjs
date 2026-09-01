#!/usr/bin/env node
/**
 * Assert that every GitHub required status-check context still has a
 * matching workflow job name. Required checks match the job `name:`
 * field (or the job id when `name:` is absent), not the workflow
 * filename and not the job key when `name:` is set.
 *
 * Live GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks
 * is authoritative. An unreachable, 403, 404, or empty response is a
 * failure: do not pass on "could not check". Empty required contexts
 * would vacuously satisfy "every context has a job name".
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  YamlParseError,
  collectJobCheckNames,
  isLocalReusableWorkflow,
  parseWorkflowYaml,
} from "./parse-workflow-yaml.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

const FAIL = {
  API: "api_unreadable",
  EMPTY_REQUIRED: "empty_required_contexts",
  MISSING_JOB: "required_context_missing_job_name",
  PARSE: "workflow_parse",
  USAGE: "usage",
};

function fail(code, message) {
  console.error(`FAIL (${code}): ${message}`);
  return { ok: false, code, message };
}

function ok(message, extra) {
  console.log(`OK: ${message}`);
  return { ok: true, code: "ok", message, ...extra };
}

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "workflows-dir": { type: "string" },
      "required-contexts": { type: "string", multiple: true },
      "protection-json": { type: "string" },
      "repo": { type: "string" },
      "branch": { type: "string" },
      "dump-job-names": { type: "boolean", default: false },
      "expect-failure": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  return values;
}

function splitContexts(values) {
  if (!values || values.length === 0) return [];
  const out = [];
  for (const v of values) {
    for (const part of v.split(",")) {
      const s = part.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

function listWorkflowFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    throw new Error(`cannot read workflows dir ${dir}: ${err.message}`);
  }
  const files = [];
  for (const name of entries) {
    const ext = extname(name).toLowerCase();
    if (ext !== ".yml" && ext !== ".yaml") continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (!st.isFile()) continue;
    files.push(resolve(path));
  }
  files.sort();
  if (files.length === 0) {
    throw new Error(`no .yml/.yaml files in ${dir}`);
  }
  return files;
}

function resolveLocalUses(uses, repoRoot) {
  const pathPart = uses.split("@")[0];
  const rel = pathPart.startsWith("./") ? pathPart.slice(2) : pathPart;
  return resolve(repoRoot, rel);
}

function collectAllJobNames(workflowsDir, repoRoot) {
  const queue = listWorkflowFiles(workflowsDir);
  const seen = new Set();
  const names = [];
  const remoteUses = [];
  while (queue.length > 0) {
    const file = queue.shift();
    const resolved = resolve(file);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    let doc;
    try {
      doc = parseWorkflowYaml(readFileSync(resolved, "utf8"), resolved);
    } catch (err) {
      if (err instanceof YamlParseError) {
        throw err;
      }
      throw new YamlParseError(`${resolved}: ${err.message}`);
    }
    const collected = collectJobCheckNames(doc, resolved);
    names.push(...collected.names);
    for (const u of collected.localUses) {
      if (isLocalReusableWorkflow(u.uses)) {
        queue.push(resolveLocalUses(u.uses, repoRoot));
      } else {
        remoteUses.push(u);
      }
    }
  }
  return { names, remoteUses, files: [...seen] };
}

function contextsFromProtectionPayload(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("protection payload is not an object");
  }
  const fromContexts = Object.prototype.hasOwnProperty.call(payload, "contexts")
    ? payload.contexts
    : undefined;
  const fromChecks = Object.prototype.hasOwnProperty.call(payload, "checks")
    ? payload.checks
    : undefined;
  if (fromContexts === undefined && fromChecks === undefined) {
    throw new Error(
      "protection payload has neither contexts nor checks (unreadable, not empty)"
    );
  }
  if (fromContexts !== undefined && !Array.isArray(fromContexts)) {
    throw new Error("protection.contexts is not an array");
  }
  if (fromChecks !== undefined && !Array.isArray(fromChecks)) {
    throw new Error("protection.checks is not an array");
  }
  const contextNames = (fromContexts ?? []).map((c, i) => {
    if (typeof c !== "string" || c.trim() === "") {
      throw new Error(`protection.contexts[${i}] is not a non-empty string`);
    }
    return c;
  });
  const checkNames = (fromChecks ?? []).map((c, i) => {
    if (c === null || typeof c !== "object" || typeof c.context !== "string") {
      throw new Error(`protection.checks[${i}].context is not a string`);
    }
    if (c.context.trim() === "") {
      throw new Error(`protection.checks[${i}].context is empty`);
    }
    return c.context;
  });
  const a = [...new Set(contextNames)].sort();
  const b = [...new Set(checkNames)].sort();
  if (fromContexts !== undefined && fromChecks !== undefined) {
    if (a.length !== b.length || a.some((name, i) => name !== b[i])) {
      throw new Error(
        `protection.contexts and protection.checks[].context disagree: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`
      );
    }
  }
  const names = fromChecks !== undefined ? [...new Set(checkNames)] : [...new Set(contextNames)];
  return names;
}

function ghApiJson(apiPath, token) {
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN/GH_TOKEN is missing; cannot read branch protection (fail closed, not skipped)"
    );
  }
  const env = { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token };
  const result = spawnSync(
    "gh",
    [
      "api",
      apiPath,
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
    ],
    { encoding: "utf8", env, windowsHide: true }
  );
  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error(
        "gh is not installed; cannot read branch protection (fail closed, not skipped)"
      );
    }
    throw new Error(`gh api spawn failed: ${result.error.message}`);
  }
  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();
  const status = result.status;
  if (status !== 0) {
    const combined = `${stdout}\n${stderr}`;
    const httpMatch = combined.match(/HTTP\s+(\d{3})/i);
    const httpStatus = httpMatch ? Number(httpMatch[1]) : status;
    const hint = administrationHint(httpStatus, combined);
    throw new Error(
      `gh api ${apiPath} exited ${status}. Body: ${truncate(combined, 500)}. ${hint}`
    );
  }
  if (stdout === "") {
    throw new Error(`gh api ${apiPath} returned empty stdout`);
  }
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`gh api ${apiPath} returned non-JSON: ${err.message}`);
  }
  return payload;
}

function fetchRequiredContexts({ repo, branch, token }) {
  if (!repo || !repo.includes("/")) {
    throw new Error("repo must be owner/name");
  }
  if (!branch) {
    throw new Error("branch is missing; cannot choose a protection target");
  }
  const apiPath = `repos/${repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`;
  const payload = ghApiJson(apiPath, token);
  return {
    url: `https://api.github.com/${apiPath}`,
    payload,
    contexts: contextsFromProtectionPayload(payload),
  };
}

function administrationHint(status, body) {
  const lower = `${body}`.toLowerCase();
  if (status === 403 || status === 404 || lower.includes("resource not accessible")) {
    return (
      "Branch-protection required_status_checks requires Administration: read " +
      "(GitHub Apps permission matrix for GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks). " +
      "GITHUB_TOKEN cannot be granted `administration` — that key is not in the workflow-syntax permissions list " +
      "(actions, contents, checks, ...). Do not skip. Do not embed a PAT. This is a loud failure."
    );
  }
  return "Do not treat this as an empty required set.";
}

function truncate(s, n) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

function tokenFromEnv() {
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.trim()) {
    return process.env.GITHUB_TOKEN.trim();
  }
  if (process.env.GH_TOKEN && process.env.GH_TOKEN.trim()) {
    return process.env.GH_TOKEN.trim();
  }
  return "";
}

function repoFromEnv(cliRepo) {
  if (cliRepo && cliRepo.trim()) return cliRepo.trim();
  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY.trim()) {
    return process.env.GITHUB_REPOSITORY.trim();
  }
  return "";
}

function branchFromEnv(cliBranch) {
  if (cliBranch && cliBranch.trim()) return cliBranch.trim();
  if (process.env.GITHUB_DEFAULT_BRANCH && process.env.GITHUB_DEFAULT_BRANCH.trim()) {
    return process.env.GITHUB_DEFAULT_BRANCH.trim();
  }
  return "";
}

function defaultWorkflowsDir(cliDir) {
  if (cliDir) {
    return isAbsolute(cliDir) ? cliDir : resolve(process.cwd(), cliDir);
  }
  return join(REPO_ROOT, ".github", "workflows");
}

function resolveDefaultBranch({ repo, token, already }) {
  if (already) return already;
  if (!token || !repo) {
    throw new Error(
      "default branch is unknown and cannot be fetched (missing token or repo)"
    );
  }
  const payload = ghApiJson(`repos/${repo}`, token);
  if (typeof payload.default_branch !== "string" || payload.default_branch.trim() === "") {
    throw new Error("repo payload has no default_branch");
  }
  return payload.default_branch;
}

async function run(argv) {
  const cli = parseCli(argv);
  const workflowsDir = defaultWorkflowsDir(cli["workflows-dir"]);
  let collected;
  try {
    collected = collectAllJobNames(workflowsDir, REPO_ROOT);
  } catch (err) {
    return fail(FAIL.PARSE, err.message);
  }
  const jobNames = collected.names.map((n) => n.name);
  const jobNameSet = new Set(jobNames);
  if (cli["dump-job-names"]) {
    for (const n of collected.names) {
      console.log(`${n.name}\t${n.jobId}\t${n.source}`);
    }
    return ok(`dumped ${collected.names.length} job check-run names`, {
      jobNames,
    });
  }

  let required;
  let requiredSource;
  const fixtureContexts = splitContexts(cli["required-contexts"]);
  if (cli["protection-json"]) {
    const path = isAbsolute(cli["protection-json"])
      ? cli["protection-json"]
      : resolve(process.cwd(), cli["protection-json"]);
    let payload;
    try {
      const raw = readFileSync(path, "utf8");
      if (raw.trim() === "") {
        return fail(FAIL.API, `protection json at ${path} is empty`);
      }
      payload = JSON.parse(raw);
      required = contextsFromProtectionPayload(payload);
      requiredSource = `file:${path}`;
    } catch (err) {
      return fail(FAIL.API, `cannot read protection json ${path}: ${err.message}`);
    }
  } else if (fixtureContexts.length > 0) {
    required = fixtureContexts;
    requiredSource = "cli:--required-contexts";
  } else {
    const token = tokenFromEnv();
    const repo = repoFromEnv(cli.repo);
    try {
      const branch = resolveDefaultBranch({
        repo,
        token,
        already: branchFromEnv(cli.branch),
      });
      const fetched = fetchRequiredContexts({
        repo,
        branch,
        token,
      });
      required = fetched.contexts;
      requiredSource = fetched.url;
    } catch (err) {
      return fail(FAIL.API, err.message);
    }
  }

  if (!Array.isArray(required)) {
    return fail(FAIL.API, "required contexts is not an array");
  }
  if (required.length === 0) {
    return fail(
      FAIL.EMPTY_REQUIRED,
      `required status checks are empty (source ${requiredSource}). Empty is not "no names to check"; it is the cheapest satisfier of forall-over-list and is refused.`
    );
  }

  const missing = required.filter((ctx) => !jobNameSet.has(ctx));
  console.log(`required_source=${requiredSource}`);
  console.log(`required=${JSON.stringify(required)}`);
  console.log(`job_names=${JSON.stringify([...jobNameSet].sort())}`);
  if (collected.remoteUses.length > 0) {
    console.log(
      `remote_workflow_call=${JSON.stringify(collected.remoteUses.map((u) => u.uses))}`
    );
  }
  if (missing.length > 0) {
    return fail(
      FAIL.MISSING_JOB,
      `required context(s) have no matching job name: ${JSON.stringify(missing)}. GitHub required checks match jobs.<id>.name (or the job id if name is absent), not step names, not the workflow filename.`
    );
  }
  return ok(
    `every required context has a matching job name (${required.length} required, ${jobNameSet.size} job names)`,
    { required, jobNames: [...jobNameSet] }
  );
}

const invokedDirectly =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const expectFailure = process.argv.includes("--expect-failure");
  const argv = process.argv.slice(2).filter((a) => a !== "--expect-failure");
  run(argv)
    .then((result) => {
      if (expectFailure) {
        if (result.ok) {
          console.error(
            "FAIL (expect_failure): check passed, but this invocation must fail to prove the instrument can fire"
          );
          process.exit(1);
        }
        console.log(`expect-failure satisfied via ${result.code}`);
        process.exit(0);
      }
      process.exit(result.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error(`FAIL (${FAIL.PARSE}): uncaught ${err.stack || err.message}`);
      process.exit(1);
    });
}
