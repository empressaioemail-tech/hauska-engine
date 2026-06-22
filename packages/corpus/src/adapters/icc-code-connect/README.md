# ICC Code Connect adapter — live-ingestion runbook

Layer 1 model-code base ingest via ICC's commercial Code Connect OAuth2 JSON
API (ADR-019). The adapter, client, fixtures, and model-code extractor are
built ahead of credentials so the PoC demo can dry-run on fixtures now and
switch to live ingest when access lands.

## PoC demo scope (fixture dry-run)

| Edition | `titleId` | Fixture |
|---------|-----------|---------|
| 2018 International Building Code | `IBC2018` | `__fixtures__/ibc-2018.ts` |
| 2018 International Property Maintenance Code | `IPMC2018` | `__fixtures__/ipmc-2018.ts` |

Fixtures are **hand-built** from the assumed `@assumption` contract in
`code-connect-client.ts`. Reconcile against captured Code Connect payloads
when credentials and the OpenAPI spec arrive.

### Dry-run the full path (no credentials)

```bash
# From repo root
pnpm --filter @hauska-engine/migrate-legacy-codes dev icc-model-code-ingest-fixtures

# Optional: run curated-query eval against the ingested fixture corpus
pnpm --filter @hauska-engine/migrate-legacy-codes dev icc-model-code-eval-fixtures
```

Pipeline: `discover()` → filter to `IBC2018` + `IPMC2018` → `fetch()` →
`normalize()` → `extractModelCodeAtoms()` → conformance stamp → storage.

## Isolated demo instance

| Field | Value |
|-------|-------|
| `jurisdictionTenant` | `icc-model-code` |
| `accessPolicy` | `platform-internal` |
| `sourceAdapter` | `icc-code-connect` |
| DID prefix | `did:hauska:<entityType>:icc-model-code/…` |

Formalized in `packages/corpus/src/model-code/demo-instance.ts`.

### Access controls

- **ADR-017 tier:** `platform-internal` — ICC-derived atoms are invisible to
  anonymous/public catalog surfaces (`list_jurisdictions` with
  `accessPolicies: ["public-free"]` excludes this partition).
- **Gate requirement:** callers must present
  `X-Hauska-Access-Tier: platform-internal` to read or meter usage against
  ICC atoms.
- **Layer-in-between guarantee:** `code-section.bodyText` carries only the
  reasoning layer; verbatim ICC normative text is deep-linked via
  `verbatimTextDeepLink`, never hosted.

### Designated-Administrator model

Platform operators holding designated-administrator gate credentials
(`platform-internal` tier) manage the PoC partition. City-tenant credentials
do not inherit access to `icc-model-code` atoms through the shared
model-code base until a production licensing decision promotes the access
tier.

Gate-side usage views scope ICC atoms with all three filters:

```ts
atom.jurisdictionTenant === "icc-model-code"
  && atom.sourceAdapter === "icc-code-connect"
  && atom.entityId.startsWith("icc-model-code/")
```

Helpers: `isIccModelCodeAtom()`, `isIccModelCodeAtomDid()` in
`demo-instance.ts`.

## Going live

### Prerequisites

1. ICC Code Connect OAuth2 credentials (client id + secret).
2. ICC OpenAPI / Swagger spec and example payloads from the operator meeting.
3. Storage back-end wired (Postgres + IPFS for production; `InMemoryStorage`
   for local verification).

### Environment

```bash
export ICC_CODE_CONNECT_CLIENT_ID="<from ICC dev portal>"
export ICC_CODE_CONNECT_CLIENT_SECRET="<from ICC dev portal>"

# Optional overrides (defaults in code-connect-client.ts)
# export ICC_CODE_CONNECT_TOKEN_URL="https://api.iccsafe.org/oauth2/token"
# export ICC_CODE_CONNECT_BASE_URL="https://api.iccsafe.org/codeconnect/v1"
```

**Never commit credentials.** Use your secret manager / CI vault.

### Reconcile the assumed contract

Before first live ingest, reconcile every `@assumption` in
`code-connect-client.ts` against ICC's real OpenAPI spec. The nine
high-value fields to confirm first:

| # | `@assumption` | Current guess |
|---|---------------|---------------|
| 1 | OAuth token response shape | RFC 6749 `{ access_token, token_type, expires_in }` |
| 2 | Title field names | `titleId`, `codeAbbrev`, `name`, `year`, `versionStatus` |
| 3 | Chapter/section fan-out | Lightweight section refs; bodies fetched per-section |
| 4 | Content node union | Discriminated `kind`: `prose` / `table` / `figure` |
| 5 | Defined terms | Structurally tagged in Definitions chapters |
| 6 | Section cross-references | Inline prose only (adapter parses) |
| 7 | Per-section `viewerUrl` | Optional deep-link from Code Connect |
| 8 | Token endpoint path | `POST /oauth2/token`, client-credentials in body |
| 9 | API base + routes | `GET /titles`, `/titles/{id}/chapters`, `/titles/{id}/sections/{id}`, `/search`, `/codes/{abbrev}/versions` |

Replace hand-built fixtures with captured payloads and update tests.

### Live ingest procedure

```bash
# 1. Verify credentials resolve to live mode
pnpm --filter @hauska-engine/migrate-legacy-codes dev icc-model-code-credential-pending

# 2. Ingest 2018 IBC + 2018 IPMC (live API)
pnpm --filter @hauska-engine/migrate-legacy-codes dev icc-model-code-ingest-live

# 3. Run eval rubric
pnpm --filter @hauska-engine/migrate-legacy-codes dev icc-model-code-eval-live
```

Under the hood:

1. `new IccCodeConnectAdapter()` — credentials from env select **live** mode.
2. `discover()` — list all I-Code editions Code Connect carries.
3. Filter to `IBC2018` + `IPMC2018` (PoC demo scope).
4. For each edition: `fetch()` → `extractModelCodeAtoms()` → stamp with
   `platform-internal` accessPolicy → `storage.writeAtoms()`.
5. `upsertJurisdictionStatus()` for tenant `icc-model-code`.

### Asserted-confidence baseline

Source adapter `icc-code-connect` carries an asserted-confidence estimate of
**0.78** in `packages/corpus/src/conformance/mint.ts` (`SOURCE_ADAPTER_BASELINE`).

## Wind-down (teardown)

The PoC partition is isolated under `icc-model-code`. Nothing in production
city tenants depends on it. To tear down:

1. **Delete the partition** — remove all atoms where
   `jurisdiction_tenant = 'icc-model-code'` from Postgres and unpin the
   corresponding IPFS CIDs.
2. **Drop jurisdiction status** — delete the `jurisdiction_status` row for
   `icc-model-code`.
3. **Revoke credentials** — rotate or delete `ICC_CODE_CONNECT_CLIENT_SECRET`
   in the secret manager.
4. **Verify** — confirm `list_jurisdictions` and atom search return no
   `icc-model-code` results.

After wind-down, city-jurisdiction ingest paths are unaffected.

## Tests

```bash
pnpm --filter @hauska-engine/corpus test
```

Conformance + content suites run in **mock** mode (fixtures, no network).
OAuth2 client-credentials flow is exercised with a stubbed transport.
