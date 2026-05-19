/**
 * Conformance suite for the L6 `deliverable-letter-render` atom — the
 * last L-surface atom shape.
 *
 * Per the 2026-05-19 Lane A.2 dispatch Phase F test plan: schema +
 * round-trip, @ts-expect-error widening rejection on the format enum,
 * a reference-resolution test (`sourceLetterRef` resolves to a real
 * `deliverable-letter` atom), and a multi-render test (same
 * `sourceLetterRef` + different `sourceLetterVersion` coexist —
 * 1-to-many proven).
 */

import { describe, expect, it } from "vitest";

import { buildAtomDid, parseAtomDid } from "../did.js";
import { bootstrapEngineAtomRegistry, type InstanceLookup } from "../registry.js";
import {
  DELIVERABLE_LETTER_RENDER_SCHEMA,
  RENDER_FORMATS,
  type DeliverableLetterAtomInstance,
  type DeliverableLetterRenderAtomInstance,
  type RenderFormat,
} from "../instances.js";

const SOURCE_LETTER_LOCAL_ID = "engagement-42/letter-rev2";
const SOURCE_LETTER_DID = buildAtomDid(
  "deliverable-letter",
  SOURCE_LETTER_LOCAL_ID,
).raw;

function makeRender(
  overrides: Partial<DeliverableLetterRenderAtomInstance> = {},
): DeliverableLetterRenderAtomInstance {
  return {
    entityType: "deliverable-letter-render",
    entityId: "engagement-42/letter-rev2/render-pdf-001",
    jurisdictionTenant: "moab-ut",
    fetchedAt: "2026-05-19T00:00:00Z",
    sourceAdapter: "cortex-render-pipeline",
    sourceUrl: "",
    contentHash: "renderhash1",
    sourceLetterRef: SOURCE_LETTER_DID,
    sourceLetterVersion: "letterhash-v1",
    format: "pdf",
    blobRef: "gcs://cortex-renders/engagement-42/letter-rev2/render-pdf-001.pdf",
    renderedAt: "2026-05-19T02:00:00Z",
    renderedByActorId: "actor/architect-jane",
    accessPolicy: "tenant-private",
    ...overrides,
  };
}

/** A minimal source deliverable-letter, for the reference-resolution test. */
function makeSourceLetter(): DeliverableLetterAtomInstance {
  return {
    entityType: "deliverable-letter",
    entityId: SOURCE_LETTER_LOCAL_ID,
    jurisdictionTenant: "moab-ut",
    fetchedAt: "2026-05-19T00:00:00Z",
    sourceAdapter: "cortex-deliverable-flow",
    sourceUrl: "",
    contentHash: "letterhash-v1",
    engagementId: "engagement-42",
    title: "Comment Response Letter — Musgrave Residence Rev 2",
    status: "sent",
    recipientActorId: "actor/client-musgrave",
    sections: [],
    createdAt: "2026-05-19T00:00:00Z",
    sentAt: "2026-05-19T01:00:00Z",
    actorId: "actor/architect-jane",
    principalActorId: "actor/principal-bob",
    accessPolicy: "tenant-private",
  };
}

function lookupWith(
  render?: DeliverableLetterRenderAtomInstance,
  letter?: DeliverableLetterAtomInstance,
): InstanceLookup {
  return {
    async get(entityType, entityId) {
      if (
        entityType === "deliverable-letter-render" &&
        render &&
        entityId === render.entityId
      ) {
        return render as never;
      }
      if (
        entityType === "deliverable-letter" &&
        letter &&
        entityId === letter.entityId
      ) {
        return letter as never;
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

describe("deliverable-letter-render — Zod schema", () => {
  it("accepts a well-formed instance", () => {
    expect(
      DELIVERABLE_LETTER_RENDER_SCHEMA.safeParse(makeRender()).success,
    ).toBe(true);
  });

  it("accepts every render format", () => {
    for (const format of RENDER_FORMATS) {
      expect(
        DELIVERABLE_LETTER_RENDER_SCHEMA.safeParse(makeRender({ format }))
          .success,
      ).toBe(true);
    }
  });

  it("rejects an unknown format", () => {
    const bad = { ...makeRender(), format: "rtf" };
    expect(DELIVERABLE_LETTER_RENDER_SCHEMA.safeParse(bad).success).toBe(false);
  });

  it("rejects a sourceLetterRef that is not a deliverable-letter DID", () => {
    for (const bad of [
      "engagement-42/letter-rev2",
      "did:hauska:response-task:engagement-42/task-001",
      "did:hauska:deliverable-letter:",
      "",
    ]) {
      const result = DELIVERABLE_LETTER_RENDER_SCHEMA.safeParse(
        makeRender({ sourceLetterRef: bad }),
      );
      expect(result.success, `${bad || "(empty)"} should reject`).toBe(false);
    }
  });

  it("rejects a missing blobRef or sourceLetterVersion", () => {
    expect(
      DELIVERABLE_LETTER_RENDER_SCHEMA.safeParse(makeRender({ blobRef: "" }))
        .success,
    ).toBe(false);
    expect(
      DELIVERABLE_LETTER_RENDER_SCHEMA.safeParse(
        makeRender({ sourceLetterVersion: "" }),
      ).success,
    ).toBe(false);
  });

  it("allows a null renderedByActorId (system render)", () => {
    expect(
      DELIVERABLE_LETTER_RENDER_SCHEMA.safeParse(
        makeRender({ renderedByActorId: null }),
      ).success,
    ).toBe(true);
  });
});

describe("deliverable-letter-render — @ts-expect-error widening rejection", () => {
  it("rejects a widened format literal at compile time", () => {
    // @ts-expect-error — format is the literal union "docx" | "pdf"
    const badFormat: RenderFormat = "rtf";
    void badFormat;
    expect(true).toBe(true);
  });
});

describe("deliverable-letter-render — reference resolution", () => {
  it("sourceLetterRef resolves to a real deliverable-letter atom", async () => {
    const render = makeRender();
    const letter = makeSourceLetter();
    const lookup = lookupWith(render, letter);

    // Parse the render's sourceLetterRef DID and resolve it.
    const parsed = parseAtomDid(render.sourceLetterRef);
    expect(parsed.entityType).toBe("deliverable-letter");

    const resolved = await lookup.get<DeliverableLetterAtomInstance>(
      "deliverable-letter",
      parsed.localId,
    );
    expect(resolved).not.toBeNull();
    expect(resolved?.entityType).toBe("deliverable-letter");
    expect(resolved?.entityId).toBe(letter.entityId);
  });

  it("a dangling sourceLetterRef resolves to null (no source letter)", async () => {
    const render = makeRender();
    // lookup has the render but NOT the source letter.
    const lookup = lookupWith(render, undefined);
    const parsed = parseAtomDid(render.sourceLetterRef);
    const resolved = await lookup.get("deliverable-letter", parsed.localId);
    expect(resolved).toBeNull();
  });
});

describe("deliverable-letter-render — multi-render (1-to-many)", () => {
  it("same sourceLetterRef + different sourceLetterVersion coexist", () => {
    // Render 1: PDF of the letter at version v1.
    const r1 = makeRender({
      entityId: "engagement-42/letter-rev2/render-pdf-001",
      sourceLetterVersion: "letterhash-v1",
      format: "pdf",
    });
    // Render 2: the letter was updated; DOCX render of version v2.
    const r2 = makeRender({
      entityId: "engagement-42/letter-rev2/render-docx-002",
      sourceLetterVersion: "letterhash-v2",
      format: "docx",
      renderedAt: "2026-06-01T00:00:00Z",
    });

    // Both reference the SAME source letter.
    expect(r1.sourceLetterRef).toBe(r2.sourceLetterRef);
    // ...but pin DIFFERENT source-letter versions.
    expect(r1.sourceLetterVersion).not.toBe(r2.sourceLetterVersion);
    // ...and are DISTINCT atoms (distinct entityIds → distinct DIDs).
    expect(r1.entityId).not.toBe(r2.entityId);
    expect(buildAtomDid(r1.entityType, r1.entityId).raw).not.toBe(
      buildAtomDid(r2.entityType, r2.entityId).raw,
    );
    // Both schema-validate — 1-to-many off one source letter proven.
    expect(DELIVERABLE_LETTER_RENDER_SCHEMA.safeParse(r1).success).toBe(true);
    expect(DELIVERABLE_LETTER_RENDER_SCHEMA.safeParse(r2).success).toBe(true);
  });

  it("re-rendering the same version in a different format also coexists", () => {
    const pdf = makeRender({
      entityId: "engagement-42/letter-rev2/render-pdf-001",
      format: "pdf",
    });
    const docx = makeRender({
      entityId: "engagement-42/letter-rev2/render-docx-001",
      format: "docx",
    });
    expect(pdf.sourceLetterRef).toBe(docx.sourceLetterRef);
    expect(pdf.sourceLetterVersion).toBe(docx.sourceLetterVersion);
    expect(pdf.entityId).not.toBe(docx.entityId);
    expect(DELIVERABLE_LETTER_RENDER_SCHEMA.safeParse(pdf).success).toBe(true);
    expect(DELIVERABLE_LETTER_RENDER_SCHEMA.safeParse(docx).success).toBe(true);
  });
});

describe("deliverable-letter-render — registry registration", () => {
  it("registers under domain cortex with five render modes", () => {
    const registry = bootstrapEngineAtomRegistry();
    const reg = resolveOrThrow(registry, "deliverable-letter-render");
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

  it("defaults accessPolicy to tenant-private + declares the produced event", () => {
    const registry = bootstrapEngineAtomRegistry();
    const reg = resolveOrThrow(registry, "deliverable-letter-render");
    expect(reg.accessPolicy).toBe("tenant-private");
    expect(reg.eventTypes).toEqual(["deliverable-letter-render.produced"]);
    expect(reg.composition).toEqual([]);
  });
});

describe("deliverable-letter-render — contextSummary round-trip", () => {
  it("resolves a render to a four-layer summary", async () => {
    const inst = makeRender();
    const registry = bootstrapEngineAtomRegistry({
      lookup: lookupWith(inst),
    });
    const reg = resolveOrThrow(registry, "deliverable-letter-render");
    const summary = await reg.contextSummary(inst.entityId, { audience: "ai" });
    expect(summary.prose).toContain("PDF");
    expect(summary.prose).toContain(inst.sourceLetterRef);
    expect(summary.typed.format).toBe("pdf");
    expect(summary.typed.sourceLetterVersion).toBe("letterhash-v1");
    expect(summary.keyMetrics.some((m) => m.value === "pdf")).toBe(true);
    expect(summary.historyProvenance.latestEventAt).toBe(inst.renderedAt);
  });

  it("user-audience prose is compact (scopeFiltered)", async () => {
    const inst = makeRender();
    const registry = bootstrapEngineAtomRegistry({
      lookup: lookupWith(inst),
    });
    const reg = resolveOrThrow(registry, "deliverable-letter-render");
    const summary = await reg.contextSummary(inst.entityId, {
      audience: "user",
    });
    expect(summary.scopeFiltered).toBe(true);
  });

  it("returns a not-found summary for an unknown entityId", async () => {
    const inst = makeRender();
    const registry = bootstrapEngineAtomRegistry({
      lookup: lookupWith(inst),
    });
    const reg = resolveOrThrow(registry, "deliverable-letter-render");
    const summary = await reg.contextSummary("engagement-42/render-999", {
      audience: "ai",
    });
    expect(summary.prose).toContain("not found");
  });
});
