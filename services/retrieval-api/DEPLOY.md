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

When the Postgres-backed `StoragePort` lands, the service swaps to it
behind the same `buildApp({ storage })` seam and the snapshot becomes a
dev/test convenience.

## Auth

`Authorization: Bearer <RETRIEVAL_API_KEY>` is required on every route
except `/health` and `/ready`. The service is deployed
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

```bash
curl -s https://<service-url>/health
curl -s -H "Authorization: Bearer <key>" \
  "https://<service-url>/jurisdictions?qualityBarOnly=true"
curl -s -H "Authorization: Bearer <key>" \
  "https://<service-url>/search?q=setback&limit=3"
```
