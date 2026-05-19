# Changelog

All notable changes to `@hauska-engine/atoms` are documented here.

## [0.3.0] - 2026-05-19

Lane A.2 Phase C — L3 atom shape.

### Added — L3 `deliverable-letter` atom

The comment-response letter as a classified atom: structured sections
with per-section provenance back to the L1 / L2 / finding / adjudication
atoms that fed each section. DOCX/PDF rendering is a downstream consumer
(L6) — the atom never carries rendered bytes.

- `DeliverableLetterAtomInstance` + `DELIVERABLE_LETTER_SCHEMA`.
- `LetterSection` + `LetterSectionProvenance` supporting types.
- `LetterSectionKind` enum: `cover` / `intro` / `per-comment-response` /
  `signature`. `REQUIRED_LETTER_SECTION_KINDS` = cover + intro +
  signature (per-comment-response is variable).
- `DeliverableLetterStatus` enum: `draft` / `sent`.
- Per-section provenance arrays: `responseTaskIds` (L1),
  `sheetContentExtractionIds` (L2), `findingIds`, `adjudicationStateIds`
  — per-section so a `per-comment-response` section names exactly the
  atoms it answers.
- `deliverableLetterCompleteness(sections)` helper — returns
  `{ complete, missing }`; the L6 render pipeline + UI gate the "send"
  action on it. A `draft` letter may legitimately be incomplete.
- Fields: `engagementId`, `title`, `status`, `recipientActorId`,
  `sections`, `createdAt`, `sentAt`, `actorId` + `principalActorId`
  (ADR-015).
- Registration: domain `cortex`, five render modes (default `card`),
  `accessPolicy: "tenant-private"` (ADR-017), leaf composition,
  eventTypes `deliverable-letter.drafted` / `.section-revised` /
  `.sent`.
- 23-test conformance suite: schema validation, `@ts-expect-error`
  widening rejection (status + section-kind unions), section-
  completeness checks, provenance-chain integrity, contextSummary
  round-trip.

Fires **Sync B(L3)** — unblocks Lane B (cc-agent-M
`cortex/deliverable_letter_*` MCP tools) and Lane C (cc-agent-C L3 UI
surface).

### Also in this release

- `services/retrieval-api` — corrected the `parseAccessPolicies`
  docstring: a present-but-empty `?accessPolicies=` yields an empty
  array, which the storage layer treats as "no filter" (its filter is
  gated on `accessPolicies.length > 0`), not "filters to nothing".
  Docstring-only; no behavior change.

## [0.2.0] - 2026-05-19

Lane A.2 Phase B — L2 atom shapes. Two coupled atoms (the sheet-ingest
pass extracts both inline in one pass).

### Added — L2a `sheet-content-extraction` atom

Classified output of the sheet-ingest pass: OCR text segments plus
structured annotations, produced downstream of the existing Claude
vision OCR step.

- `SheetContentExtractionAtomInstance` + `SHEET_CONTENT_EXTRACTION_SCHEMA`.
- `BoundingBox` (page-relative, normalized `[0,1]`), `SheetTextSegment`,
  `SheetStructuredAnnotation` supporting types.
- `SheetAnnotationKind` enum: `revision-cloud` / `dimension` /
  `schedule-row` / `callout`.
- Link fields: `sourceSheetId`, `engagementId`, `actorId` (ADR-015).
  `ocrModel` carries OCR provenance.
- Registration: domain `cortex`, five render modes (default `card`),
  `accessPolicy: "tenant-private"`, eventTypes
  `sheet-content-extraction.produced` / `.re-extracted`.

### Added — L2b `attached-document` atom

A supporting document attached to an engagement (spec, calculation,
product-data, narrative).

- `AttachedDocumentAtomInstance` + `ATTACHED_DOCUMENT_SCHEMA`.
- `AttachedDocumentType` enum: `specification` / `calculation` /
  `product-data` / `narrative`.
- Fields: `engagementId`, `title`, `documentType`, `extractedText`,
  `originalBlobRef`, `actorId` (ADR-015).
- Registration: domain `cortex`, five render modes (default `card`),
  `accessPolicy: "tenant-private"`, eventTypes
  `attached-document.ingested` / `.re-parsed`.

### Changed

- `CortexAtomInstance` union extended; `CORTEX_ATOM_ENTITY_TYPES` now
  lists all three Cortex atoms.
- 20-test L2 conformance suite (schema validation, registry
  registration, contextSummary round-trip, cross-reference coverage).

Fires **Sync B(L2)** — unblocks Lane B (cc-agent-M
`cortex/sheet_content_extraction_*` MCP tools) and Lane C (cc-agent-C
L2 UI surface).

## [0.1.0] - 2026-05-19

Lane A.2 — L-surface atom shapes. Adds the first Cortex (L-surface)
atom type to the engine atom-registry per
`_dispatches/2026-05-19_cc-agent-E_l_surface_atom_shapes.md`. Per
option β (ADR-018), these catalog-data atoms live in the engine
atom-registry, not the `@hauska/atom-contract` framework package.

### Added — L1 `response-task` atom

Persistent task state for the client-comment response flow (architect
receives client comments → creates response tasks → tracks state
across sessions).

- `ResponseTaskAtomInstance` interface + `RESPONSE_TASK_SCHEMA` Zod
  schema for cross-repo boundary validation.
- `ResponseTaskState` enum: `open` / `in-progress` / `done` /
  `cancelled`.
- `AtomRegistration` in `bootstrapEngineAtomRegistry()`:
  - Domain `cortex`; five render modes (default `card`).
  - `accessPolicy: "tenant-private"` per ADR-017 (engagement workflow
    data, never public catalog).
  - Audit-chain `eventTypes`: `response-task.opened` / `.progressed` /
    `.completed` / `.cancelled`. The atom record holds current state;
    these let consumers compose an event-sourced view from the storage
    event log without the atom carrying the chain inline.
  - ADR-015 actor linking: `actorId` (assigned) + `principalActorId`
    (accountable).
  - Cross-product link fields: `sourceClientCommentId`, `findingId`,
    `engagementId`.
- New union exports: `CortexAtomInstance`, `AtomInstance`
  (code-corpus + Cortex), `AtomEntityType`, `CORTEX_ATOM_ENTITY_TYPES`.
- `InstanceLookup` broadened from `CodeAtomInstance` to the full
  `AtomInstance` union.
- 16-test conformance suite: schema validation, registry registration,
  contextSummary round-trip, render-mode coverage, accessPolicy
  default, audience-lensed prose.

Fires **Sync B(L1)** — unblocks Lane B (cc-agent-M `cortex/response_task_*`
MCP tools) and Lane C (cc-agent-C L1 UI surface).

### Dependencies

- `zod@^3.24.1` added as a direct dependency (was previously only
  transitively available via `@hauska/atom-contract`).

## [0.0.0] - 2026-05-18

Initial bootstrap. Engine-side atom-instance registry for the Bump 1
code-corpus atom types: `code-section`, `code-definition`,
`code-amendment`, `code-cross-reference`, `code-edition`,
`jurisdiction-corpus`.
