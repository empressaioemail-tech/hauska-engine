# retrieval-api — Cloud Run deploy

The Stream 1C retrieval API, deployed publicly so the Hauska MCP Server's
catalog tools have a stable read-only endpoint (Lane E Phase E0).

## Where it runs

- **Project:** `hauska-prod-497015` — production Hauska data plane
  (retrieval-api, MCP server). The interim `legacy-design-tools-prod`
  deploy was torn down 2026-05-21; do not target that project.
- **Region:** `us-central1` (matches the sibling services).
- **Service name:** `hauska-retrieval-api`.

## How corpus gets in (F1 Phase 0 / G2 — postgres-serve)

Production serves **Postgres only** (`SUBSTRATE_DATABASE_URL` →
`PgStorage`). The Cloud Run boot path does **not** `JSON.parse` the
corpus snapshot into the heap — that path OOM-crash-looped a 1Gi
revision after Central-TX breadth bakes filled the durable store.

Property atoms are written by the bake pipeline into substrate Neon
(`hauska_mcp`). Code-corpus atoms (ICC / jurisdiction sections) are
loaded offline from the committed snapshot:

```bash
DATABASE_URL='postgres://.../hauska_mcp?sslmode=require' \
  NODE_OPTIONS=--max-old-space-size=4096 \
  node packages/storage/scripts/load-snapshot-into-pg.mjs
```

Local/dev without a substrate URL may still hydrate
`CORPUS_SNAPSHOT_PATH` into memory; that path is gated by the G2
resource-headroom check (`MEMORY_LIMIT_MIB`, default 1024). A projected
heap above 70% of the limit fails the boot. `ALLOW_SNAPSHOT_OVERLAY=1`
re-enables legacy `LayeredStorage` (explicit opt-in; still headroom-gated).

Regenerate the snapshot artifact (offline, not at Cloud Run boot):

```bash
# from repo root; --use-system-ca routes around the local TLS-MITM proxy
NODE_OPTIONS=--use-system-ca LEGACY_DATABASE_URL=<neon-url> \
  pnpm --filter @hauska-engine/migrate-legacy-codes exec \
  tsx src/index.ts build-corpus-snapshot \
  --out P:/hauska-engine/services/retrieval-api/corpus/snapshot.json
```

Each jurisdiction ingests in an isolated storage and is evaluated
against its curated-query set; drifted live sources that return zero
sections are skipped (logged for B.5 drift follow-up) rather than
failing the build. Commit the regenerated `snapshot.json`, then reload
into Postgres with `load-snapshot-into-pg.mjs`.

## Phase 1a StoragePort (Gate A / master WDLL 3.1) — superseded for prod boot

Phase 1a landed `PgStorage` + `LayeredStorage`. F1 Phase 0 retires the
snapshot half of the overlay for production: when
`SUBSTRATE_DATABASE_URL` is set, retrieval-api serves `PgStorage` only.

### 1. Apply migration 005 (operator — substrate Neon)

```bash
DATABASE_URL='postgres://...neon.tech/...?sslmode=require' \
  node packages/storage/scripts/apply-migration.mjs
```

### 2. Write the proof atom (operator)

```bash
DATABASE_URL='postgres://...neon.tech/...?sslmode=require' \
  pnpm exec tsx packages/storage/scripts/write-storage-port-proof.mjs
```

Proof atom:
- entityId: `storage-port-proof/phase-1a`
- DID: `did:hauska:code-section:storage-port-proof/phase-1a`
- search token: `storage-port-proof`

This code-section is intentionally absent from `snapshot.json`.

### 3. Deploy with substrate URL wired

```bash
gcloud run deploy hauska-retrieval-api \
  --source . \
  --project=hauska-prod-497015 \
  --region=us-central1 \
  --allow-unauthenticated \
  --port=8080 \
  --memory=1Gi \
  --cpu=1 \
  --set-env-vars=RETRIEVAL_API_KEY=<key>,CORPUS_SNAPSHOT_PATH=services/retrieval-api/corpus/snapshot.json \
  --set-secrets=SUBSTRATE_DATABASE_URL=substrate-database-url:latest
```

## Auth

`Authorization: Bearer <RETRIEVAL_API_KEY>` is required on every route
except `/health`, `/healthz`, and `/ready`. The service is deployed
`--allow-unauthenticated` at the Cloud Run ingress layer (so the MCP
server can reach it over public TLS without GCP IAM tokens); the Bearer
key is the access gate. This keeps the retrieval-api the internal data
plane — the Hauska MCP Server is the public control plane and performs
ADR-017 access-policy filtering before results reach an end user. The
snapshot includes `platform-internal` jurisdictions, so the key gate is
load-bearing: it is what stops the open internet from reading
non-partnered jurisdictions' atoms.

`RETRIEVAL_API_KEY` is held in `doc_repo/Secrets.txt`, not committed to
this repo.

## Deploy

```bash
gcloud run deploy hauska-retrieval-api \
  --source . \
  --project=hauska-prod-497015 \
  --region=us-central1 \
  --allow-unauthenticated \
  --port=8080 \
  --memory=1Gi \
  --cpu=1 \
  --set-env-vars=RETRIEVAL_API_KEY=<key>
```

`--source .` builds the repo-root `Dockerfile` via Cloud Build. The
image runs the service with `tsx` (no tsc step — workspace packages
ship source-direct exports per `REPO_NOTES.md`).

## Verify

Replace `<service-url>` with the Cloud Run URL and `<key>` with `RETRIEVAL_API_KEY`.

```bash
curl -s https://<service-url>/health
curl -s https://<service-url>/healthz/
curl -s -H "Authorization: Bearer <key>" \
  "https://<service-url>/jurisdictions?qualityBarOnly=true"
curl -s -H "Authorization: Bearer <key>" \
  "https://<service-url>/search?q=setback&limit=3"
```

### Gate A live verify (master WDLL 3.1)

After migration + proof write + redeploy with `SUBSTRATE_DATABASE_URL`:

```bash
# 200 with body NOT in snapshot.json
curl -s -H "Authorization: Bearer <key>" \
  "https://<service-url>/atoms/did:hauska:code-section:storage-port-proof/phase-1a"

# ideally finds the proof atom
curl -s -H "Authorization: Bearer <key>" \
  "https://<service-url>/search?q=storage-port-proof&limit=5"

# corpus still > 0; db up when substrate URL wired
curl -s https://<service-url>/healthz/
```

### Gate C property atom chain (master WDLL / Phase 1c)

Writers bake under `PROPERTY_ATOM_PATH=1`. The read path
`GET /property-nodes/:parcelNodeId/atom-chain` is always-on against
StoragePort (empty slots when no atoms). Do not flip cortex live
envelope dual-serve from this flag; property-explorer is untouched.

```bash
# bake proof atoms into hauska_mcp Neon
PROPERTY_ATOM_PATH=1 DATABASE_URL='postgres://.../hauska_mcp?sslmode=require' \
  pnpm exec tsx packages/storage/scripts/write-property-atom-proof.mjs

# Hays gold chain (zoning + setback + envelope)
curl -s -H "Authorization: Bearer <key>" \
  "https://<service-url>/property-nodes/48209:156346/atom-chain"

# Bexar honest-absence zoning (absence.kind=no-zoning-stamp, not I-2)
curl -s -H "Authorization: Bearer <key>" \
  "https://<service-url>/property-nodes/48029:410119/atom-chain"

curl -s -H "Authorization: Bearer <key>" \
  "https://<service-url>/atoms/did:hauska:zoning-fact:48209:156346"
```

### Gate C I-E — calibration overlay read-through (Master WDLL 3.10)

`calibratedConfidence` resolves at **READ** via cortex Neon migration
`0037` table `atom_calibration_overlay` (same host as
`DEPLOYMENT_DATABASE_URL` / secret `CORTEX_DATABASE_URL` → database
`neondb`). Substrate `hauska_mcp` does **not** host this table.

Wire at deploy:

```bash
--set-secrets=SUBSTRATE_DATABASE_URL=DATABASE_URL:latest,OVERLAY_DATABASE_URL=CORTEX_DATABASE_URL:latest
```

Env resolution order: `OVERLAY_DATABASE_URL` → `CORTEX_DATABASE_URL` →
`DEPLOYMENT_DATABASE_URL`.

Seed Hays gold parcel overlay (estimate `0.71`, provenance `backtest`,
keyed on parcel node `48209:156346` / tenant `hays_tx_proof`):

```bash
OVERLAY_DATABASE_URL='postgres://...neon.tech/neondb?sslmode=require' \
  node packages/storage/scripts/seed-calibration-overlay-hays.mjs
```

**Prefer adapter fuel (Master WDLL 3.10):** Austin SODA permit outcomes
write `finding.outcome.recorded` ledger rows and upsert overlay with
`code_ref` `permit-outcome-adapter:austin-soda:…` (replaces hand-seed
provenance when run with `--write`):

```bash
OVERLAY_DATABASE_URL='postgres://...neon.tech/neondb?sslmode=require' \
  pnpm --filter @hauska-engine/permit-outcome-cli dev run -- \
    --limit 25 --write --also-austin-overlay
```

`bastrop_tx` / `grand_county_ut` grade PARTIAL (no public bulk feed
without secrets). See `tools/permit-outcome-cli/README.md`.

Proof curl (calibrated axis ≠ asserted 0.88):

```bash
curl -s -H "Authorization: Bearer <key>" \
  "https://<service-url>/property-nodes/48209:156346/atom-chain" \
  | jq '.buildableEnvelope.readContract.axes'
```

## Health (`GET /healthz`)

Observability surface per [`76e_platform_observability_sprint`](../../doc_repo/76e_platform_observability_sprint.md). Returns `{status, db, corpus}`:

- **`corpus`** — atom count from the loaded snapshot (`storage.countAtoms()`). Zero count → HTTP 503 / `status: fail`.
- **`db`** — substrate Neon liveness via `SELECT 1` when `SUBSTRATE_DATABASE_URL` (or `DATABASE_URL`) is set. When unset, `db.status` is `not_configured` and overall status is `warn` (snapshot-only mode).

**Cloud Run note:** Google Front End reserves exact `/healthz` (no trailing slash) and returns a platform 404 before the request reaches the container. Use **`/healthz/`** (trailing slash) for uptime checks and hub polling on Cloud Run; the handler and signal emit are identical.

Wire the substrate Neon URL at deploy time when the Postgres-backed storage back-end lands:

```bash
--set-secrets=SUBSTRATE_DATABASE_URL=substrate-database-url:latest
```

Each `/healthz` call emits one structured Cloud Logging line (`hauska_health=true`, `check: healthz`, `service: hauska-retrieval-api`) for the cc-agent-C health-watch hub.

## Spine health board (`GET /health/spine`)

COMPLETE-BASTROP B1 (S-03): source+engine liveness probes for the Bastrop pack. Process `/health` and `/healthz` are unchanged; spine health is additive.

- **`GET /health`** — still `{status, service, startedAt}` plus `links.spineHealth` / `links.spineHealthRun`.
- **`GET /health/spine`** — latest persisted `spine_health_probe` summary (`pack`, `alertCount`, `probes[]` with `firing|degraded|degraded-covered|dead|dead-expected`).
- **`GET|POST /health/spine/run`** — run the Bastrop pack now (ArcGIS / Overpass / txgio / tier1 / boundary / depth-warm / setback / atom-chain) and persist rows.

Apply migration once on substrate Neon:

```bash
DATABASE_URL='postgres://.../hauska_mcp?sslmode=require' \
  pnpm --filter @hauska-engine/retrieval-api run apply-spine-health-migration
```

Offline pack run (needs substrate + cortex overlay URL for txgio / place_layer_snapshots):

```bash
DATABASE_URL='postgres://.../hauska_mcp?sslmode=require' \
CORTEX_DATABASE_URL='postgres://.../neondb?sslmode=require' \
  pnpm --filter @hauska-engine/retrieval-api run run-bastrop-spine-health
```

Alert rule: current zero/error with baseline>0 → `status=dead` + `alert=true` (never silent). `bastrop-tx:zoning` is `dead-expected` (no alert); replacement is `zoning-agol:bastrop-city-tx`.
