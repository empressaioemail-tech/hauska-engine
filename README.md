# hauska-engine

Hauska Engine — the code-ingestion pipeline, atom substrate, and retrieval API that powers the public Hauska MCP Server.

This repo executes Track 1 of the substrate v1 sprint per [`51_substrate_v1_sprint.md`](https://github.com/empressaioemail-tech/doc_repo/blob/main/51_substrate_v1_sprint.md) — streams 1A (adapters + pipeline runner), 1B (structural extraction + atomization), 1C (storage + index + identity + retrieval API), and 1D (eval + curated queries + batch ingest + coverage). Track 2 (MCP server) lives in [`hauska-mcp-server`](https://github.com/empressaioemail-tech/hauska-mcp-server); the atom contract lives in [`hauska-atom-contract`](https://github.com/empressaioemail-tech/hauska-atom-contract).

## Layout

```
hauska-engine/
├── packages/
│   ├── atom-contract-pin/    # Pre-Sync-1 shim; flips to @hauska/atom-contract on Sync 1
│   ├── atoms/                # Engine-side atom-instance registry (Stream 1B)
│   ├── corpus/               # Adapters, extraction, atomization, eval (Streams 1A/1B/1D)
│   ├── identity/             # DID + IPNS (Stream 1C)
│   ├── retrieval/            # Hybrid retrieval query layer (Stream 1C)
│   └── storage/              # IPFS + Postgres index (Stream 1C)
├── services/
│   ├── pipeline-runner/      # Cloud Run orchestrator (Stream 1A)
│   └── retrieval-api/        # HTTP service consumed by hauska-mcp-server (Stream 1C)
└── tools/
    └── ingest-cli/           # Operator CLI (Stream 1D)
```

## Sync points

- **Sync 1** (consumed) — `@hauska/atom-contract@1.0.0` published to npm by `hauska-atom-contract`. Until then, atom registrations target the local `@hauska-engine/atom-contract-pin` shim.
- **Sync 2** (this repo) — adapter interface in [`packages/corpus/src/adapters/types.ts`](packages/corpus/src/adapters/types.ts) stable + first-city conformance pass.
- **Sync 3** (this repo) — retrieval API contract in [`services/retrieval-api/`](services/retrieval-api/) stable + first health pass. Unblocks `hauska-mcp-server` Stream 2A real wiring.
- **Sync 4** (this repo) — first jurisdiction (Bastrop UDC) passes the eval quality bar. Pre-launch gate.
- **Sync 5** (this repo) — 20 TX jurisdictions pass eval. Public launch gate.
- **Sync 6** (consumed) — Texas IP attorney opinion memo delivered (Nick action). Gates Tier 1+2+3 batch ingest; Bastrop and Grand County stay unblocked.

## Structural commitments

This repo carries operational responsibility for commitment #3: **cost per jurisdiction onboarded under $200 compute + 1 hour human review, hard kill at three counties if not achievable.** Cost-per-jurisdiction tracking lives in Stream 1D (`packages/corpus/src/eval/` + `tools/ingest-cli/`); the 3-county hard-kill checkpoint is enforced in code.

## Develop

```
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Quality bar

A jurisdiction is marked "loaded" only when the eval harness passes:

- 90% top-3 retrieval on curated queries
- 100% section-number retrievability
- 95% cross-reference resolution

(Per [`49_code_ingestion_pipeline.md`](https://github.com/empressaioemail-tech/doc_repo/blob/main/49_code_ingestion_pipeline.md) §B.4; recalibration check after batch-10 per Phase 0.)
