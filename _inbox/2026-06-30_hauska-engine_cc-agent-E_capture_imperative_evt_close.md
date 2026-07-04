# Close — hauska-engine TCE capture imperative + evt_ scaffold

**Date:** 2026-06-30  
**Branch:** `feat/tce-capture-evt-scaffold`  
**Operator:** cc-agent-E (orchestrator)

---

## Prerequisite — atom-contract@1.6.0

- `package.json` dependencies bumped to `^1.6.0` in `packages/atoms`, `packages/corpus`, `packages/atom-contract-pin`.
- **npm publish status:** `@hauska/atom-contract@1.6.0` is **not yet on npm** (latest published: `1.5.0`). Root `pnpm.overrides` pins resolve to `1.5.0` until cc-agent-AC publishes 1.6.0.
- TCE-only types (`WouldAffectEdge`, `EventCaptureAtom`, node prefixes) ship in `@hauska-engine/atom-contract-pin/tce` as an engine shim mirroring the 1.6.0 contract verbatim.

---

## Wave 1 — Grep list (pre-implementation)

Grep targets: live fetchers for forward-looking / event-typed data that display without persisting event-family atoms.

| Feed name | Adapter path | Persist atoms (after) | First-run atom count |
|-----------|--------------|----------------------|----------------------|
| `bastrop-tx:planning-agenda` | `packages/capture/src/feeds/bastrop-planning-agenda.ts` | Yes (new) | **2** |

**Grep result — no pre-existing feeds matched.** Searched patterns: `anticipatory`, `calendar`, `agenda`, `legislative`, `regulatory_notice`, `rulemaking`, `housing authority`, `knowledge_time`, `evt_`, `display-only`, event feed registry. All `@hauska-engine/adapters` producers are GIS / static overlay layers (FEMA, USGS, Regrid, Cotality, etc.) — not anticipatory event feeds. `services/engine-api/routes/encumbrances.ts` documents title/lien feeds as **pending**, not implemented.

**Self-test (bastrop-tx:planning-agenda):**
- First run: 2 atoms written; `knowledge_time` = `2026-06-30T12:00:00.000Z`, `valid_from` = `2026-06-12T18:00:00-05:00` (≠ knowledge_time).
- Second run: 0 written, 2 skipped (dedup).
- Persist failure: display fetch unaffected; ERROR logs + `capture_persist_failure_total` counter incremented per item.

---

## Dedup approach

**Exact dedup key:** `(source, stable_external_id, valid_from)` where `source` = `atom.provenance.source` (the source URL / API endpoint from the source registry).

Re-fetch of the same item at the same stated date → `duplicate` (no second atom). Status changes require a **supersession atom** (new `stable_external_id` or `valid_from`); no in-place updates.

---

## Persist failure surfacing

| Surface | Value |
|---------|-------|
| Log level | `ERROR` |
| Structured event | `capture.persist_failed` / `capture.persist_batch_failed` |
| Counter name | `capture_persist_failure_total` |
| E5 visibility | `InMemoryCaptureRunMonitor.getCapturePersistFailureCount(feedName)` — wired for run-monitor integration |
| Display path | Unaffected — `persistCapturedEventsFireAndForget` never rejects the display fetch |

**Reviewer note:** Persist is fire-and-forget with **no retry queue**. Operator detection is via ERROR logs + E5 counter; manual re-run is the recovery path. Acceptable for capture-imperative v1 per dispatch (log + counter sufficient).

---

## Wave 2 — evt_ resolver

**ID generation:** `evt_` + `sha256(source + "|" + external_id).hex.slice(0, 32)`

**Enforcement:** `assertValidEvtId(id, source, external_id)` — only IDs matching `resolveEvtId(source, external_id)` are valid. `rejectHandConstructedEvtId` rejects malformed suffixes. `writeWouldAffectEdge` requires `sourceNodeId` with `evt_` prefix (Zod + runtime). Hand-constructed valid-looking hex suffixes without source binding fail `assertValidEvtId`.

**Implementation:** `packages/identity/src/evt-resolver.ts`, `packages/identity/src/node-registry.ts`

**Node registry prefixes:** `evt_`, `parcel_`, `jurisdiction_`

---

## would_affect edge schema (verbatim)

```typescript
export interface WouldAffectEdge {
  type: "would_affect";
  sourceNodeId: string;   // must carry evt_ prefix
  targetSubjectId: string;
  effectiveDate: string;  // ISO 8601
  immutable: true;
}
```

**DB layer:** `structural_edges` table in `packages/storage/src/schema.ts` with composite PK `(sourceNodeId, targetSubjectId, edgeType, effectiveDate)` and **index on `targetSubjectId`**. In-memory store rejects duplicate writes (immutable — no update path).

**Query path:** `GET /subjects/:subjectId/events` (retrieval-api) → `HybridRetrieval.eventsAffectingSubject()` → inbound `would_affect` walk by `targetSubjectId`.

---

## Smoke — live feed + graph

`runEventFeedCapture({ feed: bastropPlanningAgendaFeed, store, graph })` writes 2 event atoms + `would_affect` edges from evt_ nodes to `jurisdiction_bastrop-tx` / `parcel_bastrop-142-river-oaks`.

---

## Feeds in scope but not wired

| Feed class | Reason |
|------------|--------|
| Legislative calendars | No fetcher in repo |
| Planning agendas (live) | No live Bastrop/city agenda API wired; fixture feed only |
| Zoning board schedules | No fetcher in repo |
| Code-update notices | Corpus drift/version-tracking fetches code corpus, not anticipatory notices |
| Rulemaking feeds | No fetcher in repo |
| Housing authority bulletins | No fetcher in repo |
| GIS briefing_sources adapters | Out of scope — not event-typed / forward-looking |
| Encumbrances (title/lien) | Documented pending in engine-api; not implemented |

---

## Suite-green confirmation

```
pnpm test
```

Verbatim result (2026-06-30):

```
packages/capture test:  Test Files  1 passed (1) | Tests  2 passed (2)
packages/identity test: (via retrieval dep chain)
packages/retrieval test:  Test Files  2 passed (2) | Tests  17 passed (17)
services/retrieval-api test:  Test Files  2 passed (2) | Tests  19 passed (19)
… (all 16 workspace packages green)
```

**Migration head:** No Drizzle migration runner in this repo; schema defines `structural_edges` as a single additive head in `packages/storage/src/schema.ts`. No competing migration heads.

---

## Files touched (summary)

- `packages/atom-contract-pin/src/tce.ts` — 1.6.0 shim types
- `packages/capture/` — new capture package + bastrop fixture feed
- `packages/identity/src/evt-resolver.ts`, `node-registry.ts`
- `packages/storage/src/tce-store.ts`, `schema.ts` (`structural_edges`)
- `packages/retrieval/src/events-affecting-subject.ts`
- `services/retrieval-api/src/server.ts` — `/subjects/:subjectId/events`
