# Changelog

All notable changes to `@hauska-engine/atoms` are documented here.

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
