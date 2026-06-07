# LDT Neon warmup — PB-001 pilot batch

Load hauska-engine substrate `code-section` atoms into **cortex-api Postgres** `code_atoms` so Property Brief code retrieval (`BRIEF_CODE_RETRIEVAL=neon`) and `GET /api/brokerage/v1/coverage` can report warmed jurisdictions.

**Artifacts:** `tools/migrate-legacy-codes/tmp/neon-warmup-pilot/<jurisdiction_key>.jsonl`  
**Source snapshot:** `services/retrieval-api/corpus/snapshot.json` (`generatedAt` in file header)  
**Dispatch:** `doc_repo/_dispatches/2026-05-29_cc-agent-E_neon_warmup_pilot_batch.md`

## Prerequisites

| Requirement | Notes |
|-------------|--------|
| `DATABASE_URL` | **cortex-api** Postgres (staging first, then prod). Same DB as LDT Neon when brief runs on cortex-api. |
| `OPENAI_API_KEY` | Required for embedding backfill (optional for load-only smoke). |
| Corpus snapshot | Committed `snapshot.json` on the target hauska-engine SHA. Regenerate only when ingest changes. |
| LDT deploy | Coverage `tier: neon` + `atomCount` on `/coverage` may require `JURISDICTIONS` registration or PR #134 — see [Verify](#verify) below. |

## Source registry pattern

Each jurisdiction gets one `code_atom_sources` row:

| Column | Value |
|--------|--------|
| `source_name` | `{jurisdiction_key}_substrate` (e.g. `round_rock_tx_substrate`) |
| `source_type` | `substrate_export` |
| `license_type` | `platform-internal` |

Atoms use `code_book = SUBSTRATE` and `edition` = the snapshot `code-edition.editionLabel` for that city.

**Idempotency:** `content_hash` = LDT `sha256` over `jurisdiction_key`, `code_book`, `edition`, `section_number`, `body` (U+0001 joiner). Re-runs use `ON CONFLICT (content_hash) DO NOTHING`.

## 1 — Regenerate JSONL (optional)

From hauska-engine repo root:

```powershell
cd P:\hauska-engine

pnpm --filter @hauska-engine/migrate-legacy-codes exec tsx src/index.ts export-neon-warmup-pilot-batch
```

Single key:

```powershell
pnpm --filter @hauska-engine/migrate-legacy-codes exec tsx src/index.ts export-snapshot-jurisdiction-legacy --jurisdiction round_rock_tx
```

Expected row counts (non-empty `bodyText` only):

| `jurisdiction_key` | JSONL rows |
|--------------------|------------|
| `round_rock_tx` | 276 |
| `georgetown_tx` | 571 |
| `new_braunfels_tx` | 170 |
| `leander_tx` | 156 |
| `hutto_tx` | 1376 |
| `austin_tx` | 1810 |

Verify line counts:

```powershell
pnpm --filter @hauska-engine/migrate-legacy-codes exec tsx src/index.ts verify-neon-warmup-jsonl --file tools/migrate-legacy-codes/tmp/neon-warmup-pilot/round_rock_tx.jsonl
```

## 2 — Load into cortex-api Postgres (staging first)

Set `DATABASE_URL` to the **staging** cortex-api database (not legacy ingest DB unless they are the same instance).

**Priority order:** `round_rock_tx` → `georgetown_tx` → `new_braunfels_tx` → `leander_tx` → `hutto_tx` → `austin_tx`

Dry-run (parse only):

```powershell
$env:DATABASE_URL = "<staging-cortex-postgres-url>"

pnpm --filter @hauska-engine/migrate-legacy-codes exec tsx src/index.ts load-neon-warmup-jsonl `
  --file tools/migrate-legacy-codes/tmp/neon-warmup-pilot/round_rock_tx.jsonl `
  --dry-run
```

Load:

```powershell
pnpm --filter @hauska-engine/migrate-legacy-codes exec tsx src/index.ts load-neon-warmup-jsonl `
  --file tools/migrate-legacy-codes/tmp/neon-warmup-pilot/round_rock_tx.jsonl
```

Repeat for each JSONL. CLI prints `{ inserted, skippedDuplicate, linesRead }`.

### SQL spot-check (optional)

```sql
SELECT jurisdiction_key, count(*) AS n,
       count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded
FROM code_atoms
WHERE jurisdiction_key = 'round_rock_tx'
GROUP BY 1;

SELECT source_name FROM code_atom_sources WHERE source_name = 'round_rock_tx_substrate';
```

## 3 — Embeddings backfill

Loaded rows have `embedding IS NULL` until backfill. Use cortex-api (api-server) with `OPENAI_API_KEY` set.

**Per jurisdiction** (repeat until `remaining` is 0):

```powershell
$base = "https://<staging-cortex-host>"   # e.g. cortex staging URL
$key  = $env:BROKERAGE_DEV_API_KEY        # or session cookie if using design-tools

# Optional: scope backfill — api-server backfills globally; filter in SQL first if needed.
while ($true) {
  $r = Invoke-RestMethod -Method POST -Uri "$base/api/codes/embeddings/backfill?limit=1000" `
    -Headers @{ "x-brokerage-api-key" = $key }
  Write-Host ($r | ConvertTo-Json -Compress)
  if ($r.remaining -eq 0) { break }
  Start-Sleep -Seconds 2
}
```

Or curl:

```bash
curl -sS -X POST "$CORTEX_BASE/api/codes/embeddings/backfill?limit=1000" \
  -H "x-brokerage-api-key: $BROKERAGE_DEV_API_KEY"
```

Re-run until `remaining: 0`. Large cities (`austin_tx`, `hutto_tx`) may need many iterations (1000 atoms per call, hard cap).

Confirm:

```sql
SELECT count(*) FILTER (WHERE embedding IS NULL) AS pending
FROM code_atoms WHERE jurisdiction_key = 'round_rock_tx';
```

## 4 — Verify

### Coverage API (after LDT/cortex deploy)

```powershell
Invoke-RestMethod "$base/api/brokerage/v1/coverage" -Headers @{ "x-brokerage-api-key" = $key }
```

**Target:** `round_rock_tx` (and each loaded key) shows `atomCount > 0`.

**Tier `neon`:** Today `getPilotCoverageTier` returns `neon` only for keys in `lib/codes/src/jurisdictions.ts` `JURISDICTIONS`. Substrate-only keys stay `engine_only` until LDT adds a `{key}_substrate` book entry or coverage logic checks atom count (PR #134). **Brief retrieval** still uses `countAtomsForJurisdiction` and works once rows exist.

### Brief smoke

```powershell
# Address in Round Rock — adjust payload per property_brief_cortex_deploy.md
Invoke-RestMethod -Method POST -Uri "$base/api/brokerage/v1/brief" `
  -Headers @{ "x-brokerage-api-key" = $key; "Content-Type" = "application/json" } `
  -Body '{"address":"1000 Legacy Dr, Round Rock, TX 78664"}'
```

Expect `corpusStatus: in_corpus` and non-empty `citations` when embeddings are present.

## Out of scope

- `dallas|tx` city proper (AmLegal partnership)
- New Municode ingest (PB-201)

## Related

- Deploy: `doc_repo/90_runbooks/property_brief_cortex_deploy.md`
- Coverage manifest: `doc_repo/75b_brief_coverage_v0.md`
- Registry export: `pnpm --filter @hauska-engine/migrate-legacy-codes exec tsx src/index.ts export-central-texas-coverage`
