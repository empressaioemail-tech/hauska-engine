# Changelog

All notable changes to `@hauska-engine/atoms` are documented here.

## [0.6.0] - 2026-05-19

Lane A.2 Phase F — L6 atom shape. **Completes the L1-L6 L-surface
atom-shape set; Lane A.2 is done.**

### Added — L6 `deliverable-letter-render` atom

The rendered DOCX/PDF output of an L3 `deliverable-letter`, as a
first-class atom. Planner architectural call per Sprint Amendment 6:
render output IS an atom, not an ephemeral byte side-effect — aligns
with the Hauska atom-first thesis (every output queryable with
reasoning chain + source citation + timestamp) and enables "show all
renders of this letter" audit queries. Renders are 1-to-many off L3.

- `RenderFormat` enum: `docx` / `pdf` (lowercase to match the package
  enum convention; extensible v1 set).
- `sourceLetterRef` — a `did:hauska:deliverable-letter:<localId>` ref
  to the L3 source atom; Zod-validated against `DELIVERABLE_LETTER_DID_RE`.
- `sourceLetterVersion` — the source letter's `contentHash` at render
  time, pinning rendered-against-which-version provenance (ADR-011).
- `blobRef` — opaque pointer to the stored render bytes; storage
  details (GCS key, signed-URL pattern, retention) are runtime-layer
  per Sprint Amendment 6. The atom carries the reference, not bytes.
- `renderedAt` + `renderedByActorId` (ADR-015 actor linking).
- Registration: domain `cortex`, five render modes (default `card`),
  `accessPolicy: "tenant-private"` (ADR-017), leaf composition, single
  eventType `deliverable-letter-render.produced` (an immutable
  produced artifact).
- `DELIVERABLE_LETTER_RENDER_SCHEMA` Zod schema — canonical boundary
  validation for the render pipeline + MCP tool + UI.
- 16-test conformance suite: schema + round-trip, `@ts-expect-error`
  widening rejection (format enum), reference-resolution test
  (`sourceLetterRef` parses + resolves to a real `deliverable-letter`
  atom; a dangling ref resolves to null), multi-render test (same
  `sourceLetterRef` + different `sourceLetterVersion` coexist as
  distinct atoms — 1-to-many proven; also same-version different-format),
  contextSummary round-trip.

Fires **Sync B(L6)** — unblocks Lane B (cc-agent-M
`cortex/deliverable_letter_render` MCP tool) and Lane C (cc-agent-C L6
UI surface).

### Lane A.2 complete

All six L-surface atom shapes are now locked in the engine
atom-registry: L1 `response-task`, L2 `sheet-content-extraction` +
`attached-document`, L3 `deliverable-letter`, L4 `detail-callout-spec`,
L5 `product-spec-reference`, L6 `deliverable-letter-render`. Seven
Cortex atom types total; `@hauska-engine/atoms` at 0.6.0.

## [0.5.0] - 2026-05-19

Lane A.2 Phase E — L5 atom shape.

### Added — L5 `product-spec-reference` atom

A reference to an ICC-ES-evaluated product spec (e.g. ESR-1234 for a
rated connector or assembly) carrying live ICC-ES status. When the
status changes upstream, the poller writes a new atom version and
downstream findings that cite the product flag.

- `ProductSpecStatus` enum: `active` / `withdrawn` / `expired` (mirrors
  the ICC-ES public surface).
- `ProductIdentifier` — structured `{ name, manufacturer }`, never
  free-text.
- `esrNumber` — Zod-validated against `ESR_NUMBER_RE` (`ESR-<digits>`).
- `ProductSpecStatusChange` + inline `statusHistory` — an append-only
  ESR-status-change chain so a consumer holding one atom version sees
  the transition history without walking the version chain. Always
  present; empty until the first verification is recorded.
- `status` + `lastVerifiedAt` carry current state; the inherited
  `BaseAtomInstance.sourceUrl` carries the ICC-ES listing URL (the
  dispatch's `source_url`).
- Source provenance: `engagementId`, `findingId`, `responseTaskId`.
  ADR-015 actor linking via `actorId` + `principalActorId`.
- Registration: domain `cortex`, five render modes (default `card`),
  `accessPolicy: "tenant-private"` (ADR-017), leaf composition,
  eventTypes `product-spec-reference.created` / `.verified` /
  `.status-changed`.
- `PRODUCT_SPEC_REFERENCE_SCHEMA` Zod schema — canonical boundary
  validation for the ICC-ES poller + MCP tool + UI.
- 17-test conformance suite: schema + ESR-format validation,
  `@ts-expect-error` widening rejection (status enum), status-change
  history tests (an `active` atom → a `withdrawn` version preserves the
  transition per ADR-011 — same DID, new contentHash, inline chain
  grown by one), contextSummary round-trip.

Live-verification mechanism per the dispatch: v1 is a periodic ICC-ES
re-poll, not a webhook. The poller is runtime-layer work
(legacy-design-tools per Sprint Amendment 6) and is NOT atom-shape
scope — the atom only carries `status` + `lastVerifiedAt` +
`statusHistory`; the poller writes status changes as new atom versions
per ADR-011.

Fires **Sync B(L5)** — unblocks Lane B (cc-agent-M
`cortex/product_spec_reference_*` MCP tools) and Lane C (cc-agent-C L5
UI surface).

## [0.4.0] - 2026-05-19

Lane A.2 Phase D — L4 atom shape.

### Added — L4 `detail-callout-spec` atom

A structured spec for a Revit detail callout. The Revit Connector
add-in consumes it and pushes the detail into the model via APS
Design Automation. Closes the Revit content-push gap.

- `DetailCalloutType` enum — v1 set: `door-schedule` / `wall-section`
  / `wall-type` / `room-finish`. The enum IS the discriminant of the
  `spec` payload; there is no redundant top-level `detailType` field,
  so atom + spec can never drift. Extensible: a new detail type adds a
  union member, a spec interface, a `DetailCalloutSpec` arm, and a Zod
  `discriminatedUnion` arm — no atom-shape migration.
- Per-type spec shapes: `DoorScheduleSpec`, `WallSectionSpec`,
  `WallTypeSpec`, `RoomFinishSpec`, unified as the `DetailCalloutSpec`
  discriminated union (`DETAIL_CALLOUT_SPEC_PAYLOAD_SCHEMA` is the Zod
  `z.discriminatedUnion`). `WallAssemblyLayer` shared by wall-section +
  wall-type.
- `DetailCalloutPushState` enum: `pending` / `pushed` / `applied` /
  `rejected-by-user`. `LEGAL_PUSH_TRANSITIONS` + `isLegalPushTransition`
  helper — advisory (no runtime enforcement, consistent with L1-L3
  state fields); `applied` is terminal, `rejected-by-user` can return
  to `pending` for a re-push.
- `apsTaskRef` — opaque APS Design Automation work-item ref; the Revit
  Connector populates it once `pushState` reaches `"pushed"`.
- Source provenance: `findingId` + `responseTaskId` (which finding /
  response-task drove the callout). ADR-015 actor linking via
  `actorId` + `principalActorId`.
- Registration: domain `cortex`, five render modes (default `card`),
  `accessPolicy: "tenant-private"` (ADR-017), leaf composition,
  eventTypes `detail-callout-spec.created` / `.pushed` / `.applied` /
  `.rejected`.
- `DETAIL_CALLOUT_SPEC_SCHEMA` Zod schema — canonical boundary
  validation for the Revit Connector add-in + MCP tool + UI.
- 20-test conformance suite: schema validation (one arm per detail
  type, mismatched-payload rejection), `@ts-expect-error` widening
  rejection, push-state transition tests (forward lifecycle, terminal
  `applied`, illegal skips), contextSummary round-trip.

Fires **Sync B(L4)** — unblocks Lane B (cc-agent-M
`cortex/detail_callout_spec_*` MCP tools) and Lane C (cc-agent-C L4 UI
surface).

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
