# cc-agent-E close — EngineEnvelope gate-front seam (2026-06-16)

## PR #72 — MERGED

| Field | Value |
|-------|-------|
| PR | https://github.com/empressaioemail-tech/hauska-engine/pull/72 |
| Merge SHA | `9e75e54bb20343ce282bf326f003d528ff6a36ab` |
| Merged | 2026-06-16T14:31:19Z |
| CI | https://github.com/empressaioemail-tech/hauska-engine/actions/runs/27623651884 — **success** |

## Deploy state (0% canary — traffic NOT shifted)

| Service | Revision | Traffic | URL |
|---------|----------|---------|-----|
| **engine-api prod** | `hauska-engine-api-00004-xpl` | 100% | https://hauska-engine-api-h7gvu7rgcq-uc.a.run.app |
| **engine-api canary** | `hauska-engine-api-00006-lap` (tag `envelope-canary`) | **0%** | https://envelope-canary---hauska-engine-api-h7gvu7rgcq-uc.a.run.app |
| **retrieval-api** | `hauska-retrieval-api-00007-fsk` | 100% | https://hauska-retrieval-api-h7gvu7rgcq-uc.a.run.app |

Image: `us-central1-docker.pkg.dev/hauska-prod-497015/cloud-run-source-deploy/hauska-engine-api:envelope-canary`

Canary `/health`:
```json
{"status":"ok","service":"engine-api","adapters":true,"engineCore":true,"envelope":true,"startedAt":"2026-06-16T14:13:14.295Z"}
```

**Traffic shift: BLOCKED** — awaiting cc-agent-C explicit go after cortex-api canary confirms envelope passthrough (C PR #183 open, not merged/deployed).

---

## C reconciliation — `unwrapEngineEnvelope` vs E `schema.ts`

**C branch:** `cortex/engine-envelope-honesty` @ `5125d9f`  
**C PR:** https://github.com/empressaioemail-tech/legacy-design-tools/pull/183 (open)

Static field-path reconciliation — **MATCH**:

| E (`packages/engine-core/src/envelope/schema.ts`) | C (`lib/engine-core/src/envelope.ts` + `unwrapEngineEnvelope`) |
|---------------------------------------------------|------------------------------------------------------------------|
| `payload` | `payload` (via `isEngineEnvelopeShape`) |
| `confidence.value` (0–1) | `confidence.value` |
| `confidence.kind` (`calibrated\|asserted\|deterministic`) | same enum set |
| `dataVintage` (`string \| null`) | `parseDataVintage` — null or ISO string |
| `coverage.degraded` (`boolean`) | `coverage.degraded` |
| `coverage.reason?` (`string`) | optional `reason` |
| `source.adapter` (`string`) | `source.adapter` |
| `source.citationIds?` (`string[]`) | optional `citationIds` |

C's conservative fallback (bare legacy body) synthesizes `dataVintage: null`, `coverage.degraded: false` (non-mock) — **would mask field mismatches**. Static paths align; live canary-to-canary not yet run (C PR #183 not deployed).

**Verification plan for C:** point cortex-api canary `ENGINE_API_BASE_URL` at `envelope-canary` tag; run plan-review findings job; assert `finding_runs.engine_honesty` has non-null `confidence.kind`, `source.adapter` matching engine response (e.g. `finding-engine:anthropic`), and `dataVintage` = briefing-source snapshot date when present.

---

## Live canary smoke — all 9 surfaces (2026-06-16T14:34Z)

Base: `https://envelope-canary---hauska-engine-api-h7gvu7rgcq-uc.a.run.app`  
Script: `tools/canary-smoke.ps1`

| # | Surface | Result | `confidence.kind` | `coverage.degraded` | `dataVintage` |
|---|---------|--------|-------------------|---------------------|---------------|
| 1 | `POST /v1/findings/generate` | **PASS** | `asserted` | `false` | `2025-11-01` (Hays CAD snapshot) |
| 2 | `POST /v1/briefing/generate` | **PASS** | `asserted` | `false` | `2025-11-01` |
| 3 | `POST /v1/hydrology/rainfall-forcing` | **PASS** | `deterministic` | `false` | `2026-06-16T14:34:04.539Z` (fetch time) |
| 4 | `POST /v1/topography/contours` | **PASS** | `deterministic` | `false` | `null` (synthetic grid, no acquisition date) |
| 5 | `POST /v1/site-context/place` | **PASS** | `deterministic` | `false` | `null` (geocode, no layer snapshot) |
| 6 | `POST /v1/site-context/run-adapters` | **PASS** | `deterministic` | **`true`** | `2026-06-16T14:34:08.264Z` (latest ok adapter snapshot) |
| 7 | `POST /v1/encumbrances/query` | **PASS** | `asserted` | **`true`** | `null` (unconfigured adapter) |
| 8 | `POST /v1/chat/complete` | **PASS** | `asserted` | `false` | `null` |
| 9 | `POST /v1/hydrology/drainage` | **PASS** | `deterministic` | **`true`** | `null` (see drainage section) |

All responses Zod-valid per outbound middleware (`payload`, `confidence.kind`, `coverage.degraded`, `dataVintage` present).

---

## Drainage latency — before/after

| Scenario | Elapsed | Notes |
|----------|---------|-------|
| **Before** (audit, pysheds full DEM) | **~100s** | Request timeout risk on spine |
| **After** (native D8, 256×256 downsample, local bench) | **361ms** | CI/unit path |
| **Live canary** (San Marcos parcel, real DEM fetch + drainage) | DEM **2534ms** + drainage **45172ms** = **~47.7s total** | Under 120s smoke timeout; `fallbackUsed=true`, `coverage.degraded=true`, reason `pysheds worker exceeded 45000ms` |

Live drainage envelope excerpt:
```json
{
  "payload": {"status":"ok","library":"native-d8","fallbackUsed":true,"fallbackReason":"pysheds worker exceeded 45000ms"},
  "confidence":{"value":1,"kind":"deterministic"},
  "dataVintage":null,
  "coverage":{"degraded":true,"reason":"pysheds worker exceeded 45000ms"},
  "source":{"adapter":"hydrology:native-d8"}
}
```

**Verdict:** ~100s → ~48s live (non-blocking vs request timeout). Honest degradation surfaced. Further pysheds tuning optional.

---

## Retrieval Neon (#68) — `/healthz/`

Revision: `hauska-retrieval-api-00007-fsk`

```json
{
  "status": "ok",
  "db": {
    "ok": true,
    "status": "up",
    "source": "probe:substrate-neon SELECT 1",
    "latencyMs": 289
  },
  "corpus": {
    "ok": true,
    "atomCount": 21126,
    "source": "storage:countAtoms"
  }
}
```

---

## Grok vs Anthropic — findings side-by-side (canary, live keys)

Same 3 review bundles, `POST /v1/findings/generate`:

| Review | Mode | ms | Findings | Severities | Honesty |
|--------|------|-----|----------|------------|---------|
| **sm-ada-door** (San Marcos ADA) | grok | 5052 | 1 | concern | `kind=asserted`, `degraded=false`, `vintage=2025-11-01`, `adapter=finding-engine:grok` |
| | anthropic | 12985 | 2 | concern, advisory | same vintage, `adapter=finding-engine:anthropic` |
| **austin-egress** (IBC width) | grok | 4562 | **0** | — | vintage=2025-09-15 |
| | anthropic | 7697 | 2 | concern×2 | vintage=2025-09-15 |
| **sm-setback-flood** (FEMA flood) | grok | 5538 | 1 | concern | vintage=2025-03-01 |
| | anthropic | 5140 | 1 | **blocker** | vintage=2025-03-01 |

**Observations:**
- Anthropic produces more findings on sparse inputs (egress case: 2 vs 0); cites code atoms with `[[CODE:…]]` / `{{atom|…}}` markup more consistently.
- Grok ~2× faster (5–6s vs 8–13s); misses egress concerns when dimensions absent.
- Flood case: Anthropic escalates to `blocker`; Grok stays `concern`.
- Both populate envelope honesty fields correctly on canary.

**Recommendation:** **Keep `AIR_FINDING_LLM_MODE=anthropic` on prod.** Do not blind-flip to grok. Grok viable as cost/latency fallback once citation quality parity is validated on real plan-set uploads with vision sheets; re-evaluate after orchestrated findings path is live.

---

## Env / deploy workflow note

No `cloud-run-deploy.yml` in hauska-engine repo (only `.github/workflows/ci.yml` + `cloudbuild-engine-api.yaml`). Canary deployed via `gcloud run deploy --source` + tag. Traffic shift command (when unblocked):

```bash
gcloud run services update-traffic hauska-engine-api \
  --project=hauska-prod-497015 --region=us-central1 \
  --to-tags envelope-canary=100
```

---

## HR-13 test-plan status

| Item | Status |
|------|--------|
| PR #72 merged, CI green | ✅ |
| 0% canary deployed | ✅ `00006-lap` |
| 9-surface live smoke | ✅ (evidence above) |
| Drainage under timeout | ✅ ~48s live (was ~100s) |
| C field reconciliation | ✅ static match; ⏳ live canary-to-canary pending C deploy |
| #68 retrieval `/healthz/` db=up | ✅ |
| Grok vs Anthropic comparison | ✅ recommendation: stay anthropic |
| Traffic shift | ❌ blocked — C explicit go required |

---

## Final serving revisions

- **engine-api prod (100%):** `hauska-engine-api-00004-xpl`
- **engine-api canary (0%, tag `envelope-canary`):** `hauska-engine-api-00006-lap` @ merge lineage `9e75e54`
- **retrieval-api (100%):** `hauska-retrieval-api-00007-fsk`
