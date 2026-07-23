# retrieval-api — Cloud Run deploy

The Stream 1C retrieval API, deployed publicly so the Hauska MCP Server's
catalog tools have a stable read-only endpoint (Lane E Phase E0).

## Where it runs

- **Project:** `hauska-prod-497015` — production Hauska data plane
  (retrieval-api, MCP server). The interim `legacy-design-tools-prod`
  deploy was torn down 2026-05-21; do not target that project.
- **Region:** `us-central1` (matches the sibling services).
- **Service name:** `hauska-retrieval-api`.

## How corpus gets in

The production service is read-only and the v1 catalog is small enough
to hold in memory, so it does **not** run the live ingest pipeline on a
cold start. It boots an `InMemoryStorage` hydrated from a committed
snapshot artifact at `services/retrieval-api/corpus/snapshot.json`
(`CORPUS_SNAPSHOT_PATH`).

Regenerate the snapshot by re-running every onboarded jurisdiction's
ingest + eval:

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
failing the build. Commit the regenerated `snapshot.json`.

## Phase 1a StoragePort overlay (Gate A / master WDLL 3.1)

When `SUBSTRATE_DATABASE_URL` is set at boot, retrieval-api wraps the
snapshot in `LayeredStorage`: Postgres-first `getAtomByDid`, merged
search, snapshot-backed `/healthz` corpus count preserved.

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
