# Gate-front seam contract (engine-api)

> **Status:** scaffold / documented only (sprint 56, step 1). No live MCP
> consumer wired yet. Implements the seam decision in
> `_decisions/2026-06-07_adr008_gate_front_seam_scoping.md` and step 1 of
> `56_engine_extraction_sprint.md`.

## Purpose

`engine-api` is the gate-fronted reasoning tier. **Only** `hauska-mcp-server`
(the MCP gate) calls it in production. The gate resolves product, tenant,
package, and access tier; `engine-api` **trusts** that resolution and does not
re-derive tenant scope from raw user credentials.

`retrieval-api` remains a separate, read-only atom fetch path. Reasoning calls
flow: **product app → gate → engine-api**.

## Transport

| Layer | Contract |
|-------|----------|
| Base URL | `https://<engine-api-host>` (Cloud Run, post-deploy) |
| Health | `GET /health`, `GET /ready` — no auth |
| Reasoning (future) | `GET/POST /v1/...` — gate auth required |
| Service auth | `Authorization: Bearer <ENGINE_API_GATE_TOKEN>` |

The bearer token is a shared secret between the gate and `engine-api`
(defense-in-depth behind Cloud Run identity). Empty token disables the check
(local dev).

## Gate-front context headers

After service auth, the gate **must** send:

| Header | Required | Description |
|--------|----------|-------------|
| `X-Hauska-Product` | yes | Calling product: `cortex`, `codex`, `smartcity`, `brief-extension`, `revit-addin` |
| `X-Hauska-Tenant-Id` | yes | Tenant partition (ADR-005 Layer A) |
| `X-Hauska-Package-Id` | yes | Authorized capability package (e.g. `plan-review`, `site-context`) |
| `X-Hauska-Access-Tier` | yes | `public-free`, `public-paid`, `platform-internal`, `tenant-private` |
| `X-Hauska-Gate-Credential-Id` | yes | Gate credential id for audit (not the raw secret) |
| `X-Hauska-Request-Id` | yes | Cross-service provenance id |
| `X-Hauska-Subject-Id` | no | End-user subject when the gate proxied a user session |

Types: `services/engine-api/src/gate-front-context.ts`.

## Trust boundary

```
  Product app                MCP gate                    engine-api
  ───────────                ────────                    ──────────
  user/session  ──►  resolve tenant + package + tier
                     meter + enforce accessPolicy
                     ──────────────────────────────►  trust headers
                                                     scope all reads/writes
                                                     to gateFront.tenantId
```

engine-api **must not** accept direct calls from product apps during
transition or end state. cortex-api thins to a BFF; reasoning moves here.

## Scaffold behavior (this PR)

- `/health` and `/ready` respond without gate context.
- All other routes require bearer token + valid gate-front headers.
- `/v1/*` returns `501 not_implemented` with echoed `gateFront` (proves
  middleware) until engine-core routes land.

## Counterparties

| Repo | Role |
|------|------|
| `hauska-mcp-server` | Emit gate-front headers + bearer on engine calls |
| `legacy-design-tools` (cortex-api) | Thin to BFF; stop calling engines in-process |
| `hauska-engine` | This service + `packages/engine-core` + `packages/adapters` |

## References

- ADR-008 — engine factor-out layout
- ADR-005 — multitenancy (tenant partition)
- ADR-017 — accessPolicy / access tiers
- `56_engine_extraction_sprint.md` — lift sequence (steps 3–6 gated on M-Stabilize 2C)
