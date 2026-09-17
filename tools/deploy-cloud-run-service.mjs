#!/usr/bin/env node
/**
 * deploy-cloud-run-service.mjs — the P-279 deploy path for hauska-engine's Cloud Run services.
 *
 * WHY THIS FILE EXISTS. hauska-engine has no committed deploy workflow. cloudbuild.engine-api.yaml
 * builds an image and stops; the deploys of hauska-engine-api, hauska-retrieval-api and
 * hauska-mcp-server are hand `gcloud run deploy` commands (services/retrieval-api/DEPLOY.md). A
 * check that exists only in a runbook runs on a human's memory, and memory is not a control. This
 * wrapper IS the deploy command for those three services: it runs the deploy you were already
 * running, verbatim, and then runs tools/check-tagged-revision-env.mjs against the service that
 * deploy touched, propagating the check's own exit code unchanged.
 *
 * WHY THE CHECK RUNS AFTER THE DEPLOY AND NOT INSTEAD OF IT. A deploy is what creates the new
 * revision; the tag list is what a deploy leaves lying around. The check compares every tag against
 * the SERVING revision, so a credential this deploy ADDS is invisible to it until traffic moves —
 * which is why the same check also has to run after a traffic shift. In this repo the shift is a
 * separate hand command, and this wrapper is what a shift should go through too:
 *
 *   node tools/deploy-cloud-run-service.mjs --service <svc> --project <p> --region <r> -- \
 *     --to-tags=canary=100
 *
 * `gcloud run deploy` is documented here, but every argument after `--` is passed through
 * untouched, so `gcloud run services update-traffic` works the same way.
 *
 * USAGE
 *   node tools/deploy-cloud-run-service.mjs \
 *     --service hauska-retrieval-api --project hauska-prod-497015 --region us-central1 \
 *     --source . --allow-unauthenticated --set-secrets=...
 *
 *   --dry-run   print the gcloud command and do NOT run it, then still run the check. This is how
 *               you see what the check says about a service without changing anything.
 *   --          everything after it goes to gcloud unchanged. Nothing here rewrites, defaults or
 *               filters a deploy flag: a wrapper run and a hand run must be the same command.
 *   --help      usage.
 *
 * EXIT CODES — 0, 1 and 2 are the CHECK's codes, for the check's reasons, passed through:
 *   0  the deploy ran (or --dry-run) and every tag carries the serving revision's credentials
 *   1  the check FAILED: the class is live on this service. The deploy already happened; the
 *      service's tags are the problem, and the check names them. Removing or repointing a tag is
 *      an operator decision, not this tool's.
 *   2  the check REFUSED: it could not read the service or its revisions. Never a pass.
 *   3  usage error.
 *   4  the DEPLOY itself failed, so the check was not run. Distinct from 1 on purpose: "the deploy
 *      broke" and "the class is live" are different problems and must not read alike.
 *
 * WHAT BYPASSES IT — the answer is never "nothing":
 *   1. A hand `gcloud run deploy <service> --tag=<tag>` that does not call this wrapper. Nothing in
 *      this repo can see that command. This wrapper makes the check part of a deploy it performs;
 *      it cannot make a deploy use the wrapper.
 *   2. A deploy driven from the Cloud Run console, from another repo, or by a cloudbuild trigger
 *      that does not call it.
 *   3. A service not in the covered list — this wrapper checks the service you name, and refuses a
 *      name it does not know unless --allow-uncovered is passed (deliberate friction: a new service
 *      appearing in the covered list is a change to COVERED_SERVICES in the check, in a PR).
 *   4. Ignoring the exit code. A wrapper whose code is discarded is a log line.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COVERED_SERVICES } from "./check-tagged-revision-env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, "check-tagged-revision-env.mjs");

const USAGE = `deploy-cloud-run-service — P-279 deploy path

  node tools/deploy-cloud-run-service.mjs --service <name> --project <id> --region <id> [flags] -- [gcloud args...]

  --service <name>     Cloud Run service to deploy (required)
  --project <id>       GCP project (required)
  --region <id>        region (required)
  --dry-run            print the gcloud command, do not run it, then run the check
  --allow-uncovered    permit a service that is not in the covered list
  --help               this text

  Covered services: ${COVERED_SERVICES.map((c) => c.service).join(", ")}

Exit codes: 0 pass · 1 check FAIL · 2 check REFUSE · 3 usage · 4 the deploy itself failed`;

function parseArgs(argv) {
  const out = { passthrough: [], dryRun: false, allowUncovered: false, help: false, bad: null, service: null, project: null, region: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--") {
      out.passthrough = argv.slice(i + 1);
      break;
    } else if (a === "--service") out.service = argv[++i];
    else if (a === "--project") out.project = argv[++i];
    else if (a === "--region") out.region = argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--allow-uncovered") out.allowUncovered = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (out.passthrough.length === 0 && a.startsWith("--")) out.passthrough.push(a);
    else out.bad = a;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (args.bad || !args.service || !args.project || !args.region) {
    console.log(USAGE);
    process.exit(3);
  }

  const covered = COVERED_SERVICES.some((c) => c.service === args.service);
  if (!covered && !args.allowUncovered) {
    console.error(`REFUSE: ${args.service} is not in the covered list. Pass --allow-uncovered to deploy it anyway (the check will still run).`);
    console.log(USAGE);
    process.exit(3);
  }

  const gcloud = process.env.GCLOUD_BIN || (process.platform === "win32" ? "gcloud.cmd" : "gcloud");
  const gcloudArgs = ["run", "deploy", args.service, `--project=${args.project}`, `--region=${args.region}`, ...args.passthrough];

  console.log(`deploy-cloud-run-service: ${gcloud} ${gcloudArgs.join(" ")}`);
  if (!args.dryRun) {
    const res = spawnSync(gcloud, gcloudArgs, { stdio: "inherit", shell: process.platform === "win32" });
    if (res.error || res.status !== 0) {
      console.error(`\nDEPLOY FAILED (${res.error ? res.error.message : `gcloud exited ${res.status}`}). The tagged-revision check was NOT run: it would describe the service as it still is, not as this deploy intended it to be. Fix the deploy and run this wrapper again.`);
      process.exit(4);
    }
    console.log("\ndeploy-cloud-run-service: deploy finished; checking tagged revisions against the serving revision.");
  } else {
    console.log("deploy-cloud-run-service: --dry-run, the deploy was not run.");
  }

  const check = spawnSync(
    process.execPath,
    [CHECK, "--project", args.project, "--region", args.region, "--service", args.service],
    { stdio: "inherit" },
  );
  if (check.error) {
    console.error(`REFUSE: could not run the tagged-revision check: ${check.error.message}`);
    process.exit(2);
  }
  // The check's own code, unmodified. 1 means the class is live on this service; 2 means nobody
  // could read what it needed, which is never a pass.
  process.exit(check.status ?? 2);
}

main();
