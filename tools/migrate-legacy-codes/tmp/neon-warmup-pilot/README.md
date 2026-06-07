# PB-001 Neon warmup pilot JSONL

Pre-exported `code_atoms` rows for cortex-api Postgres load. Regenerate from the committed corpus snapshot:

```powershell
pnpm --filter @hauska-engine/migrate-legacy-codes exec tsx src/index.ts export-neon-warmup-pilot-batch
```

Operator load: `services/retrieval-api/docs/ldt-neon-warmup-runbook.md`
