# RUNBOOK — tagged revisions and the credential the serving revision carries (P-279)

The instrument is [`tools/check-tagged-revision-env.mjs`](tools/check-tagged-revision-env.mjs);
the fixtures and the pinned hash record are
[`tools/fixtures/tagged-revision-env/`](tools/fixtures/tagged-revision-env).

Finding `fa9addb4`: 37 of 51 hauska-engine traffic tags pointed at revisions that
lacked `ENGINE_API_GATE_TOKEN`. The reports lane removed those tags under P-251 on
2026-09-16, which removed the INSTANCE. The CLASS survived: on 2026-09-17 the
integration seat measured the same shape live on `factory-control`, `cortex-api`
(seventeen tags), `smartsite-mcp` (thirty tags) and `hauska-retrieval-api`. Every
one of those tag URLs is reachable and runs whatever environment its revision was
created with.

The rule this runbook enforces: **a tagged revision may not outlive a security
setting the serving revision carries.** A tag is not a read-only label. A tagged
revision is a live endpoint with its own frozen environment.

---

## 1. What the check does

It reads two things per service, both by FIELD from `--format=json`, never from a
positional formatter:

1. `status.traffic` of the service — the serving revision (the single entry at
   `percent=100`) and every `tag`.
2. the revision list — each revision's `spec.containers[0].env`.

A tag FAILS when its revision lacks a variable name the serving revision carries
**and** that variable is credential-bearing: secret-backed (`valueFrom.secretKeyRef`)
or named like a credential (`TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `API_KEY`,
`_KEY$`, `SERVICE_KEY`).

Ordinary configuration drift — a plain `*_URL`, a feature flag — is reported as a
NOTE and does not fail. A gate that fires on endpoint drift is permanently red, and
a permanently red gate is a dead gate (DEV_PROCESS 2.0).

Exit codes: `0` pass · `1` FAIL (the class is live) · `2` REFUSE (could not read
what it needs — **never** treated as a pass) · `3` usage error. REFUSE covers a
service with no traffic entries, two entries claiming `percent=100`, a missing
revision, and unreadable `gcloud` output. A refusal is a finding, not a failure of
the deploy: it means the question could not be answered.

It never reads or prints a secret VALUE. Only names and Secret Manager reference
names.

## 2. Deploy through the wrapper (hauska-engine's three services)

This repo has no deploy workflow for `hauska-engine-api`, `hauska-retrieval-api`
and `hauska-mcp-server`. The deploy path is
[`tools/deploy-cloud-run-service.mjs`](tools/deploy-cloud-run-service.mjs): it runs
the hand `gcloud run deploy` verbatim and then runs the check against the service
that deploy touched, propagating the check's exit code unchanged.

```bash
# a deploy, then the check — one command, the wrapper is the deploy path
node tools/deploy-cloud-run-service.mjs \
  --service hauska-retrieval-api \
  --project hauska-prod-497015 --region us-central1 \
  --source . --allow-unauthenticated \
  --set-secrets=SUBSTRATE_DATABASE_URL=DATABASE_URL:latest

# a traffic shift goes through it too, because the shift is when the class is created
node tools/deploy-cloud-run-service.mjs \
  --service hauska-retrieval-api \
  --project hauska-prod-497015 --region us-central1 \
  -- --to-tags=canary=100

# see what the check says WITHOUT changing anything
node tools/deploy-cloud-run-service.mjs \
  --service hauska-retrieval-api \
  --project hauska-prod-497015 --region us-central1 --dry-run
```

Every argument after `--` goes to `gcloud` untouched; nothing in the wrapper
rewrites, defaults or filters a deploy flag, so a wrapper run and a hand run are the
same command. Exit codes: `0` pass · `1` the check FAILED (the class is live on this
service) · `2` the check REFUSED (it could not read what it needed — never a pass) ·
`3` usage · `4` the deploy itself failed, so the check was not run. `1` and `4` are
separate on purpose: "the class is live" and "the deploy broke" are different
problems.

### The census, without deploying anything

```bash
# all five covered services, all projects
node tools/check-tagged-revision-env.mjs --covered

# one service, explicitly
node tools/check-tagged-revision-env.mjs \
  --project hauska-prod-497015 --region us-central1 \
  --service hauska-retrieval-api

# machine-readable (for a job or a close artifact)
node tools/check-tagged-revision-env.mjs --covered --json
```

The three services this repo deploys by hand are `hauska-engine-api`,
`hauska-retrieval-api` and `hauska-mcp-server`, all in `hauska-prod-497015`
/ `us-central1`. `cortex-api` and `smartsite-mcp` live in
`legacy-design-tools-prod` and are covered by that repo's deploy workflows, but
`--covered` from here reads all five and is the census command.
**Why both after the deploy and after the shift.** At canary time the new revision
is at 0 percent and the old one is still serving, so a credential ADDED by this
deploy is invisible to the comparison — the serving revision does not carry it yet.
The comparison only becomes complete once traffic has moved. The instance of this
class is created by the shift, so the shift is when it must be read.

## 3. What to do when it FAILS

It prints, per service: the failing tag, its revision, and the exact variable names
that revision lacks. **Removing or repointing a tag is an operator decision, not
this instrument's.** The check names the problem; it never mutates anything, and
neither should you on its behalf.

To remove stale tags (operator action, after the ruling):

```bash
gcloud run services update-traffic <service> \
  --project=hauska-prod-497015 --region=us-central1 \
  --remove-tags=<tag,tag>
```

Removing a tag does not delete the revision, does not move traffic, and does not
change the serving revision. A tag that is still needed should be repointed, not
removed — deploy a revision that carries the current credentials and move the tag
to it.

## 4. The control surface, stated honestly

This is the part a reader should not have to infer.

| Service | Where the live check runs | Is it an interlock? |
| --- | --- | --- |
| `cortex-api` | `legacy-design-tools` `cloud-run-deploy.yml` — after canary deploy and after the traffic shift; a non-zero exit fails the job | yes, where the deploy runs through that workflow |
| `smartsite-mcp` | `legacy-design-tools` `cloud-run-deploy-smartsite-mcp.yml` — same two points | yes, where the deploy runs through that workflow |
| `hauska-engine-api` | `tools/deploy-cloud-run-service.mjs` — the deploy path itself runs this check and exits with its code | yes when the deploy goes through the wrapper; a hand `gcloud run deploy` that skips it is unobserved |
| `hauska-retrieval-api` | same wrapper; referenced from [`services/retrieval-api/DEPLOY.md`](services/retrieval-api/DEPLOY.md) | same |
| `hauska-mcp-server` | same wrapper (its service is in `--covered`; its own repo, which this lane was not authorised to change, is named in the close as an unwired deploy path) | same |

What is mechanical in this repo without a deploy, in `.github/workflows/ci.yml` on
every push: `--selftest`, `--check-divergence`, and a `--help` smoke of the wrapper
so the deploy path stays invocable. Those keep the RULE from rotting and the deploy
path from breaking. None of them watches a deploy: only the wrapper does that, and
only for a deploy that uses it.

### Bypasses — named, not denied

1. A hand `gcloud run deploy <service> --tag=<tag>` that does not go through the
   wrapper. For the three engine services the wrapper IS the deploy path, so a hand
   command that skips it is unobserved by anything in this repo. The wrapper makes
   the check part of a deploy; it cannot make a deploy use the wrapper.
2. Any deploy path, workflow or cloudbuild that does not call this check — including
   a deploy driven from the Cloud Run console or from another repository.
3. A service not in `--covered` and not passed via `--service`.
4. Running the check and not letting its exit code fail the step that ran it. A
   check whose exit code is ignored is a log line, not a control.

## 5. Fixing the check itself

`tools/check-tagged-revision-env.mjs` is the CANONICAL copy. `legacy-design-tools`
runs a byte-identical copy at `scripts/check-tagged-revision-env.mjs` and pins this
repo's `main` branch in its own record (`scripts/fixtures/tagged-revision-env/canonical.json`).
Its CI runs `--check-divergence`, which fetches that branch's copy and refuses
on any byte difference — so two implementations cannot drift into two rules
(DEV_PROCESS 2.4).

If you change this file:

1. Change `PREDICATE_VERSION` when the predicate's meaning changes (not for a
   comment or a message).
2. Update the `sha256` in `tools/fixtures/tagged-revision-env/canonical.json` — the
   hash is over the file's bytes with CRLF/CR normalized to LF, so a Windows clone
   and a Linux runner agree. `--check-divergence` fails until you do, which is the
   intended forcing function.
3. Add a fixture case if you add a branch. A branch with no fixture is a branch
   nobody has executed.
4. Open the matching PR in `legacy-design-tools` to re-pin its record to the new
   commit. Until it merges, that repo's divergence check refuses — deliberately,
   because an unrevised copy is exactly the state this control exists to catch.

## 6. Local verification (no cloud access)

```bash
node tools/check-tagged-revision-env.mjs --selftest          # fixture set + the reverted-predicate falsifier
node tools/check-tagged-revision-env.mjs --from-fixture tools/fixtures/tagged-revision-env/fail
node tools/check-tagged-revision-env.mjs --check-divergence
```

`--selftest` includes an executed falsifier: it runs the FAIL fixture through the
real predicate at production scope (must report missing credentials) and again with
the scope reverted to "require nothing" (must report none). That is what makes this
a measuring instrument rather than a syntax check.
