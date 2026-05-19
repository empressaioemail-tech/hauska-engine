/**
 * Conformance suite for the L3 `deliverable-letter` atom.
 *
 * Per the 2026-05-19 Lane A.2 dispatch Phase C test plan: schema
 * validation, register() → contextSummary() round-trip, @ts-expect-error
 * widening rejection, render-mode coverage, provenance-chain integrity,
 * section-completeness checks.
 */

import { describe, expect, it } from "vitest";

import { bootstrapEngineAtomRegistry, type InstanceLookup } from "../registry.js";
import {
  DELIVERABLE_LETTER_SCHEMA,
  DELIVERABLE_LETTER_STATUSES,
  LETTER_SECTION_KINDS,
  deliverableLetterCompleteness,
  type DeliverableLetterAtomInstance,
  type LetterSection,
} from "../instances.js";

function section(overrides: Partial<LetterSection> = {}): LetterSection {
  return {
    kind: "per-comment-response",
    heading: "Response to Comment 7",
    content: "Stair 2 egress widened to 44in clear per the reviewer comment.",
    provenance: {
      responseTaskIds: ["engagement-42/task-001"],
      sheetContentExtractionIds: ["engagement-42/sheet-A-101/extraction"],
      findingIds: ["engagement-42/finding-101"],
      adjudicationStateIds: ["engagement-42/adjudication-007"],
    },
    ...overrides,
  };
}

const emptyProvenance = {
  responseTaskIds: [],
  sheetContentExtractionIds: [],
  findingIds: [],
  adjudicationStateIds: [],
};

function makeLetter(
  overrides: Partial<DeliverableLetterAtomInstance> = {},
): DeliverableLetterAtomInstance {
  return {
    entityType: "deliverable-letter",
    entityId: "engagement-42/letter-rev2",
    jurisdictionTenant: "moab-ut",
    fetchedAt: "2026-05-19T00:00:00Z",
    sourceAdapter: "cortex-deliverable-flow",
    sourceUrl: "",
    contentHash: "letterhash1",
    engagementId: "engagement-42",
    title: "Comment Response Letter — Musgrave Residence Rev 2",
    status: "draft",
    recipientActorId: "actor/client-musgrave",
    sections: [
      { kind: "cover", heading: "", content: "Cover page.", provenance: emptyProvenance },
      { kind: "intro", heading: "Introduction", content: "We have addressed all comments.", provenance: emptyProvenance },
      section(),
      { kind: "signature", heading: "", content: "Sincerely, Jane Architect.", provenance: emptyProvenance },
    ],
    createdAt: "2026-05-19T00:00:00Z",
    sentAt: null,
    actorId: "actor/architect-jane",
    principalActorId: "actor/principal-bob",
    accessPolicy: "tenant-private",
    ...overrides,
  };
}

function lookupFor(inst: DeliverableLetterAtomInstance): InstanceLookup {
  return {
    async get(entityType, entityId) {
      if (entityType === "deliverable-letter" && entityId === inst.entityId) {
        return inst as never;
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

describe("deliverable-letter — Zod schema", () => {
  it("accepts a well-formed instance", () => {
    expect(DELIVERABLE_LETTER_SCHEMA.safeParse(makeLetter()).success).toBe(true);
  });

  it("accepts both lifecycle statuses", () => {
    for (const status of DELIVERABLE_LETTER_STATUSES) {
      const inst =
        status === "sent"
          ? makeLetter({ status, sentAt: "2026-05-22T00:00:00Z" })
          : makeLetter({ status });
      expect(DELIVERABLE_LETTER_SCHEMA.safeParse(inst).success).toBe(true);
    }
  });

  it("accepts every section kind", () => {
    for (const kind of LETTER_SECTION_KINDS) {
      const inst = makeLetter({
        sections: [{ kind, heading: "", content: "x", provenance: emptyProvenance }],
      });
      expect(DELIVERABLE_LETTER_SCHEMA.safeParse(inst).success).toBe(true);
    }
  });

  it("rejects an unknown section kind", () => {
    const bad = {
      ...makeLetter(),
      sections: [
        { kind: "appendix", heading: "", content: "x", provenance: emptyProvenance },
      ],
    };
    expect(DELIVERABLE_LETTER_SCHEMA.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    const bad = { ...makeLetter(), status: "archived" };
    expect(DELIVERABLE_LETTER_SCHEMA.safeParse(bad).success).toBe(false);
  });

  it("rejects a section missing its provenance object", () => {
    const bad = {
      ...makeLetter(),
      sections: [{ kind: "cover", heading: "", content: "x" }],
    };
    expect(DELIVERABLE_LETTER_SCHEMA.safeParse(bad).success).toBe(false);
  });

  it("requires a non-empty engagementId", () => {
    expect(
      DELIVERABLE_LETTER_SCHEMA.safeParse({ ...makeLetter(), engagementId: "" })
        .success,
    ).toBe(false);
  });

  it("accepts an empty sections array (fresh draft)", () => {
    expect(
      DELIVERABLE_LETTER_SCHEMA.safeParse(makeLetter({ sections: [] })).success,
    ).toBe(true);
  });

  it("allows nullable recipient + actor + sentAt", () => {
    const result = DELIVERABLE_LETTER_SCHEMA.safeParse(
      makeLetter({
        recipientActorId: null,
        actorId: null,
        principalActorId: null,
        sentAt: null,
      }),
    );
    expect(result.success).toBe(true);
  });
});

describe("deliverable-letter — @ts-expect-error widening rejection", () => {
  it("rejects a widened status literal at compile time", () => {
    // @ts-expect-error — status is the literal union "draft" | "sent"
    const badStatus: DeliverableLetterAtomInstance["status"] = "archived";
    void badStatus;
    // @ts-expect-error — section kind is a fixed literal union
    const badKind: LetterSection["kind"] = "appendix";
    void badKind;
    expect(true).toBe(true);
  });
});

describe("deliverable-letter — section completeness", () => {
  it("a letter with cover + intro + signature is complete", () => {
    const result = deliverableLetterCompleteness(makeLetter().sections);
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("a letter missing the signature is incomplete", () => {
    const sections = makeLetter().sections.filter((s) => s.kind !== "signature");
    const result = deliverableLetterCompleteness(sections);
    expect(result.complete).toBe(false);
    expect(result.missing).toContain("signature");
  });

  it("an empty-sections draft reports all required sections missing", () => {
    const result = deliverableLetterCompleteness([]);
    expect(result.complete).toBe(false);
    expect([...result.missing].sort()).toEqual(["cover", "intro", "signature"]);
  });

  it("per-comment-response sections are not required for completeness", () => {
    const sections = makeLetter().sections.filter(
      (s) => s.kind !== "per-comment-response",
    );
    expect(deliverableLetterCompleteness(sections).complete).toBe(true);
  });
});

describe("deliverable-letter — provenance-chain integrity", () => {
  it("per-comment-response sections carry L1/L2/finding/adjudication refs", () => {
    const letter = makeLetter();
    const responseSections = letter.sections.filter(
      (s) => s.kind === "per-comment-response",
    );
    expect(responseSections.length).toBeGreaterThan(0);
    for (const s of responseSections) {
      expect(s.provenance.responseTaskIds.length).toBeGreaterThan(0);
      expect(s.provenance.sheetContentExtractionIds.length).toBeGreaterThan(0);
      expect(s.provenance.findingIds.length).toBeGreaterThan(0);
      expect(s.provenance.adjudicationStateIds.length).toBeGreaterThan(0);
    }
  });

  it("cover / intro / signature sections may carry empty provenance", () => {
    const letter = makeLetter();
    const structural = letter.sections.filter(
      (s) => s.kind !== "per-comment-response",
    );
    for (const s of structural) {
      const p = s.provenance;
      const total =
        p.responseTaskIds.length +
        p.sheetContentExtractionIds.length +
        p.findingIds.length +
        p.adjudicationStateIds.length;
      expect(total).toBe(0);
    }
  });
});

describe("deliverable-letter — registry registration", () => {
  it("registers under domain cortex with five render modes", () => {
    const registry = bootstrapEngineAtomRegistry();
    const reg = resolveOrThrow(registry, "deliverable-letter");
    expect(reg.domain).toBe("cortex");
    expect(reg.defaultMode).toBe("card");
    expect([...reg.supportedModes].sort()).toEqual([
      "card",
      "compact",
      "expanded",
      "focus",
      "inline",
    ]);
  });

  it("defaults accessPolicy to tenant-private + declares audit eventTypes", () => {
    const registry = bootstrapEngineAtomRegistry();
    const reg = resolveOrThrow(registry, "deliverable-letter");
    expect(reg.accessPolicy).toBe("tenant-private");
    expect(reg.eventTypes).toEqual([
      "deliverable-letter.drafted",
      "deliverable-letter.section-revised",
      "deliverable-letter.sent",
    ]);
    expect(reg.composition).toEqual([]);
  });
});

describe("deliverable-letter — contextSummary round-trip", () => {
  it("resolves a draft letter to a four-layer summary", async () => {
    const inst = makeLetter();
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupFor(inst) });
    const reg = resolveOrThrow(registry, "deliverable-letter");
    const summary = await reg.contextSummary(inst.entityId, { audience: "ai" });
    expect(summary.prose).toContain(inst.title);
    expect(summary.prose).toContain("draft");
    expect(summary.prose).toContain("complete");
    expect(summary.typed.status).toBe("draft");
    expect(summary.typed.sectionCount).toBe(4);
    expect(summary.typed.complete).toBe(true);
  });

  it("surfaces missing sections in the summary for an incomplete letter", async () => {
    const inst = makeLetter({
      sections: makeLetter().sections.filter((s) => s.kind !== "signature"),
    });
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupFor(inst) });
    const reg = resolveOrThrow(registry, "deliverable-letter");
    const summary = await reg.contextSummary(inst.entityId, { audience: "ai" });
    expect(summary.prose).toContain("incomplete");
    expect(summary.typed.complete).toBe(false);
    expect(summary.typed.missingSections).toContain("signature");
  });

  it("a sent letter surfaces sentAt as the latest-event timestamp", async () => {
    const inst = makeLetter({ status: "sent", sentAt: "2026-05-22T09:00:00Z" });
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupFor(inst) });
    const reg = resolveOrThrow(registry, "deliverable-letter");
    const summary = await reg.contextSummary(inst.entityId, { audience: "ai" });
    expect(summary.historyProvenance.latestEventAt).toBe("2026-05-22T09:00:00Z");
  });

  it("user-audience prose is compact (scopeFiltered)", async () => {
    const inst = makeLetter();
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupFor(inst) });
    const reg = resolveOrThrow(registry, "deliverable-letter");
    const summary = await reg.contextSummary(inst.entityId, { audience: "user" });
    expect(summary.scopeFiltered).toBe(true);
  });

  it("returns a not-found summary for an unknown entityId", async () => {
    const inst = makeLetter();
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupFor(inst) });
    const reg = resolveOrThrow(registry, "deliverable-letter");
    const summary = await reg.contextSummary("engagement-42/letter-999", {
      audience: "ai",
    });
    expect(summary.prose).toContain("not found");
  });
});
