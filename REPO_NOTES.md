# hauska-engine repo notes

Operational notes for cc-agent-E and successor engineering sessions.

## Toolchain

- **Node**: 20+ required (CI: Node 22; local box: Node 24).
- **pnpm**: 10.27+ required (locked via `packageManager` field). Workspace layout in [`pnpm-workspace.yaml`](pnpm-workspace.yaml).
- **TypeScript**: 5.7.x. Project-wide config in [`tsconfig.base.json`](tsconfig.base.json). Source-direct package exports (`./src/<module>.ts`) + Bundler module resolution mean we do **not** run `tsc -b` — every package does `tsc --noEmit` for typecheck and ships source via the `exports` map. Production deploys (Cloud Run) use `tsx` or a separate bundle step at deploy time.
- **Vitest**: 2.1.x. Each package runs `vitest run --passWithNoTests` so packages without tests stay green in `pnpm -r test`.

## Local install on Windows

If you hit `UNABLE_TO_VERIFY_LEAF_SIGNATURE` against `registry.npmjs.org`:

```powershell
$env:NODE_OPTIONS = "--use-system-ca"
pnpm install
```

The Windows certificate store carries the corporate CA that pnpm's bundled certs miss. `NODE_OPTIONS=--use-system-ca` reads the OS trust store. CI is fine without this (Linux runners use the system CA by default).

## Sync points (within-track, owned by cc-agent-E)

The within-track sync points listed in [`_dispatches/2026-05-18_cc-agent-E_hauska_engine.md`](https://github.com/empressaioemail-tech/doc_repo/blob/main/_dispatches/2026-05-18_cc-agent-E_hauska_engine.md) are self-coordinated here:

### Sync 2 — Adapter contract stable (READY)

Adapter interface locked at [`packages/corpus/src/adapters/types.ts`](packages/corpus/src/adapters/types.ts). The contract:

- `CodeSourceAdapter` interface with `discover()`, `fetch()`, `metadata()`, `normalize()`
- `NormalizedBlock` typed union (heading / paragraph / definition / cross-reference / table / figure / note / amendment-record)
- `NormalizedCode` carries metadata + ordered block stream
- `AdapterCapabilities` descriptor (name, sourceFamilies, supportsDiscovery, supportsAmendments)

Conformance suite at [`packages/corpus/src/adapters/__fixtures__/conformance.ts`](packages/corpus/src/adapters/__fixtures__/conformance.ts). Every adapter runs the same suite against a captured fixture; Municode adapter conformance test at [`packages/corpus/src/adapters/municode/__tests__/conformance.test.ts`](packages/corpus/src/adapters/municode/__tests__/conformance.test.ts) is the reference.

Stream 1B hard-wired to adapter output; Stream 1D writes eval against atomized output of any adapter.

### Sync 3 — Retrieval API contract stable (READY)

HTTP service contract locked at [`services/retrieval-api/src/server.ts`](services/retrieval-api/src/server.ts) with contract tests at [`services/retrieval-api/src/__tests__/contract.test.ts`](services/retrieval-api/src/__tests__/contract.test.ts):

- `GET /search?q=&jurisdiction=&entityType=&limit=`
- `GET /atoms/:did?includeComposition=true`
- `GET /jurisdictions[?qualityBarOnly=true]`
- `GET /jurisdictions/:id[?queryType=permits|summary]`
- `GET /jurisdictions/:id/permits?projectType=` (the renamed `search_permit_atoms` target)
- `GET /health`, `GET /ready`

Auth: `Authorization: Bearer ${RETRIEVAL_API_KEY}` (env var). Empty key disables the middleware for dev. P99 latency contract: ≤500ms index, ≤2s when IPFS fetch needed.

cc-agent-M's Stream 2A in [`hauska-mcp-server`](https://github.com/empressaioemail-tech/hauska-mcp-server) consumes this contract — swap from mocked client to real wiring on Sync 3 signal.

### Sync 4 — First jurisdiction passes eval (PENDING)

Pre-launch gate. Bastrop UDC pipeline run produces an atomized corpus that passes the eval-harness quality bar (90% top-3 / 100% section-num / 95% cross-ref). The Stream 1D B.6 Bastrop validation pass is the trigger.

### Sync 5 — 20-jurisdiction corpus (PENDING)

Public launch gate. 20 TX jurisdictions pass eval. Planner co-owns the public launch announcement per [`50_hauska_mcp_server.md`](https://github.com/empressaioemail-tech/doc_repo/blob/main/50_hauska_mcp_server.md) §Phase 7.

## Sync points consumed

- **Sync 1** — `@hauska/atom-contract@1.0.0` published to npm (cc-agent-AC owns). Until then, [`packages/atom-contract-pin`](packages/atom-contract-pin) shims the contract surface. On Sync 1 signal, its [`src/index.ts`](packages/atom-contract-pin/src/index.ts) flips from local source to `export * from "@hauska/atom-contract"` and `package.json` adds the npm dep.
- **Sync 6** — Texas IP attorney opinion memo delivered (Nick action, external). Gates Tier 1+2+3 batch ingest per [`51_substrate_v1_sprint.md`](https://github.com/empressaioemail-tech/doc_repo/blob/main/51_substrate_v1_sprint.md) §Sync-points table. Bastrop and Grand County stay unblocked.

## Structural commitment #3 — cost per jurisdiction

Per CLAUDE.md: **under $200 compute + 1 hour human review per new jurisdiction; hard kill at three counties.**

Operationalized in [`packages/corpus/src/cost-tracking/`](packages/corpus/src/cost-tracking/) and exposed via [`tools/ingest-cli`](tools/ingest-cli):

- `ingest-cli review-start <jurisdiction>` / `review-end <jurisdiction>` — captures human-review-minutes.
- `ingest-cli cost-record <jurisdiction> --llm --ocr --embed --infra` — captures compute cents.
- `ingest-cli cost-report [--jurisdiction]` — per-jurisdiction breakdown vs target.
- `ingest-cli evaluate-hard-kill` — runs the 3-county checkpoint; exits non-zero if tripped.

Tests at [`packages/corpus/src/cost-tracking/__tests__/hard-kill.test.ts`](packages/corpus/src/cost-tracking/__tests__/hard-kill.test.ts).

## What's stubbed vs. wired

- **Storage**: in-memory implementation ([`packages/storage/src/in-memory-storage.ts`](packages/storage/src/in-memory-storage.ts)) satisfies the `StoragePort` for tests + the retrieval-api dev mode. Postgres-backed implementation (Drizzle schema already in [`packages/storage/src/schema.ts`](packages/storage/src/schema.ts)) lands in the storage-migration sprint.
- **IPFS**: in-process pin ([`InProcessIpfsPin`](packages/storage/src/in-process-cache.ts)) for dev. Default provider deferred per ADR-010 §Open-decisions; the [`IpfsPort`](packages/storage/src/ipfs-port.ts) abstraction lets us swap Pinata / Filebase / Google Cloud / Hauska cluster without rewriting consumers.
- **Identity**: in-memory DID→CID resolver ([`packages/identity/src/index.ts`](packages/identity/src/index.ts)). IPNS substrate deferred per ADR-011 §Open-for-refinement.
- **Vector embeddings**: `atom_embeddings` table declared in schema (pgvector landing target). No embedder is yet wired. Recommended: voyage-3-large per dispatch.
- **OCR for raw-PDF**: deferred per Phase 0 (Claude vision primary, Tesseract fallback). [`RawPdfAdapter`](packages/corpus/src/adapters/raw-pdf/index.ts) carries the contract; OCR integration lands when first raw-PDF jurisdiction is named.

## What's deferred to follow-on sessions

- Real Postgres-backed `StoragePort` + drift-detection cron + migration scripts
- Real IPFS pinning provider wiring (Pinata MVP)
- Claude vision OCR integration for raw-PDF adapter
- pgvector + voyage embeddings pipeline
- Municode discovery URL update (current selector may be brittle against the live source)
- First-city test: capture a real Municode TOC fixture from one non-Bastrop TX city + replace the inline test fixture
- Bastrop B.6 validation pass + Grand County IRC
- Tier 1 batch ingest (Sync 6 gate)
- Coverage-dashboard UI surface (data already aggregated through `StoragePort.listJurisdictionStatus`)
- LLM-generation hook for curated queries (provider plug-in point at [`packages/corpus/src/curated-queries/index.ts`](packages/corpus/src/curated-queries/index.ts))

## Reading the sprint plan

Canonical references (in [`doc_repo`](../doc_repo) sibling directory):

- [`51_substrate_v1_sprint.md`](../doc_repo/51_substrate_v1_sprint.md) — sprint plan
- [`49_code_ingestion_pipeline.md`](../doc_repo/49_code_ingestion_pipeline.md) — pipeline design
- [`80_adrs/adr_001_atom_architecture.md`](../doc_repo/80_adrs/adr_001_atom_architecture.md) — atom contract
- [`80_adrs/adr_010_atom_graph_traversal.md`](../doc_repo/80_adrs/adr_010_atom_graph_traversal.md) — IPFS + Postgres + hybrid retrieval
- [`80_adrs/adr_011_atom_identity_across_versions.md`](../doc_repo/80_adrs/adr_011_atom_identity_across_versions.md) — DID + IPNS
- [`80_adrs/adr_018_atom_contract_substrate_layer.md`](../doc_repo/80_adrs/adr_018_atom_contract_substrate_layer.md) — substrate placement
- [`_dispatches/2026-05-18_cc-agent-E_hauska_engine.md`](../doc_repo/_dispatches/2026-05-18_cc-agent-E_hauska_engine.md) — this repo's dispatch
