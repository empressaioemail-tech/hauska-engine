# permit-outcome-cli (Master WDLL 3.10)

Fetch Texas public-record permit outcomes, append `finding.outcome.recorded`
rows to cortex Neon `atom_events`, and upsert `atom_calibration_overlay`
with `atom_class = backtest`.

## Sources

| Source | Jurisdiction | Status |
|---|---|---|
| `austin-soda` | `austin_tx` | Live — City of Austin SODA `3syk-w9eu` (no API key) |
| `bastrop-mygov` | `bastrop_tx` | PARTIAL — MyGov Address Lookup only; partner export 401 |
| `grand-county-ut` | `grand_county_ut` | PARTIAL — no verified public bulk permit endpoint |

Outcome payload shape matches LDT `findingOutcomeObservation.ts`
(`outcomeKind`, `observedAt`, `jurisdictionTenant`, …) plus adapter
provenance fields (`provenance: backtest`, `sourceId`, `recordHash`).

## Usage

```bash
# Dry-run (network only)
pnpm --filter @hauska-engine/permit-outcome-cli dev run -- --limit 25

# Write ledger + overlay (cortex Neon)
OVERLAY_DATABASE_URL='postgres://...neon.tech/neondb?sslmode=require' \
  pnpm --filter @hauska-engine/permit-outcome-cli dev run -- \
    --limit 25 --write --also-austin-overlay
```

Default overlay target is the Hays gold parcel (`48209:156346` /
`hays_tx_proof`) so retrieval `00015-*` can prove calibrated
`provenance: backtest` with `code_ref` citing the adapter (not the
Gate C hand seed).
