/**
 * Conformance suite for the L2 atoms — `sheet-content-extraction` and
 * `attached-document`.
 *
 * Per the 2026-05-19 Lane A.2 dispatch Phase B test plan: schema +
 * register() → contextSummary() round-trip for both; cross-reference
 * coverage (sheet → annotations, engagement → attached docs).
 */

import { describe, expect, it } from "vitest";

import { bootstrapEngineAtomRegistry, type InstanceLookup } from "../registry.js";
import {
  ATTACHED_DOCUMENT_SCHEMA,
  ATTACHED_DOCUMENT_TYPES,
  SHEET_ANNOTATION_KINDS,
  SHEET_CONTENT_EXTRACTION_SCHEMA,
  type AttachedDocumentAtomInstance,
  type SheetContentExtractionAtomInstance,
} from "../instances.js";

function makeSheetExtraction(
  overrides: Partial<SheetContentExtractionAtomInstance> = {},
): SheetContentExtractionAtomInstance {
  return {
    entityType: "sheet-content-extraction",
    entityId: "engagement-42/sheet-A-101/extraction",
    jurisdictionTenant: "moab-ut",
    fetchedAt: "2026-05-19T00:00:00Z",
    sourceAdapter: "cortex-sheet-ingest",
    sourceUrl: "",
    contentHash: "sheethash1",
    sourceSheetId: "engagement-42/sheet-A-101",
    engagementId: "engagement-42",
    pageLabel: "A-101",
    extractedTextSegments: [
      {
        text: "FLOOR PLAN — LEVEL 1",
        boundingBox: { x: 0.1, y: 0.05, width: 0.4, height: 0.03 },
        sourceConfidence: 0.98,
      },
    ],
    structuredAnnotations: [
      {
        kind: "revision-cloud",
        position: { x: 0.5, y: 0.5, width: 0.2, height: 0.15 },
        content: "Revised egress stair per comment 7",
        sourceConfidence: 0.91,
      },
      {
        kind: "dimension",
        position: { x: 0.2, y: 0.6, width: 0.1, height: 0.02 },
        content: "44in clear",
        sourceConfidence: 0.95,
      },
    ],
    ocrModel: "claude-sonnet-4-5",
    actorId: "actor/architect-jane",
    accessPolicy: "tenant-private",
    ...overrides,
  };
}

function makeAttachedDocument(
  overrides: Partial<AttachedDocumentAtomInstance> = {},
): AttachedDocumentAtomInstance {
  return {
    entityType: "attached-document",
    entityId: "engagement-42/doc-structural-calc",
    jurisdictionTenant: "moab-ut",
    fetchedAt: "2026-05-19T00:00:00Z",
    sourceAdapter: "cortex-sheet-ingest",
    sourceUrl: "",
    contentHash: "dochash1",
    engagementId: "engagement-42",
    title: "Structural Calculations — Lateral",
    documentType: "calculation",
    extractedText: "Lateral analysis per ASCE 7-22. Base shear V = ...",
    originalBlobRef: "blob/engagement-42/structural-calc.pdf",
    actorId: "actor/architect-jane",
    accessPolicy: "tenant-private",
    ...overrides,
  };
}

function lookupL2(
  sheet?: SheetContentExtractionAtomInstance,
  doc?: AttachedDocumentAtomInstance,
): InstanceLookup {
  return {
    async get(entityType, entityId) {
      if (
        entityType === "sheet-content-extraction" &&
        sheet &&
        entityId === sheet.entityId
      ) {
        return sheet as never;
      }
      if (
        entityType === "attached-document" &&
        doc &&
        entityId === doc.entityId
      ) {
        return doc as never;
      }
      return null;
    },
  };
}

function resolveOrThrow(
  registry: ReturnType<typeof bootstrapEngineAtomRegistry>,
  entityType: string,
) {
  const result = registry.resolve(entityType);
  if (!result.ok) throw result.error;
  return result.registration;
}

describe("sheet-content-extraction — Zod schema", () => {
  it("accepts a well-formed instance", () => {
    expect(
      SHEET_CONTENT_EXTRACTION_SCHEMA.safeParse(makeSheetExtraction()).success,
    ).toBe(true);
  });

  it("accepts every annotation kind", () => {
    for (const kind of SHEET_ANNOTATION_KINDS) {
      const inst = makeSheetExtraction({
        structuredAnnotations: [
          {
            kind,
            position: { x: 0, y: 0, width: 0.1, height: 0.1 },
            content: "x",
            sourceConfidence: 0.9,
          },
        ],
      });
      expect(SHEET_CONTENT_EXTRACTION_SCHEMA.safeParse(inst).success).toBe(true);
    }
  });

  it("rejects an unknown annotation kind", () => {
    const bad = makeSheetExtraction();
    const result = SHEET_CONTENT_EXTRACTION_SCHEMA.safeParse({
      ...bad,
      structuredAnnotations: [
        {
          kind: "watermark",
          position: { x: 0, y: 0, width: 0.1, height: 0.1 },
          content: "x",
          sourceConfidence: 0.9,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a confidence outside [0,1]", () => {
    const result = SHEET_CONTENT_EXTRACTION_SCHEMA.safeParse(
      makeSheetExtraction({
        extractedTextSegments: [
          {
            text: "x",
            boundingBox: { x: 0, y: 0, width: 0.1, height: 0.1 },
            sourceConfidence: 1.4,
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts empty segment + annotation lists (blank sheet)", () => {
    const result = SHEET_CONTENT_EXTRACTION_SCHEMA.safeParse(
      makeSheetExtraction({
        extractedTextSegments: [],
        structuredAnnotations: [],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("allows nullable engagementId + actorId", () => {
    const result = SHEET_CONTENT_EXTRACTION_SCHEMA.safeParse(
      makeSheetExtraction({ engagementId: null, actorId: null }),
    );
    expect(result.success).toBe(true);
  });
});

describe("attached-document — Zod schema", () => {
  it("accepts a well-formed instance", () => {
    expect(
      ATTACHED_DOCUMENT_SCHEMA.safeParse(makeAttachedDocument()).success,
    ).toBe(true);
  });

  it("accepts every document type", () => {
    for (const documentType of ATTACHED_DOCUMENT_TYPES) {
      expect(
        ATTACHED_DOCUMENT_SCHEMA.safeParse(makeAttachedDocument({ documentType }))
          .success,
      ).toBe(true);
    }
  });

  it("rejects an unknown document type", () => {
    const result = ATTACHED_DOCUMENT_SCHEMA.safeParse({
      ...makeAttachedDocument(),
      documentType: "blueprint",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing originalBlobRef", () => {
    const result = ATTACHED_DOCUMENT_SCHEMA.safeParse(
      makeAttachedDocument({ originalBlobRef: "" }),
    );
    expect(result.success).toBe(false);
  });

  it("requires a non-empty engagementId (attached docs are engagement-scoped)", () => {
    const result = ATTACHED_DOCUMENT_SCHEMA.safeParse({
      ...makeAttachedDocument(),
      engagementId: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("L2 atoms — registry registration", () => {
  it("registers sheet-content-extraction under domain cortex", () => {
    const registry = bootstrapEngineAtomRegistry();
    const reg = resolveOrThrow(registry, "sheet-content-extraction");
    expect(reg.domain).toBe("cortex");
    expect(reg.defaultMode).toBe("card");
    expect([...reg.supportedModes].sort()).toEqual([
      "card",
      "compact",
      "expanded",
      "focus",
      "inline",
    ]);
    expect(reg.accessPolicy).toBe("tenant-private");
    expect(reg.composition).toEqual([]);
    expect(reg.eventTypes).toEqual([
      "sheet-content-extraction.produced",
      "sheet-content-extraction.re-extracted",
    ]);
  });

  it("registers attached-document under domain cortex", () => {
    const registry = bootstrapEngineAtomRegistry();
    const reg = resolveOrThrow(registry, "attached-document");
    expect(reg.domain).toBe("cortex");
    expect(reg.accessPolicy).toBe("tenant-private");
    expect(reg.composition).toEqual([]);
    expect(reg.eventTypes).toEqual([
      "attached-document.ingested",
      "attached-document.re-parsed",
    ]);
  });
});

describe("L2 atoms — contextSummary round-trip", () => {
  it("sheet-content-extraction resolves to a four-layer summary", async () => {
    const sheet = makeSheetExtraction();
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupL2(sheet) });
    const reg = resolveOrThrow(registry, "sheet-content-extraction");
    const summary = await reg.contextSummary(sheet.entityId, {
      audience: "ai",
    });
    expect(summary.prose).toContain("A-101");
    expect(summary.typed.annotationCount).toBe(2);
    expect(summary.typed.textSegmentCount).toBe(1);
    expect(summary.typed.ocrModel).toBe("claude-sonnet-4-5");
    expect(summary.keyMetrics.some((m) => m.value === 2)).toBe(true);
  });

  it("attached-document resolves to a four-layer summary", async () => {
    const doc = makeAttachedDocument();
    const registry = bootstrapEngineAtomRegistry({
      lookup: lookupL2(undefined, doc),
    });
    const reg = resolveOrThrow(registry, "attached-document");
    const summary = await reg.contextSummary(doc.entityId, { audience: "ai" });
    expect(summary.prose).toContain("Structural Calculations");
    expect(summary.typed.documentType).toBe("calculation");
    expect(summary.typed.engagementId).toBe("engagement-42");
  });

  it("sheet-content-extraction user-audience prose is compact", async () => {
    const sheet = makeSheetExtraction();
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupL2(sheet) });
    const reg = resolveOrThrow(registry, "sheet-content-extraction");
    const summary = await reg.contextSummary(sheet.entityId, {
      audience: "user",
    });
    expect(summary.scopeFiltered).toBe(true);
  });

  it("both L2 atoms return a not-found summary for unknown ids", async () => {
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupL2() });
    const sheetReg = resolveOrThrow(registry, "sheet-content-extraction");
    const docReg = resolveOrThrow(registry, "attached-document");
    const s = await sheetReg.contextSummary("nope", { audience: "ai" });
    const d = await docReg.contextSummary("nope", { audience: "ai" });
    expect(s.prose).toContain("not found");
    expect(d.prose).toContain("not found");
  });
});

describe("L2 atoms — cross-reference coverage", () => {
  it("sheet extraction carries its annotations inline (sheet → annotations)", () => {
    const sheet = makeSheetExtraction();
    expect(sheet.structuredAnnotations).toHaveLength(2);
    expect(sheet.structuredAnnotations.map((a) => a.kind)).toContain(
      "revision-cloud",
    );
    // Each annotation is positioned + confidence-scored.
    for (const ann of sheet.structuredAnnotations) {
      expect(ann.position.width).toBeGreaterThan(0);
      expect(ann.sourceConfidence).toBeGreaterThanOrEqual(0);
      expect(ann.sourceConfidence).toBeLessThanOrEqual(1);
    }
  });

  it("sheet extraction links back to its source sheet + engagement", () => {
    const sheet = makeSheetExtraction();
    expect(sheet.sourceSheetId).toBe("engagement-42/sheet-A-101");
    expect(sheet.engagementId).toBe("engagement-42");
  });

  it("attached document links to its engagement (engagement → attached docs)", () => {
    const doc = makeAttachedDocument();
    expect(doc.engagementId).toBe("engagement-42");
    // sheet extraction + attached doc share the same engagement — the
    // join key a consumer uses to gather all L2 artifacts for a project.
    const sheet = makeSheetExtraction();
    expect(doc.engagementId).toBe(sheet.engagementId);
  });
});
